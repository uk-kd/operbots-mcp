/**
 * Боты: подключение по токену, запуск, меню команд и переменные контента.
 */

import { z } from 'zod';

import type { Context } from '../context.js';
import { BOT_MODES } from '../enums.js';
import { ApiError } from '../errors.js';
import { report } from '../format.js';
import { caseField, botField, body, optional, tool, type Tool } from './kit.js';

interface Bot {
  id: string;
  name: string;
  username: string | null;
  description: string | null;
  mode: string;
  status: string;
  status_message: string | null;
  is_enabled: boolean;
  autostart: boolean;
  token_hint: string;
  external_id: number | null;
  ai_provider_id: string | null;
  settings: Record<string, unknown>;
  dialogs_count: number;
  unread_count: number;
  active_flow_id: string | null;
  webhook_url: string;
  webhook_ready: boolean;
  webhook_hint: string;
  started_at: string | null;
  last_update_at: string | null;
}

interface Command {
  id: string;
  command: string;
  description: string;
  is_visible: boolean;
  position: number;
  flow_id: string | null;
  node_id: string | null;
}

interface Variable {
  id: string;
  key: string;
  value: string;
  description: string | null;
  is_secret: boolean;
}

interface FlowBrief {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
  nodes_count: number;
  edges_count: number;
}

interface Provider {
  id: string;
  name: string;
  kind: string;
  model: string;
  is_active: boolean;
}

/** Карточка бота без секретов: адрес вебхука содержит рабочий ключ. */
function showBot(bot: Bot, full = false) {
  return {
    бот: bot.name,
    идентификатор: bot.id,
    имя_в_telegram: bot.username ? `@${bot.username}` : null,
    состояние: bot.status,
    сообщение: bot.status_message,
    включён: bot.is_enabled,
    автозапуск: bot.autostart,
    режим: bot.mode,
    токен: bot.token_hint,
    диалогов: bot.dialogs_count,
    непрочитано: bot.unread_count || undefined,
    активный_сценарий: bot.active_flow_id,
    подключение_ии: bot.ai_provider_id,
    описание: full ? bot.description : undefined,
    настройки: full && Object.keys(bot.settings ?? {}).length > 0 ? bot.settings : undefined,
    запущен: bot.started_at,
    последнее_обновление: bot.last_update_at,
  };
}

export async function findProvider(ctx: Context, caseId: string, hint: string): Promise<Provider> {
  const list = await ctx.api.get<Provider[]>(`/cases/${caseId}/ai-providers`);
  const needle = hint.trim().toLowerCase();

  const match =
    list.find((item) => item.id === hint) ??
    list.find((item) => item.name.toLowerCase() === needle) ??
    list.find((item) => item.name.toLowerCase().includes(needle));

  if (!match) {
    throw new ApiError(
      404,
      'provider_not_found',
      `Подключения «${hint}» нет в деле. Есть: ${list.map((item) => item.name).join(', ') || 'ни одного'}`,
    );
  }
  return match;
}

async function findFlowId(ctx: Context, caseId: string, botId: string, hint: string): Promise<string> {
  const list = await ctx.api.get<FlowBrief[]>(`/cases/${caseId}/bots/${botId}/flows`);
  const needle = hint.trim().toLowerCase();

  const match =
    list.find((item) => item.id === hint) ??
    list.find((item) => item.name.toLowerCase() === needle) ??
    list.find((item) => item.name.toLowerCase().includes(needle));

  if (!match) {
    throw new ApiError(
      404,
      'flow_not_found',
      `Сценария «${hint}» у бота нет. Есть: ${list.map((item) => item.name).join(', ') || 'ни одного'}`,
    );
  }
  return match.id;
}

