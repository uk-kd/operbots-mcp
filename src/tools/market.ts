/**
 * Маркет сценариев: готовые сценарии проекта и публикации других дел.
 *
 * Сюда переехали заготовки формы создания: «Консультант с ИИ», «Меню
 * вопросов», «Заявка» и остальные теперь ставятся отсюда, а не через
 * flows_save template. Публикация из дела — тем же путём, что и у
 * проекта: карточка, граф актуальной версии, история версий, лайки и
 * счётчик установок. Карточку и граф видят все вошедшие в панель,
 * поэтому перед публикацией стоит проверить, что в узлах нет ключей и
 * адресов, которые не хочется показывать посторонним: ссылки на
 * подключения панель снимает сама, а текст в настройках — нет.
 */

import { z } from 'zod';

import type { Page } from '../api.js';
import type { Context } from '../context.js';
import {
  BOT_PLATFORMS,
  FLOW_SCOPES,
  MARKET_CATEGORIES,
  MARKET_SORTS,
  MARKET_SOURCES,
} from '../enums.js';
import { ApiError } from '../errors.js';
import { pageFooter, raw, report } from '../format.js';
import { findProvider } from './bots.js';
import { locate, showFlow, type Flow } from './flows.js';
import { findBase } from './knowledge.js';
import { caseField, botField, body, limitField, tool, type Tool } from './kit.js';

interface Facts {
  nodes: number;
  edges: number;
  triggers: { kind: string; title: string; command: string | null }[];
  kinds: string[];
  needs: { ai?: number; knowledge?: number };
  platforms: string[];
}

interface Installed {
  flow_id: string;
  bot_id: string;
  bot_name: string;
  version: number | null;
}

interface ItemBrief {
  id: string;
  slug: string;
  source: string;
  title: string;
  summary: string;
  category: string;
  /** dialog — для личной переписки, community — для сообществ. */
  scope: string;
  version: number;
  facts: Facts;
  installs_count: number;
  likes_count: number;
  author_name: string | null;
  origin_case_name: string | null;
  show_origin: boolean;
  origin_case_id: string | null;
  published_at: string;
  updated_at: string;
  liked: boolean;
  installed: Installed[];
}

