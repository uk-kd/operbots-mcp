/**
 * Диалоги: переписка ботов с людьми, перехват оператором и отложенные действия.
 */

import { z } from 'zod';

import type { Context } from '../context.js';
import type { Page } from '../api.js';
import { DIALOG_MODES } from '../enums.js';
import { ApiError } from '../errors.js';
import { pageFooter, report } from '../format.js';
import { caseField, body, limitField, optional, tool, type Tool } from './kit.js';

interface Dialog {
  id: string;
  bot_id: string;
  bot_name: string;
  chat_id: number;
  chat_type: string;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ищет диалог по идентификатору, номеру чата, имени собеседника или @username. */
async function findDialog(ctx: Context, caseId: string, hint: string): Promise<Dialog> {
  const wanted = hint.trim();
  if (UUID.test(wanted)) return ctx.api.get<Dialog>(`/cases/${caseId}/dialogs/${wanted}`);

  const page = await ctx.api.get<Page<Dialog>>(`/cases/${caseId}/dialogs`, {
    query: wanted.replace(/^@/, ''),
    limit: 50,
  });

  const needle = wanted.replace(/^@/, '').toLowerCase();
  const candidates = page.items;
  const exact =
    candidates.filter((item) => item.contact_name.toLowerCase() === needle) ??
    [];
  const byHandle = candidates.filter((item) => item.username?.toLowerCase() === needle);
  const byChat = candidates.filter((item) => String(item.chat_id) === wanted);

  const narrowed =
    byChat.length > 0 ? byChat : byHandle.length > 0 ? byHandle : exact.length > 0 ? exact : candidates;

  if (narrowed.length === 1 && narrowed[0]) return narrowed[0];
  if (narrowed.length === 0) {
    throw new ApiError(404, 'dialog_not_found', `Диалога «${hint}» не нашлось.`);
  }

  throw new ApiError(
    400,
    'ambiguous',
    `Под «${hint}» подходит несколько диалогов:\n` +
      narrowed
        .slice(0, 10)
        .map((item) => `  ${item.contact_name} (${item.bot_name}) — ${item.id}`)
        .join('\n') +
      '\nУточните запрос или передайте идентификатор.',
  );
}

const showDialog = (dialog: Dialog) => ({
  собеседник: dialog.contact_name,
  идентификатор: dialog.id,
  бот: dialog.bot_name,
  ник: dialog.username ? `@${dialog.username}` : undefined,
  чат: `${dialog.chat_id} (${dialog.chat_type})`,
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

export const dialogTools: Tool[] = [
  tool({
    name: 'dialogs_list',
    title: 'Список диалогов',
    kind: 'read',
    description:
      'Переписки ботов дела с отбором по боту, режиму и подстроке. Показывает, где есть ' +
      'непрочитанное и какие диалоги ведёт оператор.',
    input: {
      case: caseField,
      bot: z.string().optional().describe('Отобрать по боту: название, @username или идентификатор.'),
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

      return report(`Диалог с «${dialog.contact_name}»`, {
        ...showDialog(dialog),
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

      const lines = messages.map((message) =>
        [
          `[${message.created_at}] ${who(message)}: ${message.text ?? '(без текста)'}`,
          message.node_id ? `    узел: ${message.node_id}` : null,
          message.error ? `    ошибка доставки: ${message.error}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );

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
    name: 'dialogs_reply',
    title: 'Ответить собеседнику',
    kind: 'write',
    description:
      'Отправляет сообщение человеку от имени бота. По умолчанию диалог переходит в ручной ' +
      'режим и закрепляется за вами — сценарий перестаёт вести разговор, пока его не вернут ' +
      '(dialogs_update mode=bot). Бот должен быть запущен. Проверяйте поле «ошибка доставки» ' +
      'в ответе: сообщение сохраняется даже тогда, когда Telegram его не принял.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
      text: z.string().min(1).max(4096).describe('Текст сообщения.'),
      take_over: z
        .boolean()
        .optional()
        .describe('Перевести диалог в ручной режим. По умолчанию да.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);

      const message = await ctx.api.post<Message>(
        `/cases/${found.id}/dialogs/${dialog.id}/messages`,
        body({ text: args.text, take_over: args.take_over }),
      );

      if (message.error) {
        return report(`Telegram не принял сообщение для «${dialog.contact_name}».`, {
          ошибка: message.error,
          сообщение_сохранено: message.id,
          подсказка: 'Проверьте, запущен ли бот и не заблокировал ли собеседник переписку.',
        });
      }

      return `Отправлено «${dialog.contact_name}» от имени бота ${dialog.bot_name}.`;
    },
  }),

  tool({
    name: 'dialogs_update',
    title: 'Настроить диалог',
    kind: 'write',
    description:
      'Меняет режим ведения (сценарий или оператор), отвечает ли ИИ, метки, закрепление ' +
      'и блокировку. Перевод в режим bot возвращает разговор сценарию и снимает оператора.',
    input: {
      case: caseField,
      dialog: z.string().describe('Диалог: имя собеседника, @username, номер чата или идентификатор.'),
      mode: z
        .enum(DIALOG_MODES)
        .optional()
        .describe('bot — вернуть сценарию; operator — вести вручную.'),
      ai_enabled: z.boolean().optional().describe('Отвечает ли ИИ в этом диалоге.'),
      pinned: z.boolean().optional().describe('Закрепить наверху списка.'),
      blocked: z.boolean().optional().describe('Заблокировать собеседника.'),
      tags: z.array(z.string()).optional().describe('Метки. Заменяют прежние целиком.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const dialog = await findDialog(ctx, found.id, args.dialog);

      const payload = body({
        mode: args.mode,
        is_ai_enabled: args.ai_enabled,
        is_pinned: args.pinned,
        is_blocked: args.blocked,
        tags: args.tags,
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
      'Чтобы просто перестать получать сообщения, используйте dialogs_update blocked=true.',
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
      'Показывает и выполненные, и отменённые — отбирайте по статусу.',
    input: {
      case: caseField,
      status: z
        .enum(['pending', 'running', 'done', 'failed', 'cancelled'])
        .optional()
        .describe('Оставить только задачи в этом состоянии.'),
      limit: limitField(300, 100),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const list = await ctx.api.get<Task[]>(`/cases/${found.id}/tasks`, { limit: args.limit });
      const filtered = args.status ? list.filter((item) => item.status === args.status) : list;

      return report(
        `Отложенных действий: ${filtered.length}` + (args.status ? ` в состоянии «${args.status}»` : ''),
        filtered.map((item) => ({
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
];
