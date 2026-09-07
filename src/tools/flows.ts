/**
 * Сценарии на полотне: узлы, связи, публикация, редакции и прогон.
 *
 * Панель хранит граф в формате полотна (React Flow): вид узла лежит в
 * `data.kind`, координаты — в `position`. Здесь наружу отдаётся плоское
 * представление — id, kind, title, config, x, y — и оно же принимается
 * обратно. Так модель правит сценарий, не разбираясь во внутренностях
 * редактора, а размеры узлов, положение полотна и оформление переносятся
 * из текущей редакции, чтобы правка одного узла не сбивала вид всей карты.
 */

import { z } from 'zod';

import { FLOW_SCOPES, NODE_KINDS, SIMULATE_EVENTS } from '../enums.js';
import { ApiError } from '../errors.js';
import { MASK, raw, report } from '../format.js';
import { caseField, botField, body, tool, type Tool } from './kit.js';

interface RawNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: {
    kind?: string;
    title?: string;
    config?: Record<string, unknown>;
    /** Цвет узла и прочее оформление полотна — модель их не касается. */
    [key: string]: unknown;
  };
  width?: number | null;
  height?: number | null;
}

interface RawEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string | null;
  data?: Record<string, unknown>;
}

interface RawGraph {
  nodes?: RawNode[];
  edges?: RawEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

/** Чем сценарий связан с маркетом: его выложили или из него поставили. */
export interface MarketLink {
  item_id: string;
  role: 'source' | 'installed';
  title: string;
  version: number;
  latest_version: number;
}

export interface Flow {
  id: string;
  bot_id: string;
  name: string;
  description: string | null;
  /** dialog — личная переписка, community — сообщества. */
  scope: string;
  is_active: boolean;
  version: number;
  graph: RawGraph;
  published_at: string | null;
  updated_at: string;
  problems: string[];
  market?: MarketLink | null;
}

interface FlowBrief {
  id: string;
  name: string;
  bot_name: string;
  description: string | null;
  scope: string;
  is_active: boolean;
  version: number;
  nodes_count: number;
  edges_count: number;
  problems_count: number;
  updated_at: string;
  market?: MarketLink | null;
}

/** Файл выгрузки сценария: то, что панель скачивает и читает обратно. */
interface FlowDocument {
  format: string;
  version: number;
  name: string;
  description: string | null;
  graph: RawGraph;
  source?: { case: string | null; bot: string | null; flow_version: number | null };
}

interface Version {
  version: number;
  comment: string | null;
  created_at: string;
}

const nodeInput = z.object({
  id: z.string().min(1).max(64).describe('Имя узла внутри сценария, уникальное.'),
  kind: z.enum(NODE_KINDS).describe('Что делает узел.'),
  title: z.string().optional().describe('Подпись узла на полотне.'),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Параметры узла. Состав полей смотрите в operbots_catalog what=node_kinds.'),
  x: z.number().optional().describe('Положение на полотне по горизонтали.'),
  y: z.number().optional().describe('Положение на полотне по вертикали.'),
});

const edgeInput = z.object({
  id: z.string().max(96).optional().describe('Имя связи. Если не задать, соберётся само.'),
  from: z.string().describe('Узел-источник.'),
  to: z.string().describe('Узел-приёмник.'),
  out: z
    .string()
    .optional()
    .describe(
      'Выход узла-источника, если их несколько. Названия латиницей и зависят от вида узла: ' +
        'у условия true и false, у запроса ok и error, у меню — номера кнопок. ' +
        'Полный перечень — в operbots_catalog what=node_kinds, поле «выходы». По умолчанию out.',
    ),
  label: z.string().optional().describe('Подпись на связи.'),
});

type NodeInput = z.infer<typeof nodeInput>;
type EdgeInput = z.infer<typeof edgeInput>;

/** Плоское представление графа — то, что видит и присылает модель. */
function flatten(graph: RawGraph) {
  return {
    nodes: (graph.nodes ?? []).map((node) => ({
      id: node.id,
      kind: node.data?.kind ?? 'неизвестно',
      title: node.data?.title || undefined,
      // Настройки уходят дословно: маска вывода превратила бы ключ
      // сервиса в «···1234», и следующий flows_save записал бы её в
      // сценарий вместо ключа.
      config:
        node.data?.config && Object.keys(node.data.config).length > 0
          ? raw(node.data.config)
          : undefined,
      x: node.position?.x ?? 0,
      y: node.position?.y ?? 0,
    })),
    edges: (graph.edges ?? []).map((edge) => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      out: edge.sourceHandle ?? undefined,
      label: edge.label ?? undefined,
    })),
  };
}