interface Item extends ItemBrief {
  description: string;
  graph: Record<string, unknown>;
  versions: { version: number; comment: string | null; created_at: string }[];
  origin_flow_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const itemField = z
  .string()
  .describe('Публикация в маркете: название, короткое имя (slug) или идентификатор.');

/** Что нужно сценарию, словами: «узлов с ИИ 2, из них с базой знаний 1». */
function needsNote(facts: Facts): string | undefined {
  const ai = facts.needs?.ai ?? 0;
  const knowledge = facts.needs?.knowledge ?? 0;
  if (ai === 0) return undefined;
  return (
    `узлов с ИИ ${ai}` +
    (knowledge ? `, из них с базой знаний ${knowledge}` : '') +
    '; при установке передайте provider' +
    (knowledge ? ' и knowledge_base' : '')
  );
}

function whose(item: ItemBrief): string {
  if (item.source === 'project') return 'проект operbots';
  const parts = [item.author_name, item.show_origin ? item.origin_case_name : null].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'другое дело';
}

function showBrief(item: ItemBrief) {
  return {
    публикация: item.title,
    идентификатор: item.id,
    короткое_имя: item.slug,
    кратко: item.summary,
    раздел: item.category,
    для: item.scope === 'community' ? 'сообществ' : 'диалогов',
    от_кого: whose(item),
    версия: item.version,
    платформы: item.facts.platforms,
    узлов: item.facts.nodes,
    связей: item.facts.edges,
    точки_входа: item.facts.triggers.map((trigger) =>
      trigger.command ? `/${trigger.command}` : trigger.title,
    ),
    нужно: needsNote(item.facts),
    установок: item.installs_count,
    лайков: item.likes_count,
    мой_лайк: item.liked || undefined,
    стоит_в_этом_деле: item.installed.map(
      (place) =>
        `бот «${place.bot_name}», сценарий ${place.flow_id}` +
        (place.version !== null && place.version < item.version
          ? ` (версия ${place.version}, доступна ${item.version})`
          : ''),
    ),
    опубликована: item.published_at,
    обновлена: item.updated_at,
  };
}

/**
 * Публикация по идентификатору, короткому имени или названию.
 *
 * Каталог ищет подстроку по названию и описанию, поэтому точное
 * совпадение сверяем сами: по одному слову выдача широкая, и первая
 * строка была бы случайной — а от неё зависит, что встанет боту.
 */
export async function findItem(ctx: Context, hint: string, caseId?: string): Promise<Item> {
  const wanted = hint.trim();
  const query = caseId ? { case_id: caseId } : undefined;
  if (UUID.test(wanted)) return ctx.api.get<Item>(`/market/items/${wanted}`, query);

  const needle = wanted.toLowerCase();
  const page = await ctx.api.get<Page<ItemBrief>>('/market/items', {
    query: wanted,
    limit: 50,
  });
  const exact = page.items.filter((item) => item.slug.toLowerCase() === needle);
  const byTitle = page.items.filter((item) => item.title.trim().toLowerCase() === needle);
  const narrowed = exact.length > 0 ? exact : byTitle.length > 0 ? byTitle : page.items;

  if (narrowed.length === 1 && narrowed[0]) {
    return ctx.api.get<Item>(`/market/items/${narrowed[0].id}`, query);
  }
  if (narrowed.length === 0) {
    throw new ApiError(404, 'market_item_not_found', `Публикации «${hint}» в маркете нет.`);
  }
  throw new ApiError(
    409,
    'market_item_ambiguous',
    `Под «${hint}» подходит несколько публикаций: ` +
      narrowed
        .slice(0, 8)
        .map((item) => `«${item.title}» (${item.slug}, ${whose(item)})`)
        .join('; ') +
      '. Уточните короткое имя или идентификатор.',
  );
}

export const marketTools: Tool[] = [
  tool({
    name: 'market_list',
    title: 'Маркет сценариев',
    kind: 'read',
    description:
      'Каталог готовых сценариев: от проекта и опубликованные другими делами. Поиск по ' +
      'названию и описанию, отбор по разделу, платформе, источнику и потребности в ИИ или ' +
      'базе знаний. С параметром case у каждой публикации видно, стоит ли она уже в этом ' +
      'деле и не отстала ли от свежей версии. Установка — market_install.',
    input: {
      case: caseField,
      query: z.string().max(120).optional().describe('Что искать в названии и описании.'),
      category: z.enum(MARKET_CATEGORIES).optional().describe('Раздел маркета.'),
      scope: z
        .enum(FLOW_SCOPES)
        .optional()
        .describe('dialog — сценарии для личной переписки, community — для сообществ.'),
      platform: z
        .enum(BOT_PLATFORMS)
        .optional()
        .describe('Только сценарии, годные для этой платформы.'),
      source: z
        .enum(MARKET_SOURCES)
        .optional()
        .describe('project — от проекта operbots, community — опубликованные делами.'),
      mine: z
        .boolean()
        .optional()
        .describe('Только публикации этого дела — то, что выложили сами.'),
      needs_ai: z.boolean().optional().describe('Есть ли в сценарии узлы с ИИ.'),
      needs_knowledge: z.boolean().optional().describe('Нужна ли сценарию база знаний.'),
      sort: z
        .enum(MARKET_SORTS)
        .optional()
        .describe('popular — по установкам (по умолчанию), new — свежие, likes — по лайкам.'),
      limit: limitField(100, 30),
      offset: z.number().int().min(0).optional().describe('Сколько записей пропустить.'),
    },
    async run(args, ctx) {
      // Дело нужно, только чтобы пометить установленное и отобрать
      // «свои»: каталог общий на всю панель, и без дела он тоже виден —
      // потому человеку без единого дела каталог всё равно показываем.
      const found = await ctx.resolveCase(args.case).catch((error: unknown) => {
        if (args.case || args.mine) throw error;
        return null;
      });
      const page = await ctx.api.get<Page<ItemBrief>>('/market/items', {
        query: args.query,
        category: args.category,
        scope: args.scope,
        platform: args.platform,
        source: args.source,
        needs_ai: args.needs_ai,
        needs_knowledge: args.needs_knowledge,
        origin_case_id: args.mine ? found?.id : undefined,
        case_id: found?.id,
        sort: args.sort,
        limit: args.limit,
        offset: args.offset,
      });

      return report(
        `Публикаций в маркете: ${page.total}. ${pageFooter(page)}`,
        page.items.map((item) => ({
          публикация: item.title,
          короткое_имя: item.slug,
          кратко: item.summary,
          раздел: item.category,
          для: item.scope === 'community' ? 'сообществ' : 'диалогов',
          от_кого: whose(item),
          версия: item.version,
          платформы: item.facts.platforms,
          узлов: item.facts.nodes,
          нужно: needsNote(item.facts),
          установок: item.installs_count,
          лайков: item.likes_count,
          стоит_в_этом_деле: item.installed.map((place) => `бот «${place.bot_name}»`),
        })),
      );
    },
  }),

  tool({
    name: 'market_get',
    title: 'Карточка публикации',
    kind: 'read',
    description:
      'Публикация целиком: описание, состав сценария, история версий и, с параметром case, где ' +
      'в этом деле она уже стоит. С with_graph отдаёт и сам граф — посмотреть узлы до установки.',
    input: {
      case: caseField,
      item: itemField,
      with_graph: z.boolean().optional().describe('Показать граф сценария целиком.'),
    },
    async run(args, ctx) {
      const found = args.case ? await ctx.resolveCase(args.case) : null;
      const item = await findItem(ctx, args.item, found?.id);
      return report(`Публикация «${item.title}»`, {
        ...showBrief(item),
        описание: item.description,
        виды_узлов: item.facts.kinds,
        версии: item.versions.map((version) => ({
          версия: version.version,
          комментарий: version.comment,
          выпущена: version.created_at,
        })),
        граф: args.with_graph ? raw(item.graph) : undefined,
      });
    },
  }),

  tool({
    name: 'market_like',
    title: 'Лайк публикации',
    kind: 'write',
    description: 'Поставить или снять лайк публикации от своего имени.',
    input: {
      item: itemField,
      liked: z.boolean().optional().describe('true — поставить (по умолчанию), false — снять.'),
    },
    async run(args, ctx) {
      const item = await findItem(ctx, args.item);
      const path = `/market/items/${item.id}/like`;
      const result =
        args.liked === false
          ? await ctx.api.delete<{ liked: boolean; likes_count: number }>(path)
          : await ctx.api.put<{ liked: boolean; likes_count: number }>(path);
      return `«${item.title}»: лайк ${result.liked ? 'стоит' : 'снят'}, всего лайков ${result.likes_count}.`;
    },
  }),

  tool({
    name: 'market_install',
    title: 'Установить из маркета',
    kind: 'write',
    description:
      'Ставит публикацию боту новым сценарием — рядом с существующими, ничего не заменяя и не ' +
      'включая в работу (для этого flows_publish). Ссылки на чужие подключения из графа снимаются; ' +
      'узлам «Ответ ИИ» передайте provider и knowledge_base, иначе они отвечают пустотой или ' +
      '«из головы». Чего требует сценарий, видно в market_get, поле «нужно». Повторная ' +
      'установка той же публикации даёт ещё одну копию — так обновляют до свежей версии.',
    input: {
      case: caseField,
      bot: botField,
      item: itemField,
      name: z.string().min(1).max(120).optional().describe('Своё название вместо названия публикации.'),
      provider: z
        .string()
        .optional()
        .describe('Подключение к ИИ для узлов «Ответ ИИ»: название или идентификатор.'),
      knowledge_base: z
        .string()
        .optional()
        .describe('База знаний для узлов «Ответ ИИ»: название или идентификатор.'),
    },
    async run(args, ctx) {
      const { found, bot, root } = await locate(ctx, args.case, args.bot);
      const item = await findItem(ctx, args.item, found.id);
      const provider = args.provider ? await findProvider(ctx, found.id, args.provider) : null;
      const base = args.knowledge_base ? await findBase(ctx, found.id, args.knowledge_base) : null;

      const result = await ctx.api.post<{ flow: Flow; warnings: string[] }>(
        `${root}/market/${item.id}/install`,
        body({
          name: args.name,
          provider_id: provider?.id,
          knowledge_base_id: base?.id,
        }),
      );

      return report(
        `«${item.title}» (версия ${item.version}) установлен боту «${bot.name}» как сценарий ` +
          `«${result.flow.name}». В работу не включён — flows_publish.`,
        {
          ...showFlow(result.flow, false),
          подключение_ии: provider?.name,
          база_знаний: base?.name,
          снятые_ссылки: result.warnings.length > 0 ? result.warnings : undefined,
          нужно: !provider && needsNote(item.facts) ? needsNote(item.facts) : undefined,
        },
      );
    },
  }),

  tool({
    name: 'market_publish',
    title: 'Выложить сценарий в маркет',
    kind: 'write',
    description:
      'Публикует сценарий дела в маркете: карточку и граф текущей редакции увидят все ' +
      'пользователи панели и смогут поставить себе. Ссылки на подключения и базы знаний ' +
      'снимаются, а вот текст в настройках узлов — адреса, подписи, ключи, вписанные руками, — ' +
      'уходит как есть: проверьте граф через flows_get. Название дела на карточке не показывается, ' +
      'пока не разрешить show_origin. Нужно право market.publish. Правки после публикации — ' +
      'market_release (новая версия) и market_update (карточка).',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий: название или идентификатор.'),
      title: z.string().min(2).max(120).describe('Название публикации.'),
      summary: z.string().min(2).max(240).describe('Одна строка о том, что делает сценарий.'),
      description: z.string().max(6000).optional().describe('Подробное описание.'),
      category: z.enum(MARKET_CATEGORIES).optional().describe('Раздел маркета. По умолчанию other.'),
      show_origin: z
        .boolean()
        .optional()
        .describe('Подписать карточку названием дела. По умолчанию нет — оно может быть именем клиента.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const item = await ctx.api.post<Item>(
        `${root}/${flowId}/market`,
        body({
          title: args.title,
          summary: args.summary,
          description: args.description,
          category: args.category,
          show_origin: args.show_origin,
        }),
      );
      return report(`Опубликовано в маркете: «${item.title}», версия ${item.version}.`, showBrief(item));
    },
  }),

