/** Контрагенты и явные связи с диалогами; права и сопоставление проверяет панель. */
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { raw, report } from '../format.js';
import { body, caseField, tool, type Tool } from './kit.js';

const id = z.string().uuid();
const fields = {
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().max(80).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  custom_fields: z.record(
    z.string().max(120).refine((key) => Boolean(key.trim()), 'Ключ не должен быть пустым.'),
    z.string().max(4000),
  ).refine((values) => Object.keys(values).length <= 50, 'Не более 50 полей.').optional(),
};

export const counterpartyTools: Tool[] = [
  tool({
    name: 'counterparties_list', title: 'Контрагенты дела', kind: 'read',
    description: 'Контрагенты с контактами, заметками, дополнительными полями и доступными связанными диалогами.',
    input: { case: caseField, search: z.string().max(200).optional() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const rows = await ctx.api.get<unknown[]>(`/cases/${found.id}/counterparties`, body({ search: args.search }));
      return report(`Контрагентов в деле «${found.name}»: ${rows.length}`, raw(rows));
    },
  }),
  tool({
    name: 'counterparties_get', title: 'Открыть контрагента', kind: 'read',
    description: 'Карточка контрагента по UUID из counterparties_list. Диалоги видны только с правом chat.view.',
    input: { case: caseField, counterparty_id: id },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Контрагент.', raw(await ctx.api.get(`/cases/${found.id}/counterparties/${args.counterparty_id}`)));
    },
  }),
  tool({
    name: 'counterparties_save', title: 'Создать или изменить контрагента', kind: 'write',
    description: 'Без counterparty_id создаёт карточку; для создания нужно name, dialog_ids содержит явно выбранные UUID. ' +
      'При правке передавайте только изменённые поля; null очищает контакт, custom_fields заменяет карту целиком. ' +
      'Связи существующей карточки меняют через counterparties_link/unlink.',
    input: { case: caseField, counterparty_id: id.optional(), ...fields,
      dialog_ids: z.array(id).max(200).optional() },
    async run(args, ctx) {
      if (args.counterparty_id && args.dialog_ids !== undefined) throw new ApiError(400, 'create_only_field',
        'dialog_ids задаётся только при создании; связи правят через counterparties_link/unlink.');
      if (!args.counterparty_id && !args.name) throw new ApiError(400, 'name_required', 'Для создания контрагента нужно name.');
      const found = await ctx.resolveCase(args.case);
      const root = `/cases/${found.id}/counterparties`;
      const payload = body({ name: args.name, phone: args.phone, email: args.email, company: args.company,
        notes: args.notes, custom_fields: args.custom_fields });
      const saved = args.counterparty_id
        ? await ctx.api.patch(`${root}/${args.counterparty_id}`, payload)
        : await ctx.api.post(root, body({ ...payload, dialog_ids: args.dialog_ids }));
      return report('Контрагент сохранён.', raw(saved));
    },
  }),
  tool({
    name: 'counterparties_delete', title: 'Удалить контрагента', kind: 'danger',
    description: 'Удаляет карточку и снимает её связи с диалогами. Нужно дословное name для подтверждения.',
    input: { case: caseField, counterparty_id: id, confirm_name: z.string() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const path = `/cases/${found.id}/counterparties/${args.counterparty_id}`;
      const current = await ctx.api.get<{ name: string }>(path);
      if (args.confirm_name !== current.name) throw new ApiError(400, 'confirmation_mismatch', 'Подтверждение не совпадает с названием контрагента.');
      await ctx.api.delete(path);
      return `Контрагент «${current.name}» удалён.`;
    },
  }),
  tool({
    name: 'counterparties_settings', title: 'Настройки сопоставления контрагентов', kind: 'read',
    description: 'Ручной или автоматический режим, критерии и переменные для сопоставления диалогов.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Настройки сопоставления.', raw(await ctx.api.get(`/cases/${found.id}/counterparties/settings`)));
    },
  }),
  tool({
    name: 'counterparties_settings_save', title: 'Изменить сопоставление контрагентов', kind: 'write',
    description: 'Меняет только переданные настройки. В automatic нужен хотя бы один критерий; ' +
      'с включённым сопоставлением телефона или почты соответствующая переменная не должна быть пустой. ' +
      'Для обработки имеющихся диалогов вызовите counterparties_reconcile.',
    input: {
      case: caseField, mode: z.enum(['manual', 'automatic']).optional(),
      match_platform_id: z.boolean().optional(), match_phone: z.boolean().optional(),
      match_email: z.boolean().optional(), phone_variable: z.string().max(64).optional(),
      email_variable: z.string().max(64).optional(), create_unmatched: z.boolean().optional(),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const payload = body({ mode: args.mode, match_platform_id: args.match_platform_id,
        match_phone: args.match_phone, match_email: args.match_email,
        phone_variable: args.phone_variable, email_variable: args.email_variable,
        create_unmatched: args.create_unmatched });
      if (!Object.keys(payload).length) return 'Нечего менять: не передано ни одного поля.';
      return report('Настройки сопоставления сохранены.', raw(await ctx.api.patch(
        `/cases/${found.id}/counterparties/settings`, payload,
      )));
    },
  }),
  tool({
    name: 'counterparties_dialogs', title: 'Диалоги и их контрагенты', kind: 'read',
    description: 'Без dialog_id показывает доступные диалоги для связывания с карточкой. ' +
      'С dialog_id возвращает связанного контрагента либо сообщает, что связи нет. Нужны права chat.view.',
    input: { case: caseField, search: z.string().max(200).optional(), dialog_id: id.optional() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const root = `/cases/${found.id}/counterparties/dialogs`;
      if (args.dialog_id) {
        const linked = await ctx.api.get(`${root}/${args.dialog_id}`);
        return linked === null ? 'Диалог не связан с контрагентом.' : report('Контрагент диалога.', raw(linked));
      }
      return report('Диалоги для связывания.', raw(await ctx.api.get(root, body({ search: args.search }))));
    },
  }),
  tool({
    name: 'counterparties_link', title: 'Связать диалог с контрагентом', kind: 'write',
    description: 'Связывает один явно указанный dialog_id с карточкой. Для переноса из другой карточки ' +
      'нужно явно передать её UUID в replace_counterparty_id; панель отклонит несовпавшую прежнюю связь.',
    input: { case: caseField, counterparty_id: id, dialog_id: id, replace_counterparty_id: id.optional() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Диалог связан с контрагентом.', raw(await ctx.api.put(
        `/cases/${found.id}/counterparties/${args.counterparty_id}/dialogs/${args.dialog_id}`,
        undefined, body({ replace_counterparty_id: args.replace_counterparty_id }),
      )));
    },
  }),
  tool({
    name: 'counterparties_unlink', title: 'Снять связь диалога с контрагентом', kind: 'write',
    description: 'Снимает только явно указанную связь; карточка и переписка сохраняются.',
    input: { case: caseField, counterparty_id: id, dialog_id: id },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Связь диалога снята.', raw(await ctx.api.delete(
        `/cases/${found.id}/counterparties/${args.counterparty_id}/dialogs/${args.dialog_id}`,
      )));
    },
  }),
  tool({
    name: 'counterparties_reconcile', title: 'Сопоставить имеющиеся диалоги', kind: 'write',
    description: 'Запускает серверное автоматическое сопоставление по текущим настройкам, ' +
      'возвращает linked/created/skipped. Ручные связи учитывает сама панель.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Диалоги сопоставлены.', raw(await ctx.api.post(`/cases/${found.id}/counterparties/reconcile`)));
    },
  }),
];
