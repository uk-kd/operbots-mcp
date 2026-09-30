/** Подключения внешних систем, их операции и входящие события. */
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { raw, report } from '../format.js';
import { body, caseField, tool, type Tool } from './kit.js';

const clean = z.string().refine(value => !/[\r\n\0]/.test(value), 'Переносы строк запрещены.');
const serverUrl = z.string().refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname &&
      !url.username && !url.password && !url.search && !url.hash && !/[\\\s]/.test(value);
  } catch { return false; }
}, 'Нужен адрес HTTP(S) без логина, параметров и фрагмента.');
const pair = z.object({ key: clean.min(1).max(200), value: clean.optional(), secret: z.boolean().optional() }).strict();
const input = z.object({
  key: z.string().max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(value => value !== 'save_to'),
  label: z.string().optional(), kind: z.enum(['string', 'number', 'boolean', 'select', 'json']).optional(),
  required: z.boolean().optional(), default: z.unknown().optional(), hint: z.string().optional(),
  options: z.array(z.unknown()).optional(),
}).strict();
const operation = z.object({
  id: z.uuid().optional(), name: z.string().min(1).max(120),
  icon: z.string().max(64).regex(/^[A-Za-z0-9-]*$/).optional(), description: z.string().max(2000).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  path: z.string().refine(value => {
    try {
      const decoded = decodeURIComponent(value);
      return value.startsWith('/') && !value.startsWith('//') && !/[\\?#\x00-\x1f]/.test(decoded) && !decoded.split('/').includes('..');
    } catch { return false; }
  }, 'Нужен относительный путь без обхода каталогов.').optional(),
  headers: z.array(pair).max(100).optional(), query: z.array(pair).max(100).optional(),
  body_type: z.enum(['none', 'json', 'text', 'form']).optional(), body: z.string().max(100000).optional(),
  inputs: z.array(input).max(100).optional(), response_mapping: z.record(z.string(), z.string()).optional(),
}).strict();
const auth = z.object({
  type: z.enum(['none', 'basic', 'bearer', 'api_key', 'oauth2_client_credentials', 'oauth2_authorization_code']).optional(),
  username: z.string().optional(), password: z.string().optional(), token: z.string().optional(),
  key_name: z.string().optional(), key_location: z.enum(['header', 'query']).optional(),
  client_id: z.string().optional(), client_secret: z.string().optional(),
  token_url: z.union([z.literal(''), serverUrl]).optional(), authorization_url: z.union([z.literal(''), serverUrl]).optional(),
  scopes: z.string().optional(), client_auth: z.enum(['basic', 'body']).optional(),
}).strict();
const webhook = z.object({
  enabled: z.boolean().optional(), auth_type: z.enum(['token', 'hmac_sha256']).optional(),
  header_name: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
  timestamp_header: z.string().regex(/^[A-Za-z0-9-]*$/).optional(), delivery_header: z.string().regex(/^[A-Za-z0-9-]*$/).optional(),
  secret: z.string().optional(),
  events: z.array(z.object({
    id: z.uuid().optional(), name: z.string().min(1).max(120), icon: z.string().max(64).regex(/^[A-Za-z0-9-]*$/).optional(),
    description: z.string().optional(), filter_path: z.string().optional(), filter_value: z.string().optional(),
  }).strict()).max(100).optional(),
}).strict();
const fields = {
  name: z.string().min(1).max(120).optional(), description: z.string().max(2000).optional(),
  icon: z.string().max(64).optional(), accent: z.string().regex(/^(signal|sky|violet|amber|emerald|rose|slate|#[0-9a-fA-F]{6})$/).optional(),
  enabled: z.boolean().optional(), base_url: serverUrl.optional(), port: z.number().int().min(1).max(65535).nullable().optional(),
  timeout: z.number().min(1).max(60).optional(), auth: auth.optional(),
  headers: z.array(pair).max(100).optional(), query: z.array(pair).max(100).optional(),
  operations: z.array(operation).max(100).optional(), webhook: webhook.optional(),
  clear_secrets: z.array(z.string()).optional().describe('Ключи удаляемых секретов, например auth.token или headers.x-key. Пустые секреты при правке сохраняют прежнее значение.'),
};
const extensionField = z.uuid().describe('Идентификатор расширения из extensions_list.');
type Definition = { id: string; name: string; auth?: Record<string, unknown>; webhook?: Record<string, unknown>; [key: string]: unknown };

export const extensionTools: Tool[] = [
  tool({ name: 'extensions_list', title: 'Расширения дела', kind: 'read',
    description: 'Полные определения внешних подключений. Сохранённые секреты сервер возвращает пустыми.',
    input: { case: caseField }, async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Расширения.', raw(await ctx.api.get(`/cases/${found.id}/extensions`)));
    } }),
  tool({ name: 'extensions_get', title: 'Определение расширения', kind: 'read',
    description: 'Настройки, операции и события расширения с идентификаторами. Секреты скрыты.',
    input: { case: caseField, extension: extensionField }, async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Расширение.', raw(await ctx.api.get(`/cases/${found.id}/extensions/${args.extension}`)));
    } }),
  tool({ name: 'extensions_templates', title: 'Шаблоны расширений', kind: 'read',
    description: 'Готовые определения подключений для создания расширения.', input: { case: caseField }, async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Шаблоны.', raw(await ctx.api.get(`/cases/${found.id}/extensions/templates`)));
    } }),
  tool({ name: 'extensions_nodes', title: 'Узлы расширений', kind: 'read',
    description: 'Доступные этому делу динамические виды узлов extension и extension_trigger, поля и выходы для flows_save.',
    input: { case: caseField }, async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Узлы расширений.', raw(await ctx.api.get(`/cases/${found.id}/extensions/nodes`)));
    } }),
  tool({ name: 'extensions_save', title: 'Создать или настроить расширение', kind: 'write',
    description: 'Без extension создаёт подключение (нужны name и base_url). При правке сохраняет пропущенные поля, операции и события. Переданные массивы заменяют прежние целиком; сохраняйте идентификаторы используемых операций.',
    input: { case: caseField, extension: extensionField.optional(), ...fields }, async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const root = `/cases/${found.id}/extensions`;
      const { case: _, extension, ...changes } = args;
      if (!extension) {
        if (!args.name || !args.base_url) throw new ApiError(400, 'fields_required', 'Для создания расширения нужны name и base_url.');
        return report('Расширение создано.', raw(await ctx.api.post(root, body(changes))));
      }
      const previous = await ctx.api.get<Definition>(`${root}/${extension}`);
      const payload: Record<string, unknown> = {};
      for (const key of Object.keys(fields)) if (previous[key] !== undefined) payload[key] = previous[key];
      Object.assign(payload, body(changes));
      if (args.auth) payload.auth = { ...previous.auth, ...body(args.auth) };
      if (args.webhook) payload.webhook = { ...previous.webhook, ...body(args.webhook) };
      return report('Расширение обновлено.', raw(await ctx.api.put(`${root}/${extension}`, payload)));
    } }),
  tool({ name: 'extensions_oauth_begin', title: 'Авторизовать расширение через OAuth', kind: 'write',
    description: 'Создаёт ссылку OAuth с защищённым состоянием. Откройте её в браузере и завершите вход на стороне внешней системы.',
    input: { case: caseField, extension: extensionField }, async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Откройте ссылку для авторизации.', await ctx.api.post(`/cases/${found.id}/extensions/${args.extension}/oauth/begin`));
    } }),
  tool({ name: 'extensions_delete', title: 'Удалить расширение', kind: 'danger',
    description: 'Удаляет подключение с подтверждением точного названия. Сервер защищает операции, используемые сценариями.',
    input: { case: caseField, extension: extensionField, confirm_name: z.string() }, async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const path = `/cases/${found.id}/extensions/${args.extension}`;
      const previous = await ctx.api.get<Definition>(path);
      if (args.confirm_name !== previous.name) throw new ApiError(400, 'confirmation_required', `Введите точное название «${previous.name}».`);
      await ctx.api.delete(path);
      return `Расширение «${previous.name}» удалено.`;
    } }),
];
