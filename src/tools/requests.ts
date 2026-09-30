/** Заявки и маршруты работы: ревизии передаёт вызывающий, конфликты решает панель. */
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { raw, report } from '../format.js';
import { body, caseField, tool, type Tool } from './kit.js';

const id = z.string().uuid();
const revision = z.number().int().min(1);
const data = z.record(z.string(), z.unknown());
const dueAt = z.iso.datetime({ offset: true });
const position = z.object({ x: z.number(), y: z.number() }).strict();
const step = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['task', 'decision', 'result']).optional(),
  mode: z.enum(['manual', 'automatic', 'wait']).optional(),
  description: z.string().optional(),
  assignee_id: id.nullable().optional(),
  due_hours: z.number().positive().max(87600).nullable().optional(),
  required_fields: z.array(z.string()).optional(),
  outcomes: z.array(z.string()).optional(),
  join: z.enum(['all', 'any']).optional(),
  result: z.string().nullable().optional(),
  condition_field: z.string().nullable().optional(),
  condition_value: z.unknown().optional(),
  position: position.nullable().optional(),
}).strict();
const workflow = z.object({
  steps: z.array(step).min(1).max(100),
  edges: z.array(z.object({
    from: z.string(), to: z.string(), outcome: z.string().nullable().optional(),
  }).strict()).max(500),
}).strict().describe('Маршрут целиком: steps и edges; from/to ссылаются на id шагов.');
const field = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(80),
  label: z.string().trim().min(1).max(200),
  required: z.boolean().optional(),
  type: z.enum(['text', 'number', 'date', 'select']).optional(),
  options: z.array(z.string()).optional(),
}).strict();