export const botTools: Tool[] = [
  tool({
    name: 'bots_list',
    title: 'Список ботов',
    kind: 'read',
    description: 'Боты дела: состояние, режим работы, число диалогов и непрочитанного.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const list = await ctx.api.get<Bot[]>(`/cases/${found.id}/bots`);
      ctx.forgetBots(found.id);

      return report(
        `Ботов в деле «${found.name}»: ${list.length}`,
        list.map((bot) => showBot(bot)),
      );
    },
  }),

  tool({
    name: 'bots_get',
    title: 'Карточка бота',
    kind: 'read',
    description:
      'Бот целиком: настройки, меню команд, переменные контента и список сценариев. ' +
      'Значения переменных, отмеченных как секретные, скрыты.',
    input: { case: caseField, bot: botField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      const root = `/cases/${found.id}/bots/${bot.id}`;

      const [card, commands, variables, flows] = await Promise.all([
        ctx.api.get<Bot>(root),
        optional(ctx.api.get<Command[]>(`${root}/commands`)),
        optional(ctx.api.get<Variable[]>(`${root}/variables`)),
        optional(ctx.api.get<FlowBrief[]>(`${root}/flows`)),
      ]);

      return report(`Бот «${card.name}» в деле «${found.name}»`, {
        ...showBot(card, true),
        команды:
          typeof commands === 'string'
            ? commands
            : commands.length === 0
              ? 'ни одной'
              : commands
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((item) => ({
                    команда: `/${item.command}`,
                    описание: item.description,
                    видна_в_меню: item.is_visible,
                    сценарий: item.flow_id,
                    узел: item.node_id,
                  })),
        переменные:
          typeof variables === 'string'
            ? variables
            : variables.length === 0
              ? 'ни одной'
              : variables.map((item) => ({
                  ключ: item.key,
                  значение: item.is_secret ? '··· скрыто' : item.value,
                  описание: item.description,
                  секрет: item.is_secret || undefined,
                })),
        сценарии:
          typeof flows === 'string'
            ? flows
            : flows.length === 0
              ? 'ни одного'
              : flows.map((item) => ({
                  сценарий: item.name,
                  идентификатор: item.id,
                  в_работе: item.is_active,
                  редакция: item.version,
                  узлов: item.nodes_count,
                  связей: item.edges_count,
                })),
      });
    },
  }),

  tool({
    name: 'bots_save',
    title: 'Подключить или настроить бота',
    kind: 'write',
    description:
      'Без параметра bot подключает нового бота по токену от @BotFather — токен проверяется ' +
      'живым запросом к Telegram и хранится зашифрованным. С параметром bot меняет настройки. ' +
      'Смена токена или режима перезапускает работающего бота.',
    input: {
      case: caseField,
      bot: z.string().optional().describe('Какого бота менять. Не указывайте, чтобы подключить нового.'),
      name: z.string().min(1).max(120).optional().describe('Название бота в панели.'),
      token: z
        .string()
        .optional()
        .describe('Токен от @BotFather вида 1234567890:AA… Обязателен при подключении.'),
      description: z.string().max(2000).optional().describe('Описание бота.'),
      mode: z
        .enum(BOT_MODES)
        .optional()
        .describe(
          'polling — панель сама забирает обновления; webhook — Telegram шлёт их на панель ' +
            '(нужен публичный адрес по https).',
        ),
      autostart: z.boolean().optional().describe('Запускать бота при старте панели.'),
      enabled: z.boolean().optional().describe('Включён ли бот. false останавливает работающего.'),
      ai_provider: z
        .string()
        .optional()
        .describe('Подключение к ИИ-сервису: название или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const provider = args.ai_provider ? await findProvider(ctx, found.id, args.ai_provider) : null;

      if (!args.bot) {
        if (!args.name || !args.token) {
          return 'Чтобы подключить бота, нужны название и токен от @BotFather.';
        }
        const created = await ctx.api.post<Bot>(
          `/cases/${found.id}/bots`,
          body({
            name: args.name,
            token: args.token,
            description: args.description,
            mode: args.mode,
            autostart: args.autostart,
          }),
        );
        ctx.forgetBots(found.id);

        const next = provider
          ? await ctx.api.patch<Bot>(`/cases/${found.id}/bots/${created.id}`, {
              ai_provider_id: provider.id,
            })
          : created;

        return report('Бот подключён.', {
          ...showBot(next, true),
          дальше: 'Сценарий: flows_save. Запуск: bots_control action=start.',
        });
      }

      const bot = await ctx.resolveBot(found.id, args.bot);
      const payload = body({
        name: args.name,
        description: args.description,
        token: args.token,
        mode: args.mode,
        autostart: args.autostart,
        is_enabled: args.enabled,
        ai_provider_id: provider?.id,
      });
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const updated = await ctx.api.patch<Bot>(`/cases/${found.id}/bots/${bot.id}`, payload);
      ctx.forgetBots(found.id);
      return report('Настройки бота обновлены.', showBot(updated, true));
    },
  }),

  tool({
    name: 'bots_control',
    title: 'Запуск и остановка бота',
    kind: 'write',
    description:
      'Запускает, останавливает или перезапускает бота, а также отправляет меню команд ' +
      'в Telegram. Запуск сам синхронизирует меню; отдельная синхронизация нужна после ' +
      'правки команд у уже работающего бота.',
    input: {
      case: caseField,
      bot: botField,
      action: z
        .enum(['start', 'stop', 'restart', 'sync_commands'])
        .describe('Что сделать: запустить, остановить, перезапустить, обновить меню команд.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      const root = `/cases/${found.id}/bots/${bot.id}`;
      ctx.forgetBots(found.id);

      if (args.action === 'sync_commands') {
        const result = await ctx.api.post<{ ok: boolean; message?: string }>(`${root}/commands/sync`);
        return result.message ?? (result.ok ? 'Меню команд отправлено.' : 'Меню обновить не удалось.');
      }

      const updated = await ctx.api.post<Bot>(`${root}/${args.action}`);
      return report(`Бот «${updated.name}»: ${updated.status}`, {
        сообщение: updated.status_message,
        режим: updated.mode,
        запущен: updated.started_at,
      });
    },
  }),

  tool({
    name: 'bots_commands_apply',
    title: 'Настроить меню команд',
    kind: 'write',
    description:
      'Приводит меню команд бота к переданному списку: недостающие команды добавляет, ' +
      'существующие обновляет, порядок расставляет по порядку в списке. Команды, которых ' +
      'нет в списке, сохраняются — чтобы удалить их, передайте remove_missing=true. ' +
      'Само меню в Telegram обновляется, только если sync=true или бот перезапущен.',
    input: {
      case: caseField,
      bot: botField,
      commands: z
        .array(
          z.object({
            command: z
              .string()
              .min(1)
              .max(32)
              .describe('Имя команды без косой черты: латиница, цифры, подчёркивание.'),
            description: z.string().max(256).optional().describe('Пояснение в меню Telegram.'),
            visible: z.boolean().optional().describe('Показывать в меню. По умолчанию да.'),
            flow: z.string().optional().describe('Сценарий, который запускает команда.'),
            node_id: z.string().optional().describe('Узел сценария, с которого начать.'),
          }),
        )
        .describe('Желаемое меню целиком, в нужном порядке.'),
      remove_missing: z
        .boolean()
        .optional()
        .describe('Удалить команды бота, которых нет в списке. По умолчанию нет.'),
      sync: z.boolean().optional().describe('Сразу отправить меню в Telegram. По умолчанию да.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      const root = `/cases/${found.id}/bots/${bot.id}`;

      const existing = await ctx.api.get<Command[]>(`${root}/commands`);
      const byName = new Map(existing.map((item) => [item.command.toLowerCase(), item]));
      const added: string[] = [];
      const changed: string[] = [];
      const removed: string[] = [];

      for (const [index, wanted] of args.commands.entries()) {
        const name = wanted.command.replace(/^\//, '').toLowerCase();
        const flowId = wanted.flow ? await findFlowId(ctx, found.id, bot.id, wanted.flow) : undefined;
        const current = byName.get(name);

        if (!current) {
          // Позицию при создании передать нельзя — панель ставит команду
          // в конец, поэтому порядок задаём вторым запросом.
          const created = await ctx.api.post<Command>(
            `${root}/commands`,
            body({
              command: name,
              description: wanted.description,
              is_visible: wanted.visible,
              flow_id: flowId,
              node_id: wanted.node_id,
            }),
          );
          if (created.position !== index) {
            await ctx.api.patch(`${root}/commands/${created.id}`, { position: index });
          }
          added.push(`/${name}`);
          continue;
        }

        const payload = body({
          description: wanted.description,
          is_visible: wanted.visible,
          flow_id: flowId,
          node_id: wanted.node_id,
          position: index,
        });
        await ctx.api.patch(`${root}/commands/${current.id}`, payload);
        changed.push(`/${name}`);
        byName.delete(name);
      }

      if (args.remove_missing) {
        for (const leftover of byName.values()) {
          await ctx.api.delete(`${root}/commands/${leftover.id}`);
          removed.push(`/${leftover.command}`);
        }
      }

      let sync = 'не отправлялось';
      if (args.sync !== false) {
        const result = await ctx.api.post<{ ok: boolean; message?: string }>(`${root}/commands/sync`);
        sync = result.message ?? (result.ok ? 'отправлено' : 'отправить не удалось');
      }

      return report(`Меню бота «${bot.name}» настроено.`, {
        добавлено: added.length > 0 ? added : undefined,
        обновлено: changed.length > 0 ? changed : undefined,
        удалено: removed.length > 0 ? removed : undefined,
        осталось_без_изменений: !args.remove_missing && byName.size > 0 ? [...byName.keys()].map((k) => `/${k}`) : undefined,
        меню_в_telegram: sync,
      });
    },
  }),

  tool({
    name: 'bots_variables_set',
    title: 'Переменные контента бота',
    kind: 'write',
    description:
      'Задаёт переменные, которые подставляются в тексты сценария: цены, адреса, ссылки. ' +
      'Существующие ключи обновляются, новые создаются. Отмеченные секретными не показываются ' +
      'обратно. Ключ: латиница, цифры, подчёркивание и точка.',
    input: {
      case: caseField,
      bot: botField,
      variables: z
        .array(
          z.object({
            key: z.string().min(1).max(64).describe('Имя переменной, например price.delivery'),
            value: z.string().describe('Значение.'),
            description: z.string().max(240).optional().describe('Для чего она.'),
            secret: z.boolean().optional().describe('Скрывать значение в панели и здесь.'),
          }),
        )
        .optional()
        .describe('Переменные, которые нужно завести или обновить.'),
      delete_keys: z.array(z.string()).optional().describe('Имена переменных, которые удалить.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      const root = `/cases/${found.id}/bots/${bot.id}`;

      const existing = await ctx.api.get<Variable[]>(`${root}/variables`);
      const byKey = new Map(existing.map((item) => [item.key, item]));
      const added: string[] = [];
      const changed: string[] = [];
      const removed: string[] = [];
      const missing: string[] = [];

      for (const wanted of args.variables ?? []) {
        const current = byKey.get(wanted.key);
        if (current) {
          await ctx.api.patch(
            `${root}/variables/${current.id}`,
            body({
              value: wanted.value,
              description: wanted.description,
              is_secret: wanted.secret,
            }),
          );
          changed.push(wanted.key);
        } else {
          await ctx.api.post(
            `${root}/variables`,
            body({
              key: wanted.key,
              value: wanted.value,
              description: wanted.description,
              is_secret: wanted.secret,
            }),
          );
          added.push(wanted.key);
        }
      }

      for (const key of args.delete_keys ?? []) {
        const current = byKey.get(key);
        if (current) {
          await ctx.api.delete(`${root}/variables/${current.id}`);
          removed.push(key);
        } else {
          missing.push(key);
        }
      }

      if (added.length + changed.length + removed.length === 0 && missing.length === 0) {
        return 'Нечего менять: не передано ни переменных, ни ключей на удаление.';
      }

      return report(`Переменные бота «${bot.name}» обновлены.`, {
        создано: added.length > 0 ? added : undefined,
        обновлено: changed.length > 0 ? changed : undefined,
        удалено: removed.length > 0 ? removed : undefined,
        не_найдено: missing.length > 0 ? missing : undefined,
      });
    },
  }),

  tool({
    name: 'bots_reveal_token',
    title: 'Показать токен бота',
    kind: 'danger',
    description:
      'Возвращает токен Telegram в открытом виде. Токен даёт полное управление ботом — ' +
      'запрашивайте его, только если пользователь прямо об этом попросил, и не пересказывайте ' +
      'без надобности.',
    input: { case: caseField, bot: botField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      const result = await ctx.api.get<{ token: string }>(
        `/cases/${found.id}/bots/${bot.id}/token`,
      );
      return `Токен бота «${bot.name}»:\n${result.token}\n\nЕсли он попал не туда, смените его у @BotFather.`;
    },
  }),

  tool({
    name: 'bots_webhook_check',
    title: 'Что Telegram знает о вебхуке',
    kind: 'read',
    description:
      'Отчёт самого Telegram: на какой адрес он шлёт обновления, сколько их ждёт доставки и ' +
      'какой была последняя ошибка доставки. Единственный способ понять, почему бот в режиме ' +
      'вебхука молчит: со стороны панели всё бывает исправно — адрес публичный, запрос доходит, — ' +
      'а Telegram не достучался и знает причину. Токен наружу не отдаётся, панель спрашивает сама.',
    input: { case: caseField, bot: botField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      const state = await ctx.api.get<{
        url: string;
        pending_update_count: number;
        last_error_at: string | null;
        last_error_message: string | null;
        ip_address: string | null;
        max_connections: number | null;
        allowed_updates: string[];
        verdict: string;
      }>(`/cases/${found.id}/bots/${bot.id}/webhook/state`);

      return report(`Вебхук бота «${bot.name}»`, {
        вывод: state.verdict,
        адрес: state.url || 'не установлен',
        ждут_доставки: state.pending_update_count,
        последняя_ошибка: state.last_error_message,
        когда_ошибка: state.last_error_at,
        адрес_панели: state.ip_address,
        одновременных_подключений: state.max_connections,
        какие_обновления: state.allowed_updates.join(', ') || 'все',
      });
    },
  }),

  tool({
    name: 'bots_webhook_rotate',
    title: 'Сменить адрес вебхука',
    kind: 'danger',
    description:
      'Выдаёт боту новый секретный адрес вебхука. Прежний перестаёт работать навсегда — ' +
      'это нужно, если старый адрес утёк. Работающий бот перезапускается.',
    input: { case: caseField, bot: botField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      const updated = await ctx.api.post<Bot>(
        `/cases/${found.id}/bots/${bot.id}/webhook/rotate`,
      );
      return report(`Адрес вебхука бота «${updated.name}» сменён.`, {
        состояние: updated.status,
        готовность: updated.webhook_ready ? 'панель готова принимать вебхуки' : updated.webhook_hint,
      });
    },
  }),

  tool({
    name: 'bots_delete',
    title: 'Отключить бота',
    kind: 'danger',
    description:
      'Убирает бота из дела вместе с командами и переменными. Диалоги и переписка удаляются. ' +
      'Восстановить нельзя. Чтобы временно выключить, используйте bots_save enabled=false.',
    input: {
      case: caseField,
      bot: botField,
      confirm_name: z.string().describe('Точное название бота — подтверждение удаления.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const bot = await ctx.resolveBot(found.id, args.bot);
      if (args.confirm_name.trim() !== bot.name) {
        return `Не удаляю: подтверждение «${args.confirm_name}» не совпадает с названием «${bot.name}».`;
      }

      await ctx.api.delete(`/cases/${found.id}/bots/${bot.id}`);
      ctx.forgetBots(found.id);
      return `Бот «${bot.name}» отключён от дела «${found.name}».`;
    },
  }),
];
