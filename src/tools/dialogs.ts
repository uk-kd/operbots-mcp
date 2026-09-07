/**
 * Диалоги: переписка ботов с людьми, перехват оператором, отложенные
 * действия, заготовки ответов и рассылки.
 *
 * Рассылка живёт здесь же, а не отдельно: это то же сообщение от имени
 * бота, только сразу многим, и отбор получателей у неё тот же, что у
 * списка разговоров.
 */

import { z } from 'zod';

import type { Context } from '../context.js';
import type { Page } from '../api.js';
import { DIALOG_KINDS, DIALOG_MODES } from '../enums.js';
import { ApiError } from '../errors.js';
import { pageFooter, report } from '../format.js';
import { findMember } from './people.js';
import { caseField, botField, body, limitField, optional, tool, type Tool } from './kit.js';

interface Dialog {
  id: string;
  bot_id: string;
  bot_name: string;
  chat_id: number;
  chat_type: string;
  /** Положение бота в сообществе: administrator, member, left; у личной переписки пусто. */
  member_status: string | null;
  /** Сценарий, назначенный этому сообществу поверх базового у бота. */
  flow_id: string | null;
  username: string | null;
  contact_name: string;
  mode: string;
  operator: { display_name: string; email: string } | null;
  is_ai_enabled: boolean;
  is_blocked: boolean;
  is_pinned: boolean;
  tags: string[];
  variables: Record<string, unknown>;
  unread_count: number;
  message_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
}

interface Message {
  id: string;
  direction: string;
  author: string;
  operator: { display_name: string } | null;
  text: string | null;
  node_id: string | null;
  error: string | null;
  created_at: string;
  /** Что ещё знает панель о сообщении: цитата, правки, удаление, вложения. */
  payload?: {
    reply?: { text?: string } | null;
    edited?: boolean;
    deleted?: boolean;
    attachments?: { kind?: string; file_name?: string }[];
    [key: string]: unknown;
  };
}

interface Journey {
  flow_name: string;
  stage: { node_id: string; title: string; kind: string } | null;
  awaiting: string | null;
  /** Куда разговор пойдёт, если ответить прямо сейчас. */
  next_steps: { node_id: string; title: string; kind: string }[];
  trail: { node_id: string; title: string; kind: string }[];
  scheduled: {
    id: string;
    node_id: string;
    title: string;
    run_at: string;
    cancel_on_reply: boolean;
    seconds_left: number;
  }[];
  variables: Record<string, unknown>;
}

interface Task {
  id: string;
  dialog_id: string;
  dialog_name: string;
  node_id: string | null;
  run_at: string;
  status: string;
  cancel_on_reply: boolean;
  attempts: number;
  error: string | null;
}

/** Заготовленный ответ оператора. */
interface Reply {
  id: string;
  title: string;
  text: string;
  uses: number;
  last_used_at: string | null;
  author: { display_name: string } | null;
  created_at: string;
}

interface Broadcast {
  id: string;
  bot_id: string;
  bot_name: string;
  title: string;
  text: string;
  parse_mode: string;
  buttons: { text: string; url: string }[][];
  attachment: { kind: string; file_name: string; file_size: number } | null;
  /** Условия отбора получателей — снимком, каким их сохранили. */
  audience: Record<string, unknown>;
  /** Те же условия словами: «метки: клиент, кроме: отписался». */
  audience_text: string;
  status: string;
  run_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  error: string | null;
  created_at: string;
}

interface BroadcastPreview {
  total: number;
  /** Сколько из подошедших закрыли боту рот: им сообщение не уйдёт. */
  blocked: number;
  excluded: number;
  recipients: { id: string; name: string; username: string | null; blocked: boolean }[];
  warnings: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_ID = /^-?\d+$/;

/** Сколько диалогов перебрать в поисках номера чата, прежде чем сдаться. */
const CHAT_SCAN = 1000;

/**
 * Диалог по номеру чата.
 *
 * Панель по chat_id не ищет вовсе: её запрос смотрит в имя, ник,
 * заголовок, текст сообщений и метки. Номер чата человек берёт из
 * карточки диалога, поэтому страницы перебираем сами — иначе поиск по
 * номеру, обещанный в описаниях, приводил бы к первому встречному.
 */
async function findByChatId(ctx: Context, caseId: string, chatId: string): Promise<Dialog | null> {
  const step = 200;
  for (let offset = 0; offset < CHAT_SCAN; offset += step) {
    const page = await ctx.api.get<Page<Dialog>>(`/cases/${caseId}/dialogs`, {
      limit: step,
      offset,
    });
    const hit = page.items.find((item) => String(item.chat_id) === chatId);
    if (hit) return hit;
    if (page.items.length === 0 || offset + page.items.length >= page.total) break;
  }
  return null;
}

/** Ищет диалог по идентификатору, номеру чата, имени собеседника или @username. */
async function findDialog(ctx: Context, caseId: string, hint: string): Promise<Dialog> {
  const wanted = hint.trim();
  if (UUID.test(wanted)) return ctx.api.get<Dialog>(`/cases/${caseId}/dialogs/${wanted}`);

  if (CHAT_ID.test(wanted)) {
    const byChat = await findByChatId(ctx, caseId, wanted);
    if (byChat) return byChat;
  }

  const needle = wanted.replace(/^@/, '').toLowerCase();
  const parts = needle.split(/\s+/).filter(Boolean);

  // Панель ищет подстроку по каждому столбцу ПОРОЗНЬ: имя, фамилия,
  // ник, заголовок, последняя реплика. Столбца «Имя Фамилия» у неё нет
  // — это вычисляемое поле. Поэтому составное имя целиком не находится
  // никогда, и спрашивать надо одной частью, а сверять — всеми: за
  // самой длинной частью выдача уже, а лишнее отсеется здесь.
  const самая_длинная = parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0] ?? needle);
  const page = await ctx.api.get<Page<Dialog>>(`/cases/${caseId}/dialogs`, {
    query: parts.length > 1 ? самая_длинная : needle,
    limit: 50,
  });

  const candidates = page.items;
  const byHandle = candidates.filter((item) => item.username?.toLowerCase() === needle);
  const byName = candidates.filter((item) => {
    const name = item.contact_name.trim().toLowerCase();
    if (name === needle) return true;
    const слова = name.split(/\s+/);
    return parts.length > 1
      ? parts.every((part) => слова.includes(part))
      : слова.includes(needle);
  });

  const narrowed = byHandle.length > 0 ? byHandle : byName;
  if (narrowed.length === 1 && narrowed[0]) return narrowed[0];
  if (candidates.length === 0) {
    throw new ApiError(404, 'dialog_not_found', `Диалога «${hint}» не нашлось.`);
  }

  // Ни один точный отбор не дал ровно одну запись. Брать здесь первую
  // строку текстового поиска нельзя: dialogs_reply отправлял бы
  // сообщение постороннему человеку.
  const shown = narrowed.length > 0 ? narrowed : candidates;
  throw new ApiError(
    400,
    'ambiguous',
    (narrowed.length > 0
      ? `Под «${hint}» подходит несколько диалогов:\n`
      : `Точного совпадения с «${hint}» нет, похожи эти диалоги:\n`) +
      shown
        .slice(0, 10)
        .map(
          (item) =>
            `  ${item.contact_name}${item.username ? ` @${item.username}` : ''} ` +
            `(${item.bot_name}, чат ${item.chat_id}) — ${item.id}`,
        )
        .join('\n') +
      '\nВыберите нужный и передайте его идентификатор, номер чата или @username.',
  );
}