export const requestTools: Tool[] = [
  tool({
    name: 'requests_list', title: 'Заявки дела', kind: 'read',
    description: 'Заявки с полным маршрутом, задачами, событиями и revision для последующей правки. ' +
      'Связи с диалогами и контрагентами панель показывает только при наличии соответствующих прав.',
    input: {
      case: caseField,
      search: z.string().max(200).optional(),
      status: z.enum(['new', 'in_progress', 'waiting', 'completed', 'cancelled']).optional(),
      mine: z.boolean().optional().describe('Только назначенные вам заявки.'),
      overdue: z.boolean().optional(),
      counterparty_id: id.optional(),
      dialog_id: id.optional(),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const rows = await ctx.api.get<unknown[]>(`/cases/${found.id}/requests`, body({
        search: args.search, status: args.status, mine: args.mine, overdue: args.overdue,
        counterparty_id: args.counterparty_id, dialog_id: args.dialog_id,
      }));
      return report(`Заявок в деле «${found.name}»: ${rows.length}`, raw(rows));
    },
  }),
  tool({
    name: 'requests_get', title: 'Открыть заявку', kind: 'read',
    description: 'Заявка целиком, включая поля, маршрут, задачи, события и текущую revision.',
    input: { case: caseField, request_id: id.describe('UUID заявки из requests_list.') },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Заявка.', raw(await ctx.api.get(`/cases/${found.id}/requests/${args.request_id}`)));
    },
  }),
  tool({
    name: 'requests_save', title: 'Создать или изменить заявку', kind: 'write',
    description: 'Без request_id создаёт заявку. Для правки обязательна revision из прочитанной карточки; ' +
      'передавайте только изменяемые поля. data дополняет прежние значения. assignee_id=null и ' +
      'due_at=null снимают назначение и срок. Тип и исходные связи задаются только при создании.',
    input: {
      case: caseField, request_id: id.optional(), revision: revision.optional(),
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().optional(),
      type_id: id.nullable().optional(),
      counterparty_id: id.nullable().optional(),
      dialog_id: id.nullable().optional(),
      source_message_id: id.nullable().optional(),
      assignee_id: id.nullable().optional(),
      due_at: dueAt.nullable().optional().describe('ISO 8601 с часовым поясом; null снимает срок.'),
      data: data.optional(),
    },
    async run(args, ctx) {
      const createOnly = body({ type_id: args.type_id, counterparty_id: args.counterparty_id,
        dialog_id: args.dialog_id, source_message_id: args.source_message_id });
      if (args.request_id) {
        if (args.revision === undefined) throw new ApiError(400, 'revision_required', 'Для правки нужна revision из requests_get.');
        if (Object.keys(createOnly).length) throw new ApiError(400, 'create_only_fields',
          `Только при создании: ${Object.keys(createOnly).join(', ')}.`);
      } else if (!args.title) {
        throw new ApiError(400, 'title_required', 'Для создания заявки нужно title.');
      }
      const found = await ctx.resolveCase(args.case);
      const payload = body({ title: args.title, description: args.description,
        assignee_id: args.assignee_id, due_at: args.due_at, data: args.data });
      const root = `/cases/${found.id}/requests`;
      const saved = args.request_id
        ? await ctx.api.patch(`${root}/${args.request_id}`, { revision: args.revision, ...payload })
        : await ctx.api.post(root, { ...payload, ...createOnly });
      return report('Заявка сохранена.', raw(saved));
    },
  }),
  tool({
    name: 'requests_delete', title: 'Удалить заявку', kind: 'danger',
    description: 'Удаляет заявку вместе с историей. Нужны текущая revision и точное название для подтверждения.',
    input: { case: caseField, request_id: id, revision,
      confirm_name: z.string().describe('Название заявки дословно.') },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const path = `/cases/${found.id}/requests/${args.request_id}`;
      const current = await ctx.api.get<{ title: string }>(path);
      if (args.confirm_name !== current.title) throw new ApiError(400, 'confirmation_mismatch', 'Подтверждение не совпадает с названием заявки.');
      await ctx.api.delete(path, { revision: args.revision });
      return `Заявка «${current.title}» удалена.`;
    },
  }),
  tool({
    name: 'requests_types_list', title: 'Типы заявок', kind: 'read',
    description: 'Типы заявок с полями, маршрутами и version для правки или удаления.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Типы заявок.', raw(await ctx.api.get(`/cases/${found.id}/requests/types`)));
    },
  }),
  tool({
    name: 'requests_types_save', title: 'Создать или изменить тип заявок', kind: 'write',
    description: 'Сохраняет полное определение типа: name, description, fields и workflow. ' +
      'При изменении обязательна version из requests_types_list; пропущенные description и fields ' +
      'станут пустыми. Проверки маршрута и прав на участников выполняет панель.',
    input: {
      case: caseField, type_id: id.optional(), version: revision.optional(),
      name: z.string().trim().min(1).max(200), description: z.string().optional(),
      fields: z.array(field).max(100).optional(), workflow,
    },
    async run(args, ctx) {
      if (args.type_id && args.version === undefined) throw new ApiError(400, 'version_required', 'Для правки типа нужна version из requests_types_list.');
      const found = await ctx.resolveCase(args.case);
      const root = `/cases/${found.id}/requests/types`;
      const payload = body({ name: args.name, description: args.description, fields: args.fields,
        workflow: args.workflow });
      const saved = args.type_id
        ? await ctx.api.patch(`${root}/${args.type_id}`, { ...payload, version: args.version })
        : await ctx.api.post(root, payload);
      return report('Тип заявок сохранён.', raw(saved));
    },
  }),
  tool({
    name: 'requests_types_delete', title: 'Удалить тип заявок', kind: 'danger',
    description: 'Удаляет тип по UUID, version и дословному названию. Снимки уже созданных заявок сохраняются.',
    input: { case: caseField, type_id: id, version: revision, confirm_name: z.string() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const root = `/cases/${found.id}/requests/types`;
      const types = await ctx.api.get<{ id: string; name: string }[]>(root);
      const current = types.find((item) => item.id === args.type_id);
      if (!current) throw new ApiError(404, 'request_type_not_found', 'Тип заявок не найден.');
      if (args.confirm_name !== current.name) throw new ApiError(400, 'confirmation_mismatch', 'Подтверждение не совпадает с названием типа заявок.');
      await ctx.api.delete(`${root}/${args.type_id}`, { version: args.version });
      return `Тип заявок «${current.name}» удалён.`;
    },
  }),
  tool({
    name: 'requests_tasks_list', title: 'Мои задачи по заявкам', kind: 'read',
    description: 'Готовые к выполнению задачи активных заявок, назначенные вам. ' +
      'Для выполнения прочитайте requests_get и передайте актуальную revision.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Мои задачи по заявкам.', raw(await ctx.api.get(`/cases/${found.id}/requests/tasks`)));
    },
  }),
  tool({
    name: 'requests_task_complete', title: 'Выполнить задачу заявки', kind: 'write',
    description: 'Завершает задачу по её UUID; outcome выбирают из outcomes карточки, data содержит значения полей. ' +
      'Обязательна revision заявки. Автоматические задачи вручную завершать нельзя.',
    input: { case: caseField, request_id: id, task_id: id, revision,
      outcome: z.string().nullable().optional(), data: data.optional() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Задача выполнена.', raw(await ctx.api.post(
        `/cases/${found.id}/requests/${args.request_id}/tasks/${args.task_id}/complete`,
        body({ revision: args.revision, outcome: args.outcome, data: args.data }),
      )));
    },
  }),
  tool({
    name: 'requests_comment', title: 'Добавить комментарий к заявке', kind: 'write',
    description: 'Добавляет текст в историю заявки. Комментарий не требует revision.',
    input: { case: caseField, request_id: id, text: z.string().trim().min(1).max(10000) },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Комментарий добавлен.', raw(await ctx.api.post(
        `/cases/${found.id}/requests/${args.request_id}/comments`, { text: args.text },
      )));
    },
  }),
  tool({
    name: 'requests_workflow', title: 'Изменить маршрут заявки', kind: 'write',
    description: 'Заменяет workflow заявки целиком с проверкой переданной revision. Нужны права request.manage.',
    input: { case: caseField, request_id: id, revision, workflow },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Маршрут заявки обновлён.', raw(await ctx.api.put(
        `/cases/${found.id}/requests/${args.request_id}/workflow`,
        { revision: args.revision, workflow: args.workflow },
      )));
    },
  }),
  tool({
    name: 'requests_cancel', title: 'Отменить заявку', kind: 'danger',
    description: 'Отменяет заявку и пропускает её незавершённые задачи. Нужны revision и явная причина.',
    input: { case: caseField, request_id: id, revision, reason: z.string().trim().min(1).max(2000) },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Заявка отменена.', raw(await ctx.api.post(
        `/cases/${found.id}/requests/${args.request_id}/cancel`,
        { revision: args.revision, reason: args.reason },
      )));
    },
  }),
];