/**
 * Отказывает, если в настройки узла попало замаскированное значение.
 *
 * Круг flows_get → flows_save модель делает по прямому указанию
 * сервера. Стоит маске просочиться в config — и ключ сервиса в
 * сценарии заменится на «···1234», а бот замолчит без всякой ошибки.
 */
function refuseMasked(nodes: NodeInput[]): void {
  const spoiled: string[] = [];

  const walk = (node: string, path: string, value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith(MASK)) spoiled.push(`${node}.${path}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(node, `${path}[${index}]`, item));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(node, `${path}.${key}`, item);
    }
  };

  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.config ?? {})) walk(node.id, key, value);
  }

  if (spoiled.length > 0) {
    throw new ApiError(
      400,
      'masked_value',
      `Не сохраняю: в настройках узлов стоят замаскированные значения (${spoiled.join(', ')}). ` +
        `«${MASK}» — это то, чем вывод прикрывает секрет, а не сам секрет. ` +
        'Впишите настоящее значение.',
    );
  }
}

/**
 * Собирает граф в формате полотна. Размеры узлов, положение карты и всё
 * оформление — цвет узла, цвет и вид связи — берутся из текущей редакции:
 * панель их рисует, а модель о них не знает и прислать не может. Поэтому
 * прежнее `data` переносится целиком, а поверх ложится только то, чем
 * модель распоряжается: вид узла, подпись и настройки.
 */
function build(nodes: NodeInput[], edges: EdgeInput[], previous?: RawGraph): RawGraph {
  refuseMasked(nodes);
  const sizes = new Map((previous?.nodes ?? []).map((node) => [node.id, node]));
  const before = new Map((previous?.edges ?? []).map((edge) => [edge.id, edge]));

  return {
    nodes: nodes.map((node, index) => {
      const old = sizes.get(node.id);
      return {
        id: node.id,
        type: old?.type ?? 'operbots',
        position: {
          x: node.x ?? old?.position?.x ?? 80 + (index % 4) * 280,
          y: node.y ?? old?.position?.y ?? 80 + Math.floor(index / 4) * 200,
        },
        data: {
          ...(old?.data ?? {}),
          kind: node.kind,
          title: node.title ?? old?.data?.title ?? '',
          config: node.config ?? old?.data?.config ?? {},
        },
        ...(old?.width ? { width: old.width } : {}),
        ...(old?.height ? { height: old.height } : {}),
      };
    }),
    edges: edges.map((edge) => {
      const id = edge.id ?? `${edge.from}->${edge.to}${edge.out ? `:${edge.out}` : ''}`;
      const label = edge.label ?? null;
      // Подпись панель держит в двух местах сразу, и рассинхрон видно
      // глазом: на связи одно, в её настройках другое.
      const data = { ...(before.get(id)?.data ?? {}) };
      if (label === null) delete data.label;
      else data.label = label;
      return {
        id,
        source: edge.from,
        target: edge.to,
        sourceHandle: edge.out ?? null,
        targetHandle: null,
        label,
        data,
      };
    }),
    viewport: previous?.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
}

/** Связь с маркетом одной строкой: «выложен, версия 2» или «установлен, есть версия 3». */
export function marketNote(link: MarketLink | null | undefined): string | undefined {
  if (!link) return undefined;
  if (link.role === 'source') return `выложен в маркет как «${link.title}», версия ${link.version}`;
  const fresh =
    link.latest_version > link.version
      ? `, в маркете уже версия ${link.latest_version} — обновить можно market_install`
      : '';
  return `установлен из маркета «${link.title}», версия ${link.version}${fresh}`;
}

/** Вид сценария словами: «диалогов» или «сообществ» — после «для». */
export function scopeWord(scope: string | undefined): string {
  return scope === 'community' ? 'сообществ' : 'диалогов';
}

export function showFlow(flow: Flow, withGraph: boolean) {
  const flat = flatten(flow.graph);
  return {
    сценарий: flow.name,
    идентификатор: flow.id,
    описание: flow.description,
    для: scopeWord(flow.scope),
    в_работе: flow.is_active,
    редакция: flow.version,
    узлов: flat.nodes.length,
    связей: flat.edges.length,
    изменён: flow.updated_at,
    замечания: flow.problems.length > 0 ? flow.problems : undefined,
    маркет: marketNote(flow.market),
    узлы: withGraph ? flat.nodes : undefined,
    связи: withGraph ? flat.edges : undefined,
  };
}

export async function locate(
  ctx: Parameters<Tool['run']>[1],
  caseHint: string | undefined,
  botHint: string,
  flowHint?: string,
) {
  const found = await ctx.resolveCase(caseHint);
  const bot = await ctx.resolveBot(found.id, botHint);
  const root = `/cases/${found.id}/bots/${bot.id}/flows`;

  if (!flowHint) return { found, bot, root, flowId: null };

  const list = await ctx.api.get<FlowBrief[]>(root);
  const needle = flowHint.trim().toLowerCase();
  const match =
    list.find((item) => item.id === flowHint) ??
    list.find((item) => item.name.toLowerCase() === needle) ??
    list.find((item) => item.name.toLowerCase().includes(needle));

  if (!match) {
    const names = list.map((item) => item.name).join(', ') || 'ни одного';
    throw new Error(`Сценария «${flowHint}» у бота «${bot.name}» нет. Есть: ${names}`);
  }
  return { found, bot, root, flowId: match.id };
}

export const flowTools: Tool[] = [
  tool({
    name: 'flows_list',
    title: 'Сценарии',
    kind: 'read',
    description:
      'Какие сценарии заведены, какой из них в работе и сколько в них узлов. ' +
      'Без параметра bot возвращает сценарии всего дела — со всех ботов сразу. У сценария ' +
      'есть вид: для диалогов (личная переписка) или для сообществ (группы и каналы); у бота ' +
      'по одному включённому на вид.',
    input: {
      case: caseField,
      bot: botField.optional().describe(
        'Бот: название, @username или идентификатор. Без него — все боты дела.',
      ),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);

      if (!args.bot) {
        const list = await ctx.api.get<FlowBrief[]>(`/cases/${found.id}/flows`);
        const working = list.filter((item) => item.is_active).length;
        return report(
          `Сценариев в деле «${found.name}»: ${list.length}, в работе ${working}`,
          list.map((item) => ({
            сценарий: item.name,
            бот: item.bot_name,
            идентификатор: item.id,
            для: scopeWord(item.scope),
            в_работе: item.is_active,
            редакция: item.version,
            узлов: item.nodes_count,
            связей: item.edges_count,
            замечаний: item.problems_count || undefined,
            маркет: marketNote(item.market),
            изменён: item.updated_at,
          })),
        );
      }

      const { bot, root } = await locate(ctx, args.case, args.bot);
      const list = await ctx.api.get<FlowBrief[]>(root);

      return report(
        `Сценариев у бота «${bot.name}»: ${list.length}`,
        list.map((item) => ({
          сценарий: item.name,
          идентификатор: item.id,
          для: scopeWord(item.scope),
          в_работе: item.is_active,
          редакция: item.version,
          узлов: item.nodes_count,
          связей: item.edges_count,
          замечаний: item.problems_count || undefined,
          маркет: marketNote(item.market),
          изменён: item.updated_at,
        })),
      );
    },
  }),

  tool({
    name: 'flows_get',
    title: 'Открыть сценарий',
    kind: 'read',
    description:
      'Сценарий целиком: все узлы с их параметрами, все связи и замечания к графу — ' +
      'связи в никуда, отсутствие триггера, недостижимые узлы.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий: название или идентификатор.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const flow = await ctx.api.get<Flow>(`${root}/${flowId}`);
      return report(`Сценарий «${flow.name}»`, showFlow(flow, true));
    },
  }),

  tool({
    name: 'flows_save',
    title: 'Создать или сохранить сценарий',
    kind: 'write',
    description:
      'Без параметра flow создаёт сценарий — пустой, из переданного графа или копией другого ' +
      '(copy_of). С параметром flow перезаписывает его. Граф передаётся ЦЕЛИКОМ: чтобы ' +
      'поправить один узел, сначала прочитайте сценарий через flows_get и пришлите изменённый ' +
      'список полностью. Новая редакция создаётся, только если граф действительно изменился. ' +
      'Готовые сценарии — «Консультант с ИИ», «Заявка», «Запись на визит» и другие — здесь не ' +
      'создаются: их ставят из маркета через market_install. ' +
      'Сохранение не включает сценарий в работу — для этого есть flows_publish.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().optional().describe('Какой сценарий перезаписать. Не указывайте для нового.'),
      copy_of: z
        .string()
        .optional()
        .describe(
          'Скопировать существующий сценарий вместо создания пустого. Название копии — в name; ' +
            'без него будет «… — копия».',
        ),
      name: z.string().min(1).max(120).optional().describe('Название сценария.'),
      description: z.string().max(2000).optional().describe('Описание.'),
      scope: z
        .enum(FLOW_SCOPES)
        .optional()
        .describe(
          'Для какой переписки: dialog — личная (по умолчанию), community — сообщества: ' +
            'группы и каналы. Узлы сообществ (trigger.member, trigger.post, action.kick и ' +
            'другие) есть только у community, «Анкета» и «Кнопки под полем ввода» — только у ' +
            'dialog; каталог под вид — operbots_catalog what=node_kinds scope=…. Сменить вид ' +
            'можно только у выключенного сценария.',
        ),
      nodes: z.array(nodeInput).optional().describe('Узлы сценария целиком.'),
      edges: z.array(edgeInput).optional().describe('Связи между узлами целиком.'),
      comment: z.string().max(240).optional().describe('Комментарий к редакции.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);

      if (args.copy_of && !args.flow) {
        const source = await locate(ctx, args.case, args.bot, args.copy_of);
        // Имя копии панель принимает сразу: «… — копия — копия» после
        // второго раза никому не помогало.
        const copy = await ctx.api.post<Flow>(
          `${source.root}/${source.flowId}/duplicate`,
          body({ name: args.name }),
        );
        const renamed = args.description
          ? await ctx.api.put<Flow>(`${root}/${copy.id}`, body({ description: args.description }))
          : copy;
        return report('Сценарий скопирован.', showFlow(renamed, false));
      }

      if (!flowId) {
        if (!args.name) return 'Чтобы создать сценарий, нужно название.';
        const graph = args.nodes ? build(args.nodes, args.edges ?? []) : undefined;
        const created = await ctx.api.post<Flow>(
          root,
          body({
            name: args.name,
            description: args.description,
            scope: args.scope,
            graph,
          }),
        );
        return report(
          created.is_active
            ? `Сценарий создан и сразу включён в работу — он первый у бота для ${scopeWord(created.scope)}.`
            : 'Сценарий создан.',
          showFlow(created, false),
        );
      }

      const current = await ctx.api.get<Flow>(`${root}/${flowId}`);
      const graph = args.nodes ? build(args.nodes, args.edges ?? [], current.graph) : undefined;
      const payload = body({
        name: args.name,
        description: args.description,
        scope: args.scope,
        graph,
        comment: args.comment,
      });
      if (Object.keys(payload).length === 0) return 'Нечего сохранять: не передано ни одного поля.';

      const saved = await ctx.api.put<Flow>(`${root}/${flowId}`, payload);
      const grew = saved.version > current.version;
      return report(
        grew
          ? `Сохранено, редакция №${saved.version}.`
          : 'Сохранено; граф не изменился, новая редакция не создавалась.',
        showFlow(saved, false),
      );
    },
  }),

  tool({
    name: 'flows_publish',
    title: 'Включить или выключить сценарий',
    kind: 'write',
    description:
      'Включает сценарий в работу — остальные сценарии бота при этом выключаются, активным ' +
      'может быть только один. Перед включением граф проверяется: связи на несуществующие узлы ' +
      'не дадут опубликовать. Выключение оставляет бота без полотна, и он перестаёт отвечать.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий: название или идентификатор.'),
      active: z.boolean().optional().describe('true — включить (по умолчанию), false — выключить.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const action = args.active === false ? 'unpublish' : 'publish';
      const flow = await ctx.api.post<Flow>(`${root}/${flowId}/${action}`);

      return report(
        flow.is_active
          ? `Сценарий «${flow.name}» в работе. Остальные сценарии бота выключены.`
          : `Сценарий «${flow.name}» снят с работы.`,
        showFlow(flow, false),
      );
    },
  }),

  tool({
    name: 'flows_versions',
    title: 'История редакций',
    kind: 'read',
    description: 'Все сохранённые редакции сценария с комментариями и датами.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий: название или идентификатор.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const list = await ctx.api.get<Version[]>(`${root}/${flowId}/versions`);

      return report(
        `Редакций: ${list.length}`,
        list.map((item) => ({
          редакция: item.version,
          комментарий: item.comment,
          создана: item.created_at,
        })),
      );
    },
  }),

  tool({
    name: 'flows_restore',
    title: 'Вернуть редакцию',
    kind: 'write',
    description:
      'Возвращает граф сценария к выбранной редакции. История не переписывается — поверх ' +
      'создаётся новая редакция. Если сценарий в работе, бот начнёт вести себя по-старому сразу.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий: название или идентификатор.'),
      version: z.number().int().min(1).describe('Номер редакции из flows_versions.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const flow = await ctx.api.post<Flow>(`${root}/${flowId}/versions/${args.version}/restore`);
      return report(
        `Сценарий возвращён к редакции №${args.version}; сохранено как редакция №${flow.version}.`,
        showFlow(flow, false),
      );
    },
  }),

  tool({
    name: 'flows_simulate',
    title: 'Прогнать сценарий',
    kind: 'write',
    description:
      'Проверяет сценарий, не выходя к платформе: какой триггер сработал, какие шаги ' +
      'прошли и что бот ' +
      'ответил бы. Диалог нигде не сохраняется, задержки пропускаются, запросы к внешним ' +
      'адресам и весточки в служебный чат не выполняются. Через variables можно подставить ' +
      'накопленное разговором — так проверяются ветки условий и подстановки. ' +
      'Внимание: узлы с ИИ обращаются к настоящей модели и расходуют её лимиты.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий: название или идентификатор.'),
      text: z.string().optional().describe('Текст входящего сообщения.'),
      command: z.string().optional().describe('Команда без косой черты, например start.'),
      callback_data: z.string().optional().describe('Данные нажатой кнопки.'),
      event: z
        .enum(SIMULATE_EVENTS)
        .optional()
        .describe(
          'Для сценариев сообществ: post — пост в канале (text — его текст), join и leave — ' +
            'участник вошёл или вышел (text — его имя). Без него — обычное сообщение.',
        ),
      variables: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Переменные разговора на момент прогона: {"город": "Москва"}.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const result = await ctx.api.post<{
        matched: boolean;
        steps: { node_id: string; kind: string; title: string; output: string | null }[];
        messages: string[];
        variables: Record<string, unknown>;
        error: string | null;
      }>(
        `${root}/${flowId}/simulate`,
        body({
          text: args.text ?? '',
          command: args.command,
          callback_data: args.callback_data,
          event: args.event,
          variables: args.variables,
        }),
      );

      return report(result.matched ? 'Сценарий сработал.' : 'Ни один триггер не подошёл.', {
        ошибка: result.error,
        шаги: result.steps.map((step) => ({
          узел: step.node_id,
          вид: step.kind,
          подпись: step.title,
          результат: step.output,
        })),
        бот_ответил_бы: result.messages,
        переменные: result.variables,
      });
    },
  }),

  tool({
    name: 'flows_export',
    title: 'Выгрузить сценарий',
    kind: 'read',
    description:
      'Отдаёт сценарий одним объектом формата operbots.flow — тем же, что панель скачивает ' +
      'кнопкой «Скачать». Ответ приходит готовым JSON: его целиком передают в flows_import ' +
      'полем document или сохраняют копию рядом с кодом.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий: название или идентификатор.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const document = await ctx.api.get<FlowDocument>(`${root}/${flowId}/export`);
      // Дословно: пересказанную карточку обратно в flows_import не
      // передашь, а связка export → import ради этого и заведена.
      return report(`Выгрузка сценария «${document.name}» — целиком для flows_import:`, raw(document));
    },
  }),

  tool({
    name: 'flows_import',
    title: 'Загрузить сценарий из выгрузки',
    kind: 'write',
    description:
      'Заводит сценарий из объекта, полученного через flows_export. Существующие не трогает: ' +
      'загруженный добавляется рядом, а при совпадении названий получает номер. ' +
      'Ссылки на ИИ-сервис и базу знаний исходного дела при переезде проверяются, ' +
      'и неразрешимые снимаются — о каждой снятой сказано в ответе.',
    input: {
      case: caseField,
      bot: botField,
      document: z
        .record(z.string(), z.unknown())
        .describe('Содержимое выгрузки целиком — то, что вернул flows_export.'),
      name: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Своё название вместо записанного в выгрузке.'),
    },
    async run(args, ctx) {
      const { bot, root } = await locate(ctx, args.case, args.bot);
      const result = await ctx.api.post<{ flow: Flow; warnings: string[] }>(`${root}/import`, {
        document: args.document,
        name: args.name ?? null,
      });

      return report(
        `Сценарий «${result.flow.name}» загружен боту «${bot.name}»`,
        {
          ...showFlow(result.flow, false),
          снятые_ссылки: result.warnings.length > 0 ? result.warnings : undefined,
        },
      );
    },
  }),

  tool({
    name: 'flows_delete',
    title: 'Удалить сценарий',
    kind: 'danger',
    description:
      'Удаляет сценарий вместе со всей историей редакций. Восстановить нельзя. ' +
      'Если удалить работающий сценарий, бот останется без полотна. Публикация в маркете, ' +
      'если сценарий выложен, остаётся; снять её — market_unpublish.',
    input: {
      case: caseField,
      bot: botField,
      flow: z.string().describe('Сценарий: название или идентификатор.'),
      confirm_name: z.string().describe('Точное название сценария — подтверждение удаления.'),
    },
    async run(args, ctx) {
      const { root, flowId } = await locate(ctx, args.case, args.bot, args.flow);
      const flow = await ctx.api.get<Flow>(`${root}/${flowId}`);
      if (args.confirm_name.trim() !== flow.name) {
        return `Не удаляю: подтверждение «${args.confirm_name}» не совпадает с названием «${flow.name}».`;
      }

      await ctx.api.delete(`${root}/${flowId}`);
      return `Сценарий «${flow.name}» удалён вместе с историей редакций.`;
    },
  }),
];
