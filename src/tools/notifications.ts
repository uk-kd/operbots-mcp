/** Личная лента и настройки уведомлений: не требуют выбранного дела. */
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { report } from '../format.js';
import { body, caseField, limitField, tool, type Tool } from './kit.js';

export const notificationTools: Tool[] = [
  tool({ name: 'notifications_list', title: 'Лента уведомлений', kind: 'read',
    description: 'Личные уведомления всех дел с отбором и страницами. Чтение ленты не отмечает записи прочитанными.',
    input: { case: caseField, kind: z.array(z.string()).optional(), level: z.enum(['info', 'warn', 'error']).optional(),
      unread: z.boolean().optional(), limit: limitField(200, 30), offset: z.number().int().min(0).optional() },
    async run(args, ctx) {
      const { case: hint, ...query } = args;
      return report('Уведомления.', await ctx.api.get('/notifications', body({ ...query, case_id: hint ? (await ctx.resolveCase(hint)).id : undefined })));
    } }),
  tool({ name: 'notifications_summary', title: 'Непрочитанные уведомления', kind: 'read',
    description: 'Точный общий счётчик личной ленты.', input: {}, async run(_args, ctx) {
      return report('Счётчик.', await ctx.api.get('/notifications/summary'));
    } }),
  tool({ name: 'notifications_filters', title: 'Виды уведомлений и отбор', kind: 'read',
    description: 'Каталог видов, дел, уровней, числа записей и срок хранения.', input: {}, async run(_args, ctx) {
      return report('Отбор уведомлений.', await ctx.api.get('/notifications/filters'));
    } }),
  tool({ name: 'notifications_read', title: 'Отметить уведомления прочитанными', kind: 'write',
    description: 'Укажите ids или all=true. Параметр case ограничивает массовое прочтение одним делом.',
    input: { case: caseField, ids: z.array(z.uuid()).min(1).optional(), all: z.boolean().optional() }, async run(args, ctx) {
      if (args.ids && args.all === true) throw new ApiError(400, 'ambiguous_selection', 'Не передавайте ids и all=true вместе.');
      if (!args.ids?.length && args.all !== true) throw new ApiError(400, 'selection_required', 'Укажите ids или all=true.');
      return report('Уведомления прочитаны.', await ctx.api.post('/notifications/read', body({ ids: args.ids, all: args.all,
        case_id: args.case ? (await ctx.resolveCase(args.case)).id : undefined })));
    } }),
  tool({ name: 'notifications_settings', title: 'Настройки уведомлений', kind: 'read',
    description: 'Полный каталог видов и текущие флаги доставки.', input: {}, async run(_args, ctx) {
      return report('Настройки уведомлений.', await ctx.api.get('/notifications/settings'));
    } }),
  tool({ name: 'notifications_settings_save', title: 'Настроить уведомления', kind: 'write',
    description: 'Меняет флаги указанных видов; остальные настройки сохраняются. replace=true заменяет всю карту и сбрасывает пропущенные виды к серверным значениям.',
    input: { kinds: z.record(z.string(), z.boolean()), replace: z.boolean().optional() }, async run(args, ctx) {
      const previous = args.replace ? [] : (await ctx.api.get<{ kinds: { kind: string; enabled: boolean }[] }>('/notifications/settings')).kinds;
      const kinds = { ...Object.fromEntries(previous.map(item => [item.kind, item.enabled])), ...args.kinds };
      return report('Настройки сохранены.', await ctx.api.put('/notifications/settings', { kinds }));
    } }),
];