/** Вид чата словами: личный, группа, канал. */
function chatKindWord(chatType: string): string {
  if (chatType === 'private') return 'личный';
  if (chatType === 'channel') return 'канал';
  if (chatType === 'group' || chatType === 'supergroup') return 'группа';
  return chatType;
}

interface ChatInfo {
  available: boolean;
  reason: string | null;
  kind: string | null;
  title: string | null;
  description: string | null;
  username: string | null;
  link: string | null;
  members: number | null;
  bot_status: string | null;
}

const showDialog = (dialog: Dialog) => ({
  собеседник: dialog.contact_name,
  идентификатор: dialog.id,
  бот: dialog.bot_name,
  ник: dialog.username ? `@${dialog.username}` : undefined,
  чат: `${dialog.chat_id} (${chatKindWord(dialog.chat_type)})`,
  бот_в_чате: dialog.member_status ?? undefined,
  свой_сценарий: dialog.flow_id ?? undefined,
  режим: dialog.mode === 'operator' ? `ведёт оператор ${dialog.operator?.display_name ?? ''}` : 'по сценарию',
  ии_отвечает: dialog.is_ai_enabled,
  заблокирован: dialog.is_blocked || undefined,
  закреплён: dialog.is_pinned || undefined,
  метки: dialog.tags.length > 0 ? dialog.tags : undefined,
  сообщений: dialog.message_count,
  непрочитано: dialog.unread_count || undefined,
  последнее: dialog.last_message_at,
  превью: dialog.last_message_preview,
});

// ── Заготовки ответов ────────────────────────────────────────

/** Ищет заготовку по идентификатору, названию или началу текста. */
async function findReply(ctx: Context, caseId: string, hint: string): Promise<Reply> {
  const list = await ctx.api.get<Reply[]>(`/cases/${caseId}/replies`);
  const needle = hint.trim().toLowerCase();

  const match =
    list.find((item) => item.id === hint) ??
    list.find((item) => item.title.toLowerCase() === needle) ??
    list.find((item) => item.title.toLowerCase().includes(needle)) ??
    list.find((item) => item.text.toLowerCase().startsWith(needle));

  if (!match) {
    throw new ApiError(
      404,
      'reply_not_found',
      `Заготовки «${hint}» в деле нет. Есть: ${list.map((item) => item.title).join('; ') || 'ни одной'}`,
    );
  }
  return match;
}

const showReply = (reply: Reply) => ({
  заготовка: reply.title,
  идентификатор: reply.id,
  текст: reply.text,
  вставляли_раз: reply.uses || undefined,
  последний_раз: reply.last_used_at,
  автор: reply.author?.display_name,
});

// ── Рассылки ─────────────────────────────────────────────────

/**
 * Ищет рассылку по идентификатору или названию.
 *
 * Неоднозначность здесь — ошибка, а не повод взять первую: запуском
 * рассылки распоряжаются один раз, и отправленное не возвращают.
 */
async function findBroadcast(ctx: Context, caseId: string, hint: string): Promise<Broadcast> {
  const wanted = hint.trim();
  if (UUID.test(wanted)) return ctx.api.get<Broadcast>(`/cases/${caseId}/broadcasts/${wanted}`);

  const page = await ctx.api.get<Page<Broadcast>>(`/cases/${caseId}/broadcasts`, { limit: 100 });
  const needle = wanted.toLowerCase();
  const exact = page.items.filter((item) => item.title.toLowerCase() === needle);
  const found =
    exact.length > 0
      ? exact
      : page.items.filter((item) => item.title.toLowerCase().includes(needle));

  if (found.length === 1 && found[0]) return found[0];
  if (found.length === 0) {
    throw new ApiError(
      404,
      'broadcast_not_found',
      `Рассылки «${hint}» в деле нет. Есть: ` +
        `${page.items.map((item) => `${item.title} (${item.status})`).join('; ') || 'ни одной'}` +
        // Дальше сотни не смотрим: обещать «такой нет», перебрав часть,
        // нельзя — скажем, сколько именно перебрали.
        (page.total > page.items.length
          ? `. Искал среди ${page.items.length} последних из ${page.total} — старую ищите по идентификатору`
          : ''),
    );
  }

  throw new ApiError(
    400,
    'ambiguous',
    `Под «${hint}» подходит несколько рассылок:\n` +
      found
        .slice(0, 10)
        .map((item) => `  ${item.title} — ${item.status}, создана ${item.created_at}: ${item.id}`)
        .join('\n') +
      '\nВыберите нужную и передайте её идентификатор.',
  );
}

