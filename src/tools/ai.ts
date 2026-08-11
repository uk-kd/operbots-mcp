/**
 * Подключения к ИИ-сервисам: GigaChat, YandexGPT, OpenAI, OpenRouter
 * и любой сервер с интерфейсом OpenAI.
 *
 * Ключи шифруются в панели и наружу не отдаются — видна только маска
 * из последних символов.
 */

import { z } from 'zod';

import { AI_CREDENTIALS, AI_KINDS, AI_MODELS } from '../enums.js';
import { report } from '../format.js';
import { caseField, body, tool, type Tool } from './kit.js';
import { findProvider } from './bots.js';

interface Provider {
  id: string;
  name: string;
  kind: string;
  model: string;
  base_url: string | null;
  credentials_hint: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  history_depth: number;
  options: Record<string, unknown>;
  is_active: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  bots_count: number;
}

const show = (provider: Provider) => ({
  подключение: provider.name,
  идентификатор: provider.id,
  вид: provider.kind,
  модель: provider.model,
  адрес: provider.base_url,
  ключ: provider.credentials_hint || 'не задан',
  включено: provider.is_active,
  используют_ботов: provider.bots_count,
  температура: provider.temperature,
  предел_ответа: provider.max_tokens,
  глубина_истории: provider.history_depth,
  системная_подсказка: provider.system_prompt || undefined,
  настройки: Object.keys(provider.options ?? {}).length > 0 ? provider.options : undefined,
  проверено: provider.last_checked_at,
  последняя_ошибка: provider.last_error,
});

export const aiTools: Tool[] = [
  tool({
    name: 'ai_list',
    title: 'Подключения к ИИ-сервисам',
    kind: 'read',
    description:
      'Какие ИИ-сервисы подключены к делу, с какими моделями и сколько ботов их используют. ' +
      'Ключи не показываются — только последние символы.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const list = await ctx.api.get<Provider[]>(`/cases/${found.id}/ai-providers`);
      return report(`Подключений в деле «${found.name}»: ${list.length}`, list.map(show));
    },
  }),

  tool({
    name: 'ai_save',
    title: 'Подключить или настроить ИИ-сервис',
    kind: 'write',
    description:
      'Без параметра provider подключает новый сервис, с ним — меняет настройки. ' +
      `Какие ключи нужны: ${Object.entries(AI_CREDENTIALS)
        .map(([kind, keys]) => `${kind} — ${keys}`)
        .join('; ')}. ` +
      'При изменении переданные ключи дописываются поверх прежних, а стереть ключ пустой ' +
      'строкой нельзя — только перезаписать.',
    input: {
      case: caseField,
      provider: z
        .string()
        .optional()
        .describe('Какое подключение менять. Не указывайте, чтобы создать новое.'),
      name: z.string().min(1).max(120).optional().describe('Название подключения в панели.'),
      kind: z
        .enum(AI_KINDS)
        .optional()
        .describe('Вид сервиса. Обязателен при создании, сменить его потом нельзя.'),
      model: z
        .string()
        .max(120)
        .optional()
        .describe(
          `Модель. Известные: ${Object.entries(AI_MODELS)
            .map(([kind, models]) => `${kind} — ${models}`)
            .join('; ')}`,
        ),
      base_url: z
        .string()
        .max(400)
        .optional()
        .describe('Адрес сервера. Обязателен для вида custom.'),
      credentials: z
        .record(z.string(), z.string())
        .optional()
        .describe('Ключи доступа. Состав зависит от вида сервиса — см. описание инструмента.'),
      system_prompt: z
        .string()
        .optional()
        .describe('Постоянная подсказка модели: как себя вести и о чём говорить.'),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe('Разброс ответов: 0 — строго по делу, 2 — свободно. По умолчанию 0.7.'),
      max_tokens: z
        .number()
        .int()
        .min(16)
        .max(32000)
        .optional()
        .describe('Предел длины ответа. По умолчанию 1024.'),
      history_depth: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Сколько прошлых реплик подмешивать в запрос. По умолчанию 10.'),
      active: z.boolean().optional().describe('Включено ли подключение.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const payload = body({
        name: args.name,
        kind: args.kind,
        model: args.model,
        base_url: args.base_url,
        credentials: args.credentials,
        system_prompt: args.system_prompt,
        temperature: args.temperature,
        max_tokens: args.max_tokens,
        history_depth: args.history_depth,
        is_active: args.active,
      });

      if (!args.provider) {
        if (!args.name || !args.kind) {
          return 'Чтобы подключить ИИ-сервис, нужны название и вид сервиса (kind).';
        }
        const created = await ctx.api.post<Provider>(`/cases/${found.id}/ai-providers`, payload);
        return report('ИИ-сервис подключён.', {
          ...show(created),
          дальше: 'Проверьте живым запросом: ai_test.',
        });
      }

      const provider = await findProvider(ctx, found.id, args.provider);
      // kind сменить нельзя — панель такого поля при изменении не принимает.
      delete (payload as Record<string, unknown>).kind;
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const updated = await ctx.api.patch<Provider>(
        `/cases/${found.id}/ai-providers/${provider.id}`,
        payload,
      );
      return report('Подключение обновлено.', show(updated));
    },
  }),

  tool({
    name: 'ai_test',
    title: 'Проверить ИИ-сервис',
    kind: 'write',
    description:
      'Отправляет пробную реплику и показывает ответ модели или причину отказа. ' +
      'Это настоящий запрос к сервису: он расходует лимиты и может стоить денег.',
    input: {
      case: caseField,
      provider: z.string().describe('Подключение: название или идентификатор.'),
      prompt: z
        .string()
        .max(2000)
        .optional()
        .describe('Что спросить. По умолчанию — короткое приветствие.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const provider = await findProvider(ctx, found.id, args.provider);

      const result = await ctx.api.post<{
        ok: boolean;
        reply: string | null;
        error: string | null;
        latency_ms: number | null;
      }>(`/cases/${found.id}/ai-providers/${provider.id}/test`, body({ prompt: args.prompt }));

      if (!result.ok) {
        return report(`Подключение «${provider.name}» не отвечает.`, {
          ошибка: result.error,
          подсказка: 'Проверьте ключ, модель и, для своего сервера, адрес.',
        });
      }

      return report(`Подключение «${provider.name}» работает.`, {
        ответ: result.reply,
        задержка_мс: result.latency_ms,
      });
    },
  }),

  tool({
    name: 'ai_delete',
    title: 'Удалить подключение к ИИ',
    kind: 'danger',
    description:
      'Удаляет подключение вместе с сохранёнными ключами. Пока сервис используют боты, ' +
      'панель удалить его не даст — сначала отвяжите его от ботов.',
    input: {
      case: caseField,
      provider: z.string().describe('Подключение: название или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const provider = await findProvider(ctx, found.id, args.provider);
      await ctx.api.delete(`/cases/${found.id}/ai-providers/${provider.id}`);
      return `Подключение «${provider.name}» удалено вместе с ключами.`;
    },
  }),
];