  tool({
    name: 'market_release',
    title: 'Выпустить новую версию',
    kind: 'write',
    description:
      'Обновляет граф публикации до текущей редакции сценария и поднимает номер версии. ' +
      'Уже установленные копии у других не меняются — у них появится пометка, что доступна ' +
      'свежая версия. Если граф с прошлой версии не менялся, панель откажет.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий, который выложен в маркет: название или идентификатор.'),
      comment: z.string().min(1).max(240).describe('Что изменилось в этой версии.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const item = await ctx.api.post<Item>(`${root}/${flowId}/market/version`, {
        comment: args.comment,
      });
      return report(`«${item.title}»: выпущена версия ${item.version}.`, showBrief(item));
    },
  }),

  tool({
    name: 'market_update',
    title: 'Править карточку публикации',
    kind: 'write',
    description:
      'Меняет карточку публикации — название, описание, раздел, подпись делом. Граф не трогает: ' +
      'для него market_release.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий, который выложен в маркет: название или идентификатор.'),
      title: z.string().min(2).max(120).optional().describe('Название публикации.'),
      summary: z.string().min(2).max(240).optional().describe('Одна строка о сценарии.'),
      description: z.string().max(6000).optional().describe('Подробное описание.'),
      category: z.enum(MARKET_CATEGORIES).optional().describe('Раздел маркета.'),
      show_origin: z.boolean().optional().describe('Показывать ли название дела на карточке.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const payload = body({
        title: args.title,
        summary: args.summary,
        description: args.description,
        category: args.category,
        show_origin: args.show_origin,
      });
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';
      const item = await ctx.api.patch<Item>(`${root}/${flowId}/market`, payload);
      return report(`Карточка «${item.title}» обновлена.`, showBrief(item));
    },
  }),

  tool({
    name: 'market_unpublish',
    title: 'Снять публикацию',
    kind: 'danger',
    description:
      'Убирает публикацию из маркета вместе с историей версий, лайками и счётчиком установок; ' +
      'вернуть их нельзя — повторная публикация начнётся с версии 1. Уже установленные копии ' +
      'у других дел остаются. Сам сценарий в деле не трогается.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий, который выложен в маркет: название или идентификатор.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const flow = await ctx.api.get<Flow>(`${root}/${flowId}`);
      if (!flow.market || flow.market.role !== 'source') {
        return `Сценарий «${flow.name}» в маркет не выкладывался — снимать нечего.`;
      }
      await ctx.api.delete(`${root}/${flowId}/market`);
      return `Публикация «${flow.market.title}» снята с маркета. Сценарий «${flow.name}» остался в деле.`;
    },
  }),
];