/**
 * Условия отбора получателей — те же, что в списке разговоров.
 *
 * Ни одного условия означает «все собеседники бота», и панель понимает
 * это именно так. Поэтому предпросмотр обязателен: пустой отбор ничем
 * не отличается с виду от забытого.
 */
const audienceInput = {
  mode: z
    .enum(DIALOG_MODES)
    .optional()
    .describe('bot — разговор ведёт сценарий; operator — ведёт человек.'),
  tags: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Метки: подходит любая из перечисленных, а не все сразу.'),
  exclude_tags: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Метки, которые исключают из отбора: «всем клиентам, кроме отписавшихся».'),
  assigned_to: z
    .string()
    .optional()
    .describe('Только разговоры, назначенные этому участнику: почта, имя или идентификатор.'),
  quiet_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Молчат дольше стольких дней.'),
  language: z
    .string()
    .max(12)
    .optional()
    .describe('Язык собеседника, как его сообщает платформа: ru, en. Сообщает не всякая.'),
  // Условия «пришли не раньше такого-то дня» (joined_after) здесь нет
  // намеренно: панель его объявляет, но на любом значении отвечает
  // внутренней ошибкой — сравнение даты с текстом не проходит в самой
  // базе (repositories/broadcast.py, audience_filter). Вернуть, когда
  // панель починят: поле уже описано в её схеме Audience.
  skip_broadcast: z
    .string()
    .optional()
    .describe(
      'Не слать тем, кто уже получил другую рассылку: её название или идентификатор. ' +
        'Так повтор не приходит дважды.',
    ),
};

interface AudienceArgs {
  mode?: string;
  tags?: string[];
  exclude_tags?: string[];
  assigned_to?: string;
  quiet_days?: number;
  language?: string;
  skip_broadcast?: string;
}

/** Переводит названия в то, что панель ждёт в поле audience. */
async function buildAudience(
  ctx: Context,
  caseId: string,
  args: AudienceArgs,
): Promise<Record<string, unknown>> {
  const assigned = args.assigned_to ? await findMember(ctx, caseId, args.assigned_to) : null;
  const skip = args.skip_broadcast ? await findBroadcast(ctx, caseId, args.skip_broadcast) : null;

  return body({
    mode: args.mode,
    tags: args.tags,
    exclude_tags: args.exclude_tags,
    // Панель отбирает по человеку, за которым закреплён разговор, а не
    // по записи об участии в деле.
    assigned_to: assigned?.user.id,
    quiet_days: args.quiet_days,
    language: args.language,
    skip_broadcast_id: skip?.id,
  });
}

const showBroadcast = (item: Broadcast) => ({
  рассылка: item.title,
  идентификатор: item.id,
  бот: item.bot_name,
  состояние: item.status,
  кому: item.audience_text,
  текст: item.text,
  разметка: item.parse_mode || undefined,
  кнопки: item.buttons?.flat().map((кнопка) => `${кнопка.text} → ${кнопка.url}`),
  вложение: item.attachment
    ? `${item.attachment.kind}: ${item.attachment.file_name}`
    : undefined,
  получателей: item.total || undefined,
  ушло: item.sent || undefined,
  не_дошло: item.failed || undefined,
  пропущено: item.skipped || undefined,
  срок: item.run_at,
  начата: item.started_at,
  закончена: item.finished_at,
  ошибка: item.error,
  создана: item.created_at,
});

