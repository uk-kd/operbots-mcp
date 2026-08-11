/**
 * Дела: отдельные проекты со своими ботами, участниками и перепиской.
 */

import { z } from 'zod';

import { report } from '../format.js';
import { caseField, body, optional, tool, type Tool } from './kit.js';

interface Overview {
  bots_total: number;
  bots_running: number;
  bots_error: number;
  dialogs_total: number;
  dialogs_unread: number;
  dialogs_operator: number;
  messages_today: number;
  messages_week: number;
  incoming_week: number;
  ai_week: number;
  operator_week: number;
  tasks_pending: number;
  knowledge_bases: number;
  knowledge_chunks: number;
  providers: number;
  flows_active: number;
  members: number;
  days: { date: string; incoming: number; outgoing: number }[];
}

export const caseTools: Tool[] = [
  tool({
    name: 'cases_list',
    title: 'Список дел',
    kind: 'read',
    description:
      'Все дела, к которым есть доступ, с ролью, правами и счётчиками ботов и непрочитанного.',
    input: {
      include_archived: z
        .boolean()
        .optional()
        .describe('Показать и архивные дела. По умолчанию нет.'),
    },
    async run(args, ctx) {
      const list = await ctx.api.get<Record<string, unknown>[]>('/cases', {
        include_archived: args.include_archived ?? false,
      });

      return report(
        `Дел: ${list.length}`,
        list.map((item) => ({
          дело: `${item.emoji as string} ${item.name as string}`,
          идентификатор: item.id,
          роль: item.is_owner ? 'владелец' : ((item.role_name as string) ?? 'без роли'),
          боты: `${item.running_bots_count as number} из ${item.bots_count as number} работают`,
          участники: item.members_count,
          непрочитано: (item.unread_count as number) || undefined,
          архив: (item.is_archived as boolean) || undefined,
        })),
      );
    },
  }),

  tool({
    name: 'cases_get',
    title: 'Открыть дело',
    kind: 'read',
    description:
      'Карточка дела: права текущего пользователя в нём и сводка — боты, диалоги, сообщения ' +
      'за неделю, отложенные действия, базы знаний, участники.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const overview = await optional(
        ctx.api.get<Overview>(`/cases/${found.id}/overview`),
      );

      const summary =
        typeof overview === 'string'
          ? overview
          : {
              боты: `всего ${overview.bots_total}, работают ${overview.bots_running}, с ошибкой ${overview.bots_error}`,
              активных_сценариев: overview.flows_active,
              диалоги: `всего ${overview.dialogs_total}, непрочитанных ${overview.dialogs_unread}, у операторов ${overview.dialogs_operator}`,
              сообщения: `сегодня ${overview.messages_today}, за неделю ${overview.messages_week} (входящих ${overview.incoming_week}, от ИИ ${overview.ai_week}, от операторов ${overview.operator_week})`,
              отложенных_действий: overview.tasks_pending,
              базы_знаний: `${overview.knowledge_bases}, фрагментов ${overview.knowledge_chunks}`,
              подключений_ии: overview.providers,
              участники: overview.members,
              по_дням: overview.days.map(
                (day) => `${day.date}: входящих ${day.incoming}, исходящих ${day.outgoing}`,
              ),
            };

      return report(`${found.emoji} ${found.name}`, {
        идентификатор: found.id,
        короткое_имя: found.slug,
        роль: found.is_owner ? 'владелец' : (found.role_name ?? 'без роли'),
        мои_права: found.permissions,
        архив: found.is_archived || undefined,
        сводка: summary,
      });
    },
  }),

  tool({
    name: 'cases_save',
    title: 'Создать или изменить дело',
    kind: 'write',
    description:
      'Без указания дела создаёт новое (вы становитесь владельцем, разворачиваются пять ролей: ' +
      'владелец, администратор, конструктор, оператор, наблюдатель). С указанием — меняет ' +
      'название, описание, знак и оформление или убирает дело в архив.',
    input: {
      case: z
        .string()
        .optional()
        .describe('Какое дело менять. Не указывайте, чтобы создать новое.'),
      name: z.string().min(2).max(120).optional().describe('Название дела.'),
      description: z.string().max(2000).optional().describe('Описание.'),
      emoji: z.string().max(16).optional().describe('Знак дела, например 🛍. По умолчанию ◆.'),
      accent: z
        .string()
        .max(24)
        .optional()
        .describe('Оформление: platinum, signal, aurora, ultra, ember, moss, rose.'),
      archived: z
        .boolean()
        .optional()
        .describe('Убрать дело в архив или вернуть из него. Только при изменении.'),
    },
    async run(args, ctx) {
      const payload = body({
        name: args.name,
        description: args.description,
        emoji: args.emoji,
        accent: args.accent,
        is_archived: args.archived,
      });

      if (!args.case) {
        if (!args.name) return 'Чтобы создать дело, нужно название.';
        // Архив задаётся только правкой: при создании панель такого поля не ждёт.
        const { is_archived: _, ...fresh } = payload;
        const created = await ctx.api.post<Record<string, unknown>>('/cases', fresh);
        ctx.forgetCases();
        return report('Дело создано.', {
          дело: `${created.emoji as string} ${created.name as string}`,
          идентификатор: created.id,
          короткое_имя: created.slug,
        });
      }

      const found = await ctx.resolveCase(args.case);
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const updated = await ctx.api.patch<Record<string, unknown>>(`/cases/${found.id}`, payload);
      ctx.forgetCases();
      return report('Дело обновлено.', {
        дело: `${updated.emoji as string} ${updated.name as string}`,
        описание: updated.description,
        архив: (updated.is_archived as boolean) || undefined,
      });
    },
  }),

  tool({
    name: 'cases_delete',
    title: 'Удалить дело',
    kind: 'danger',
    description:
      'Удаляет дело целиком: боты, сценарии, переписка, участники и роли. Восстановить нельзя. ' +
      'Чтобы просто убрать дело из списка, используйте cases_save с archived=true.',
    input: {
      case: z.string().describe('Дело: название или идентификатор.'),
      confirm_name: z
        .string()
        .describe('Точное название дела — подтверждение, что удаляется именно оно.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      if (args.confirm_name.trim() !== found.name) {
        return (
          `Не удаляю: подтверждение «${args.confirm_name}» не совпадает с названием «${found.name}». ` +
          'Передайте название дословно.'
        );
      }

      await ctx.api.delete(`/cases/${found.id}`);
      ctx.forgetCases();
      return `Дело «${found.name}» удалено вместе со всем содержимым.`;
    },
  }),

  tool({
    name: 'cases_leave',
    title: 'Выйти из дела',
    kind: 'danger',
    description:
      'Убирает вас из числа участников дела. Владелец выйти не может — сначала нужно передать ' +
      'дело другому участнику (case_transfer).',
    input: { case: z.string().describe('Дело: название или идентификатор.') },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const result = await ctx.api.post<{ message?: string }>(`/cases/${found.id}/leave`);
      ctx.forgetCases();
      return result.message ?? `Вы вышли из дела «${found.name}».`;
    },
  }),
];