export const dialogTools: Tool[] = [
  tool({
    name: 'dialogs_list',
    title: 'Список диалогов',
    kind: 'read',
    description:
      'Переписки ботов дела с отбором по боту, виду чата, режиму и подстроке. Показывает, где ' +
      'есть непрочитанное и какие диалоги ведёт оператор. Сообщества — группы и каналы, где ' +
      'состоит бот, — это те же диалоги с kind=community; в панели они в разделе «Сообщества».',
    input: {
      case: caseField,
      bot: z.string().optional().describe('Отобрать по боту: название, @username или идентификатор.'),
      kind: z
        .enum(DIALOG_KINDS)
        .optional()
        .describe(
          'Вид чата: private — личная переписка, community — все сообщества, group — только ' +
            'группы, channel — только каналы. Без него — всё вместе.',
        ),
      mode: z
        .enum(DIALOG_MODES)
        .optional()
        .describe('bot — ведёт сценарий; operator — перехвачен человеком.'),
      query: z.string().optional().describe('Поиск по имени, нику и последнему сообщению.'),
      only_unread: z.boolean().optional().describe('Только с непрочитанными сообщениями.'),
      limit: limitField(200, 40),
      offset: z.number().int().min(0).optional().describe('Сколько записей пропустить.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = args.bot ? await ctx.resolveBot(found.id, args.bot) : null;

      const page = await ctx.api.get<Page<Dialog>>(`/cases/${found.id}/dialogs`, {
        bot_id: bot?.id,
        kind: args.kind,
        mode: args.mode,
        query: args.query,
        only_unread: args.only_unread,
        limit: args.limit,
        offset: args.offset,
      });

      const unread = await optional(
        ctx.api.get<{ data: { unread: number } }>(`/cases/${found.id}/dialogs/unread`),
      );

      return report(
        `Диалогов: ${page.total}` +
          (typeof unread === 'string' ? '' : `, непрочитанных сообщений в деле: ${unread.data.unread}`),
        {
          диалоги: page.items.map(showDialog),
          страница: pageFooter(page),
        },
      );
    },
  }),

  tool({
    name: 'dialogs_get',
    title: 'Карточка диалога',
    kind: 'read',
    description:
      'Диалог и его положение в сценарии: на каком шаге стоит разговор, какого ответа ждёт, ' +
      'какой путь уже пройден, что запланировано и какие переменные накоплены.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);
      const journey = await optional(
        ctx.api.get<Journey>(`/cases/${found.id}/dialogs/${dialog.id}/journey`),
      );
      // Сообщество глазами платформы: люди, ссылка, роль бота. Личной
      // переписке спрашивать нечего.
      const chat =
        dialog.chat_type === 'private'
          ? null
          : await optional(ctx.api.get<ChatInfo>(`/cases/${found.id}/dialogs/${dialog.id}/chat`));

      return report(`Диалог с «${dialog.contact_name}»`, {
        ...showDialog(dialog),
        о_сообществе:
          chat === null
            ? undefined
            : typeof chat === 'string'
              ? chat
              : chat.available
                ? {
                    название: chat.title,
                    описание: chat.description,
                    ссылка: chat.link,
                    участников: chat.members,
                    бот_в_чате: chat.bot_status,
                  }
                : chat.reason,
        переменные: Object.keys(dialog.variables ?? {}).length > 0 ? dialog.variables : undefined,
        по_сценарию:
          typeof journey === 'string'
            ? journey
            : {
                сценарий: journey.flow_name || 'у бота нет активного сценария',
                стоит_на: journey.stage
                  ? `${journey.stage.title || journey.stage.node_id} (${journey.stage.kind})`
                  : 'нигде не ждёт',
                ждёт_ответа_в: journey.awaiting,
                // Что будет дальше, важнее пройденного: по нему решают,
                // вмешиваться или дать боту доработать.
                дальше_по_сценарию:
                  journey.next_steps?.length > 0
                    ? journey.next_steps.map(
                        (step) => `${step.title || step.node_id} (${step.kind})`,
                      )
                    : undefined,
                пройдено: journey.trail.map(
                  (step) => `${step.title || step.node_id} (${step.kind})`,
                ),
                запланировано: journey.scheduled.map(
                  (step) =>
                    `${step.title || step.node_id} — через ${Math.max(0, Math.round(step.seconds_left / 60))} мин ` +
                    `(${step.run_at})` +
                    (step.cancel_on_reply ? ', отменится при ответе' : ''),
                ),
              },
      });
    },
  }),

  tool({
    name: 'dialogs_history',
    title: 'История переписки',
    kind: 'read',
    description:
      'Сообщения диалога от старых к новым. По умолчанию ничего не помечает прочитанным — ' +
      'счётчики в панели остаются как были. Чтобы уйти вглубь истории, передайте before ' +
      'со временем самого раннего сообщения из предыдущего ответа.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
      limit: limitField(300, 80),
      before: z.string().optional().describe('Показать сообщения раньше этого момента (ISO 8601).'),
      mark_read: z
        .boolean()
        .optional()
        .describe('Пометить входящие прочитанными и обнулить счётчик. По умолчанию нет.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);

      const messages = await ctx.api.get<Message[]>(
        `/cases/${found.id}/dialogs/${dialog.id}/messages`,
        { limit: args.limit, before: args.before, mark_read: args.mark_read ?? false },
      );

      const who = (message: Message) => {
        if (message.author === 'contact') return dialog.contact_name;
        if (message.author === 'operator') return `оператор ${message.operator?.display_name ?? ''}`.trim();
        if (message.author === 'ai') return 'ИИ';
        if (message.author === 'bot') return 'бот';
        return 'система';
      };

      // Номер сообщения — чтобы на него можно было ответить цитатой,
      // поправить или удалить: dialogs_reply reply_to,
      // dialogs_edit_message и dialogs_delete_message ждут именно его.
      const lines = messages.map((message) => {
        const extra = message.payload ?? {};
        const marks = [
          extra.deleted ? 'удалено у собеседника' : null,
          extra.edited ? 'изменено' : null,
        ].filter(Boolean);
        const files = (extra.attachments ?? [])
          .map((file) => file.file_name || file.kind)
          .filter(Boolean);
        return [
          `[${message.created_at}] ${who(message)}: ${message.text ?? '(без текста)'}` +
            (marks.length > 0 ? ` (${marks.join(', ')})` : ''),
          `    id: ${message.id}`,
          extra.reply?.text ? `    в ответ на: ${extra.reply.text}` : null,
          files.length > 0 ? `    вложения: ${files.join(', ')}` : null,
          message.node_id ? `    узел: ${message.node_id}` : null,
          message.error ? `    ошибка доставки: ${message.error}` : null,
        ]
          .filter(Boolean)
          .join('\n');
      });

      const earliest = messages[0]?.created_at;
      const tail =
        messages.length === (args.limit ?? 80) && earliest
          ? `\n\nЕсть более ранние сообщения. Продолжить: before=${earliest}`
          : '';

      return (
        `Диалог с «${dialog.contact_name}» (бот ${dialog.bot_name}), сообщений показано ${messages.length} ` +
        `из ${dialog.message_count}\n\n${lines.join('\n') || 'переписка пуста'}${tail}`
      );
    },
  }),

  tool({
    name: 'dialogs_export',
    title: 'Выгрузить переписку',
    kind: 'read',
    description:
      'Переписка одним готовым текстом: шапка с собеседником, ботом и метками, дальше ' +
      'сообщения по порядку — ровно то, что панель отдаёт файлом. Годится приложить к ' +
      'разбору спора или передать тому, у кого доступа к панели нет. Прочитанной переписка ' +
      'от этого не становится, но сама выгрузка отмечается в журнале дела. Разбирать ' +
      'сообщения по одному и уходить вглубь истории удобнее через dialogs_history.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);
      // Панель отдаёт выгрузку файлом, а не JSON: берём тело как есть,
      // оно уже с шапкой и само говорит, всё ли поместилось.
      return ctx.api.text(`/cases/${found.id}/dialogs/${dialog.id}/export`);
    },
  }),

  tool({
    name: 'dialogs_reply',
    title: 'Ответить собеседнику',
    kind: 'write',
    description:
      'Отправляет сообщение человеку от имени бота — своим текстом или заготовкой из ' +
      'replies_list, при желании цитатой на конкретное сообщение (reply_to). ' +
      'По умолчанию диалог переходит в ручной ' +
      'режим и закрепляется за вами — сценарий перестаёт вести разговор, пока его не вернут ' +
      '(dialogs_update mode=bot). Бот должен быть запущен. Проверяйте поле «ошибка доставки» ' +
      'в ответе: сообщение сохраняется даже тогда, когда платформа его не приняла.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
      text: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Текст сообщения. 4096 — грубая верхняя граница на хранение, а не предел ' +
            'платформы: у Telegram он 4096, у MAX 3999, и с вложением у обеих свой предел ' +
            'подписи. Точные числа — operbots_catalog what=platforms; сверх своего предела ' +
            'панель откажет с указанием платформы.',
        ),
      reply: z
        .string()
        .optional()
        .describe(
          'Отправить заготовленный ответ: его название или идентификатор из replies_list. ' +
            'Вместо text, а не вместе с ним.',
        ),
      take_over: z
        .boolean()
        .optional()
        .describe('Перевести диалог в ручной режим. По умолчанию да.'),
      reply_to: z
        .string()
        .optional()
        .describe(
          'Ответить цитатой: id сообщения из dialogs_history. Служебные записи и уже ' +
            'удалённые сообщения цитировать нельзя — у собеседника их нет.',
        ),
    },
    async run(args, ctx) {
      if (args.text && args.reply) {
        return 'Передайте что-то одно: свой text или заготовку reply.';
      }
      const found = await ctx.resolveCase(args.case);
      const template = args.reply ? await findReply(ctx, found.id, args.reply) : null;
      const text = args.text ?? template?.text;
      if (!text) return 'Нечего отправлять: передайте text или reply.';

      const dialog = await findDialog(ctx, found.id, args.dialog);
      const message = await ctx.api.post<Message>(
        `/cases/${found.id}/dialogs/${dialog.id}/messages`,
        body({ text, take_over: args.take_over, reply_to: args.reply_to }),
      );

      if (message.error) {
        return report(`Платформа не приняла сообщение для «${dialog.contact_name}».`, {
          ошибка: message.error,
          сообщение_сохранено: message.id,
          подсказка: 'Проверьте, запущен ли бот и не заблокировал ли собеседник переписку.',
        });
      }

      // Счётчик держит порядок заготовок в панели: частое остаётся
      // наверху. Сообщение уже ушло, и споткнуться об отметку нельзя.
      if (template) await optional(ctx.api.post(`/cases/${found.id}/replies/${template.id}/use`));

      return (
        `Отправлено «${dialog.contact_name}» от имени бота ${dialog.bot_name}` +
        (template ? ` — заготовка «${template.title}»` : '') +
        (args.reply_to ? ' цитатой' : '') +
        `. id сообщения: ${message.id}`
      );
    },
  }),

  tool({
    name: 'dialogs_edit_message',
    title: 'Изменить отправленное сообщение',
    kind: 'write',
    description:
      'Меняет текст сообщения, которое бот или оператор уже отправили, — и у собеседника, и в ' +
      'переписке панели. Только свои сообщения: чужие и служебные не правятся. Не дошедшее ' +
      'изменить нельзя — только отправить заново; подпись к вложению панель пока не правит. ' +
      'Кнопки остаются прежними. Бот должен быть запущен; слишком старое сообщение платформа ' +
      'может не дать изменить.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
      message: z.string().describe('id сообщения из dialogs_history.'),
      text: z.string().min(1).max(4096).describe('Новый текст целиком.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);
      const message = await ctx.api.patch<Message>(
        `/cases/${found.id}/dialogs/${dialog.id}/messages/${args.message.trim()}`,
        { text: args.text },
      );
      return `Сообщение изменено у «${dialog.contact_name}». Теперь: ${message.text ?? ''}`;
    },
  }),

  tool({
    name: 'dialogs_delete_message',
    title: 'Удалить сообщение у собеседника',
    kind: 'danger',
    description:
      'Убирает своё сообщение из чата собеседника; в переписке панели запись остаётся ' +
      'зачёркнутой — след того, что и когда убрали. Только свои: сообщения собеседника не ' +
      'удаляются. Вернуть нельзя. Слишком старое сообщение платформа удалить не даст.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
      message: z.string().describe('id сообщения из dialogs_history.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);
      const message = await ctx.api.delete<Message>(
        `/cases/${found.id}/dialogs/${dialog.id}/messages/${args.message.trim()}`,
      );
      return (
        `Сообщение удалено у «${dialog.contact_name}»; в переписке осталось зачёркнутым: ` +
        `${(message.text ?? '').slice(0, 120)}`
      );
    },
  }),

  tool({
    name: 'dialogs_update',
    title: 'Настроить диалог',
    kind: 'write',
    description:
      'Меняет режим ведения (сценарий или оператор), отвечает ли ИИ, метки, закрепление и ' +
      'сценарий сообщества. Перевод в режим bot возвращает разговор сценарию и снимает ' +
      'оператора. ' +
      'Заблокировать собеседника отсюда нельзя: блокировку приносит платформа, когда человек ' +
      'сам закрывает боту рот, — панель её только показывает.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
      mode: z
        .enum(DIALOG_MODES)
        .optional()
        .describe('bot — вернуть сценарию; operator — вести вручную.'),
      ai_enabled: z.boolean().optional().describe('Отвечает ли ИИ в этом диалоге.'),
      pinned: z.boolean().optional().describe('Закрепить наверху списка.'),
      tags: z.array(z.string()).optional().describe('Метки. Заменяют прежние целиком.'),
      flow: z
        .string()
        .optional()
        .describe(
          'Только для сообществ: свой сценарий этого чата поверх базового у бота — название ' +
            'или идентификатор сценария вида community у того же бота. Пустая строка — ' +
            'вернуть базовый.',
        ),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);

      let flowId: string | null | undefined;
      if (args.flow !== undefined) {
        if (args.flow === '') {
          flowId = null;
        } else {
          const flows = await ctx.api.get<{ id: string; name: string; scope: string }[]>(
            `/cases/${found.id}/bots/${dialog.bot_id}/flows`,
          );
          const needle = args.flow.trim().toLowerCase();
          const chosen = flows.find(
            (item) => item.id === args.flow || item.name.toLowerCase() === needle,
          );
          if (!chosen) {
            return `У бота «${dialog.bot_name}» нет сценария «${args.flow}». Есть: ${flows
              .filter((item) => item.scope === 'community')
              .map((item) => item.name)
              .join(', ')}`;
          }
          flowId = chosen.id;
        }
      }

      const payload = body({
        mode: args.mode,
        is_ai_enabled: args.ai_enabled,
        is_pinned: args.pinned,
        tags: args.tags,
        flow_id: flowId,
      });
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const updated = await ctx.api.patch<Dialog>(
        `/cases/${found.id}/dialogs/${dialog.id}`,
        payload,
      );
      return report('Диалог обновлён.', showDialog(updated));
    },
  }),

  tool({
    name: 'dialogs_delete',
    title: 'Удалить диалог',
    kind: 'danger',
    description:
      'Удаляет диалог вместе со всей перепиской. Восстановить нельзя. ' +
      'Чтобы бот просто перестал отвечать этому человеку, переведите разговор в ручной режим: ' +
      'dialogs_update mode=operator, ai_enabled=false — переписка при этом останется.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
      confirm_contact: z.string().describe('Имя собеседника дословно — подтверждение удаления.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);
      if (args.confirm_contact.trim() !== dialog.contact_name) {
        return (
          `Не удаляю: подтверждение «${args.confirm_contact}» не совпадает с именем ` +
          `собеседника «${dialog.contact_name}».`
        );
      }

      await ctx.api.delete(`/cases/${found.id}/dialogs/${dialog.id}`);
      return `Диалог с «${dialog.contact_name}» удалён вместе с перепиской (${dialog.message_count} сообщений).`;
    },
  }),

  tool({
    name: 'tasks_list',
    title: 'Отложенные действия',
    kind: 'read',
    description:
      'Что запланировано в деле: «написать через три дня», «напомнить, если не ответил». ' +
      'Показывает и выполненные, и отменённые: выполненные задачи не удаляются, а порядок — ' +
      'по сроку с самых ранних, так что без status ответ занимает давняя история. ' +
      'Что ещё предстоит, спрашивайте с status=pending: отбор делает панель. ' +
      'Больше 300 записей за раз панель не отдаёт, и общего их числа не сообщает.',
    input: {
      case: caseField,
      status: z
        .enum(['pending', 'running', 'done', 'failed', 'cancelled'])
        .optional()
        .describe('Оставить только задачи в этом состоянии. Отбирает панель, в самом запросе.'),
      limit: limitField(300, 100),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const limit = args.limit ?? 100;
      const list = await ctx.api.get<Task[]>(`/cases/${found.id}/tasks`, {
        limit,
        status: args.status,
      });
      // Панель отдаёт первые limit записей по сроку и общего числа не
      // сообщает. Полный кусок — повод сказать, что дальше не видно:
      // иначе «действий: 100» читалось бы как вся очередь. Утверждать
      // «их больше» нельзя — записей могло оказаться ровно limit.
      const clipped = list.length >= limit;
      const потолок = limit >= 300;

      return report(
        `Отложенных действий${args.status ? ` в состоянии «${args.status}»` : ''}: ` +
          `${list.length}` +
          (clipped
            ? `. Это первые ${limit} по сроку, начиная с самых ранних; есть ли за ними ещё — ` +
              'панель не сообщает' +
              (потолок
                ? '. Больше 300 за раз она не отдаёт, поэтому сузьте отбор через status'
                : ', за следующими поднимите limit (потолок 300)')
            : ''),
        list.map((item) => ({
          идентификатор: item.id,
          диалог: item.dialog_name || item.dialog_id,
          узел: item.node_id,
          сработает: item.run_at,
          состояние: item.status,
          отменится_при_ответе: item.cancel_on_reply || undefined,
          попыток: item.attempts || undefined,
          ошибка: item.error,
        })),
      );
    },
  }),

  tool({
    name: 'tasks_cancel',
    title: 'Отменить отложенное действие',
    kind: 'danger',
    description: 'Снимает запланированное действие: бот не отправит то, что собирался.',
    input: {
      case: caseField,
      task_id: z.string().describe('Идентификатор действия из tasks_list.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const result = await ctx.api.delete<{ ok: boolean; message?: string }>(
        `/cases/${found.id}/tasks/${args.task_id}`,
      );
      return result.message ?? (result.ok ? 'Действие отменено.' : 'Действие не найдено.');
    },
  }),

  tool({
    name: 'dialogs_reset_stage',
    title: 'Снять разговор с шага',
    kind: 'write',
    description:
      'Освобождает разговор, застрявший на узле ожидания: сценарий ждёт ответа, которого не ' +
      'будет, и со стороны это выглядит молчащим ботом. После снятия следующее сообщение ' +
      'начнёт сценарий заново. Отложенные продолжения этого разговора снимаются заодно — ' +
      'они назначены от того же шага и сработали бы в пустоту.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);
      await ctx.api.post(`/cases/${found.id}/dialogs/${dialog.id}/reset-stage`);
      return (
        `Разговор с «${dialog.contact_name}» снят с шага. ` +
        'Следующее сообщение начнёт сценарий заново.'
      );
    },
  }),

  // ── Заготовки ответов ──────────────────────────────────────

  tool({
    name: 'replies_list',
    title: 'Заготовки ответов',
    kind: 'read',
    description:
      'Заготовленные ответы оператора: приветствие, реквизиты, «уточню и вернусь». ' +
      'Порядок — по частоте вставки, нужное каждый день сверху. Отправить заготовку ' +
      'в разговор: dialogs_reply reply=«название».',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const list = await ctx.api.get<Reply[]>(`/cases/${found.id}/replies`);

      return report(
        `Заготовок в деле «${found.name}»: ${list.length}`,
        list.map(showReply),
      );
    },
  }),

  tool({
    name: 'replies_save',
    title: 'Сохранить заготовку ответа',
    kind: 'write',
    description:
      'Без параметра reply заводит новую заготовку, с ним — правит существующую. ' +
      'Название нужно, чтобы заготовку было чем позвать; без него панель обойдётся, ' +
      'но в списке она станет безымянной.',
    input: {
      case: caseField,
      reply: z
        .string()
        .optional()
        .describe('Какую заготовку править: название или идентификатор. Не указывайте для новой.'),
      title: z.string().max(80).optional().describe('Название заготовки.'),
      text: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Текст ответа. 4096 — грубая верхняя граница, а не предел платформы: свой предел ' +
            'у каждой, см. operbots_catalog what=platforms.',
        ),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);

      if (!args.reply) {
        if (!args.text) return 'Чтобы завести заготовку, нужен её текст.';
        const created = await ctx.api.post<Reply>(
          `/cases/${found.id}/replies`,
          body({ title: args.title, text: args.text }),
        );
        return report('Заготовка сохранена.', showReply(created));
      }

      const existing = await findReply(ctx, found.id, args.reply);
      const payload = body({ title: args.title, text: args.text });
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const updated = await ctx.api.patch<Reply>(
        `/cases/${found.id}/replies/${existing.id}`,
        payload,
      );
      return report('Заготовка обновлена.', showReply(updated));
    },
  }),

  tool({
    name: 'replies_delete',
    title: 'Удалить заготовку ответа',
    kind: 'danger',
    description:
      'Убирает заготовку из списка. Отправленные по ней сообщения остаются в переписке — ' +
      'исчезает только сама заготовка.',
    input: {
      case: caseField,
      reply: z.string().describe('Заготовка: название или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const existing = await findReply(ctx, found.id, args.reply);
      await ctx.api.delete(`/cases/${found.id}/replies/${existing.id}`);
      return `Заготовка «${existing.title}» удалена.`;
    },
  }),

  // ── Рассылки ───────────────────────────────────────────────

  tool({
    name: 'broadcasts_list',
    title: 'Рассылки дела',
    kind: 'read',
    description:
      'Рассылки дела с условиями отбора, текстом и счётчиками: скольким ушло, скольким не ' +
      'дошло и сколько пропущено — это те, кто закрыл боту рот. Состояния: draft — черновик, ' +
      'его ещё можно править и запускать; scheduled — ждёт своего срока или ближайшего ' +
      'оборота рассыльщика; running — идёт; done — закончена; cancelled — остановлена; ' +
      'failed — не с чего было начать.',
    input: {
      case: caseField,
      limit: limitField(100, 30),
      offset: z.number().int().min(0).optional().describe('Сколько записей пропустить.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const page = await ctx.api.get<Page<Broadcast>>(`/cases/${found.id}/broadcasts`, {
        limit: args.limit,
        offset: args.offset,
      });

      return report(
        `Рассылки дела «${found.name}» — ${pageFooter(page)}`,
        page.items.map(showBroadcast),
      );
    },
  }),

  tool({
    name: 'broadcasts_preview',
    title: 'Кому уйдёт рассылка',
    kind: 'read',
    description:
      'Прикидка до отправки: сколько разговоров подходит под условия, кто именно (первые 50 ' +
      'по свежести), сколько из них закрыли боту рот и что настораживает в самом сообщении — ' +
      'пустой отбор, слишком широкий, неизвестные подстановки. Разосланное не отзывают, ' +
      'поэтому смотреть надо здесь. Ничего не сохраняет: черновик заводит broadcasts_save. ' +
      'Условия — те же, что у списка разговоров; ни одного условия означает всех ' +
      'собеседников бота.',
    input: {
      case: caseField,
      bot: botField,
      text: z
        .string()
        .min(1)
        .max(4096)
        .describe(
          'Текст сообщения. Подстановки: {{имя}}, {{фамилия}}, {{username}}, {{полное_имя}}, ' +
            '{{bot.name}} — незнакомые уйдут получателю как есть.',
        ),
      parse_mode: z
        .enum(['', 'HTML'])
        .optional()
        .describe('HTML — разметка сообщения. Пусто — обычный текст. По умолчанию пусто.'),
      ...audienceInput,
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      const audience = await buildAudience(ctx, found.id, args);

      const preview = await ctx.api.post<BroadcastPreview>(
        `/cases/${found.id}/broadcasts/preview`,
        body({
          bot_id: bot.id,
          text: args.text,
          parse_mode: args.parse_mode,
          audience,
        }),
      );

      return report(`Рассылка бота «${bot.name}»: уйдёт ${preview.total - preview.blocked}`, {
        подходит_разговоров: preview.total,
        закрыли_бота: preview.blocked || undefined,
        отсеяно_прошлой_рассылкой: preview.excluded || undefined,
        внимание: preview.warnings,
        получатели: preview.recipients.map(
          (item) =>
            `${item.name}${item.username ? ` @${item.username}` : ''}` +
            (item.blocked ? ' — закрыл бота, не получит' : ''),
        ),
      });
    },
  }),

  tool({
    name: 'broadcasts_save',
    title: 'Составить или поправить рассылку',
    kind: 'write',
    description:
      'Без параметра broadcast заводит черновик — он никуда не уходит, пока его не запустят ' +
      '(broadcasts_start). С параметром broadcast правит черновик, а также рассылку, ' +
      'поставленную на срок и ещё не ушедшую. Начавшуюся правкой уже не догнать — её ' +
      'останавливают через broadcasts_cancel. Условия отбора при правке заменяются целиком теми, что переданы, ' +
      'а не дополняются; не передали ни одного — прежние остаются. Разметку HTML панель ' +
      'проверяет здесь же: платформа отбила бы сообщение с незакрытым тегом сразу у всех.',
    input: {
      case: caseField,
      broadcast: z
        .string()
        .optional()
        .describe('Какую рассылку править: название или идентификатор. Не указывайте для новой.'),
      bot: z
        .string()
        .optional()
        .describe(
          'Бот, от имени которого уйдёт сообщение: название, @username или идентификатор. ' +
            'Нужен для новой рассылки; у заведённой бота не меняют.',
        ),
      title: z
        .string()
        .max(120)
        .optional()
        .describe('Название для списка. Без него панель возьмёт начало текста.'),
      text: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Текст сообщения. Подстановки: {{имя}}, {{фамилия}}, {{username}}, {{полное_имя}}, ' +
            '{{bot.name}} — незнакомые уйдут получателю как есть.',
        ),
      parse_mode: z
        .enum(['', 'HTML'])
        .optional()
        .describe('HTML — разметка сообщения. Пусто — обычный текст.'),
      buttons: z
        .array(
          z
            .array(
              z.object({
                text: z.string().min(1).max(64).describe('Надпись на кнопке.'),
                url: z
                  .string()
                  .max(512)
                  .describe('Адрес: https://, http://, tg:// или mailto:'),
              }),
            )
            .max(3),
        )
        .max(6)
        .optional()
        .describe(
          'Кнопки под сообщением: ряды не больше чем по три, рядов не больше шести. ' +
            'Только ссылки — на нажатие в рассылке отвечать некому.',
        ),
      run_at: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Когда начать, ISO 8601. Без срока рассылка идёт сразу после запуска. ' +
            'null убирает ранее назначенный срок.',
        ),
      ...audienceInput,
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const audience = await buildAudience(ctx, found.id, args);

      if (!args.broadcast) {
        if (!args.bot || !args.text) {
          return 'Чтобы завести рассылку, нужны бот и текст сообщения.';
        }
        const bot = await ctx.resolveBot(found.id, args.bot);
        const created = await ctx.api.post<Broadcast>(
          `/cases/${found.id}/broadcasts`,
          body({
            bot_id: bot.id,
            title: args.title,
            text: args.text,
            parse_mode: args.parse_mode,
            buttons: args.buttons,
            audience,
            run_at: args.run_at ?? undefined,
            // Панель по умолчанию ставит рассылку в очередь сразу же.
            // Здесь всегда черновик: отправка необратима, и решать её
            // должен отдельный вызов, а не побочный смысл создания.
            start: false,
          }),
        );

        return report('Черновик рассылки сохранён — он ещё никуда не ушёл.', {
          ...showBroadcast(created),
          дальше:
            'Посмотрите отбор: broadcasts_preview. Отправить: broadcasts_start ' +
            `broadcast="${created.title}".`,
        });
      }

      if (args.bot) {
        return 'Бота у заведённой рассылки не меняют — заведите новую без параметра broadcast.';
      }

      const existing = await findBroadcast(ctx, found.id, args.broadcast);
      const payload = body({
        title: args.title,
        text: args.text,
        parse_mode: args.parse_mode,
        buttons: args.buttons,
        // Пустой отбор в правке значил бы «слать всем»: не передали ни
        // одного условия — оставляем прежние.
        audience: Object.keys(audience).length > 0 ? audience : undefined,
        run_at: args.run_at,
      });
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const updated = await ctx.api.patch<Broadcast>(
        `/cases/${found.id}/broadcasts/${existing.id}`,
        payload,
      );
      return report('Рассылка обновлена.', showBroadcast(updated));
    },
  }),

  tool({
    name: 'broadcasts_start',
    title: 'Запустить рассылку',
    kind: 'danger',
    description:
      'Ставит черновик в очередь: рассыльщик разошлёт сообщение всем, кто подошёл под ' +
      'условия. Отправленное не отзывается ни у одного получателя, поэтому сначала ' +
      'broadcasts_preview — пустой отбор означает всех собеседников бота. Со сроком (run_at) ' +
      'рассылка дождётся его. То, что ещё не ушло, останавливают через broadcasts_cancel.',
    input: {
      case: caseField,
      broadcast: z.string().describe('Рассылка: название или идентификатор.'),
      confirm_title: z.string().describe('Точное название рассылки — подтверждение отправки.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const existing = await findBroadcast(ctx, found.id, args.broadcast);
      if (args.confirm_title.trim() !== existing.title) {
        return (
          `Не запускаю: подтверждение «${args.confirm_title}» не совпадает с названием ` +
          `«${existing.title}».`
        );
      }

      const started = await ctx.api.post<Broadcast>(
        `/cases/${found.id}/broadcasts/${existing.id}/start`,
      );
      return report('Рассылка запущена — вернуть отправленное нельзя.', {
        ...showBroadcast(started),
        дальше: 'Ход отправки виден в broadcasts_list; остановить — broadcasts_cancel.',
      });
    },
  }),

  tool({
    name: 'broadcasts_cancel',
    title: 'Остановить рассылку',
    kind: 'write',
    description:
      'Останавливает рассылку: то, что ещё не ушло, не уйдёт. Отправленное вернуть нельзя, ' +
      'и продолжить остановленную тоже — запускают только черновик, так что для повтора ' +
      'придётся составить новую. Счётчики остаются: по ним видно, скольким успело уйти.',
    input: {
      case: caseField,
      broadcast: z.string().describe('Рассылка: название или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const existing = await findBroadcast(ctx, found.id, args.broadcast);
      const stopped = await ctx.api.post<Broadcast>(
        `/cases/${found.id}/broadcasts/${existing.id}/cancel`,
      );
      return report(`Рассылка «${stopped.title}»: ${stopped.status}`, {
        ушло: stopped.sent,
        не_дошло: stopped.failed || undefined,
        пропущено: stopped.skipped || undefined,
        получателей_было: stopped.total || undefined,
      });
    },
  }),
];
