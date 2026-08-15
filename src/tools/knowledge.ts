/**
 * База знаний: материалы, по которым модель отвечает вместо выдумывания.
 *
 * Материал попадает в базу не сразу: текст режется на куски и
 * векторизуется в фоне, поэтому у документа есть состояние
 * (pending → indexing → ready) и его стоит перепроверить после добавления.
 */

import { z } from 'zod';

import type { Context } from '../context.js';
import { ApiError } from '../errors.js';
import { report } from '../format.js';
import { caseField, body, tool, type Tool } from './kit.js';
import { findProvider } from './bots.js';

interface Base {
  id: string;
  name: string;
  description: string | null;
  provider_id: string | null;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  min_score: number;
  is_active: boolean;
  documents_count: number;
  chunks_count: number;
  ready_count: number;
}

interface Document {
  id: string;
  title: string;
  source: string;
  source_url: string | null;
  status: string;
  error: string | null;
  chunks_count: number;
  chars: number;
  indexed_at: string | null;
  created_at: string;
}

interface DocumentDetail extends Document {
  content: string;
  chunks: { ordinal: number; text: string }[];
}

async function findDocument(
  ctx: Context,
  caseId: string,
  baseId: string,
  hint: string,
): Promise<Document> {
  const list = await ctx.api.get<Document[]>(`/cases/${caseId}/knowledge/${baseId}/documents`);
  const needle = hint.trim().toLowerCase();

  const match =
    list.find((item) => item.id === hint) ??
    list.find((item) => item.title.toLowerCase() === needle) ??
    list.find((item) => item.title.toLowerCase().includes(needle));

  if (!match) {
    throw new ApiError(
      404,
      'document_not_found',
      `Материала «${hint}» в базе нет. Есть: ${list.map((item) => item.title).join(', ') || 'ни одного'}`,
    );
  }
  return match;
}

async function findBase(ctx: Context, caseId: string, hint: string): Promise<Base> {
  const list = await ctx.api.get<Base[]>(`/cases/${caseId}/knowledge`);
  const needle = hint.trim().toLowerCase();

  const match =
    list.find((item) => item.id === hint) ??
    list.find((item) => item.name.toLowerCase() === needle) ??
    list.find((item) => item.name.toLowerCase().includes(needle));

  if (!match) {
    throw new ApiError(
      404,
      'base_not_found',
      `Базы знаний «${hint}» нет в деле. Есть: ${list.map((item) => item.name).join(', ') || 'ни одной'}`,
    );
  }
  return match;
}

const showBase = (base: Base) => ({
  база: base.name,
  идентификатор: base.id,
  описание: base.description,
  включена: base.is_active,
  подключение_ии: base.provider_id,
  модель_векторов: base.embedding_model || 'не задана — поиск работать не будет',
  материалов: base.documents_count,
  разобрано: `${base.ready_count} из ${base.documents_count}`,
  фрагментов: base.chunks_count,
  размер_куска: base.chunk_size,
  нахлёст: base.chunk_overlap,
  фрагментов_в_ответе: base.top_k,
  порог_близости: base.min_score,
});

export const knowledgeTools: Tool[] = [
  tool({
    name: 'knowledge_list',
    title: 'Базы знаний',
    kind: 'read',
    description:
      'Без параметра base — все базы знаний дела с их настройками. С параметром base — ' +
      'ещё и список материалов с состоянием разбора.',
    input: {
      case: caseField,
      base: z.string().optional().describe('База знаний: название или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);

      if (!args.base) {
        const list = await ctx.api.get<Base[]>(`/cases/${found.id}/knowledge`);
        return report(`Баз знаний в деле «${found.name}»: ${list.length}`, list.map(showBase));
      }

      const base = await findBase(ctx, found.id, args.base);
      const documents = await ctx.api.get<Document[]>(
        `/cases/${found.id}/knowledge/${base.id}/documents`,
      );

      return report(`База знаний «${base.name}»`, {
        ...showBase(base),
        материалы:
          documents.length === 0
            ? 'пусто'
            : documents.map((item) => ({
                материал: item.title,
                идентификатор: item.id,
                откуда: item.source_url ?? item.source,
                состояние: item.status,
                ошибка: item.error,
                фрагментов: item.chunks_count,
                символов: item.chars,
                разобран: item.indexed_at,
              })),
      });
    },
  }),

  tool({
    name: 'knowledge_save',
    title: 'Создать или настроить базу знаний',
    kind: 'write',
    description:
      'Без параметра base создаёт базу, с параметром — меняет её настройки. Для поиска базе ' +
      'нужно подключение к ИИ-сервису, умеющему считать векторы. Подключение можно сменить ' +
      'только у пустой базы: векторы разных моделей несопоставимы. После правки размера куска ' +
      'старые материалы нужно пересобрать через knowledge_reindex.',
    input: {
      case: caseField,
      base: z.string().optional().describe('Какую базу менять. Не указывайте, чтобы создать новую.'),
      name: z.string().min(1).max(120).optional().describe('Название базы.'),
      description: z.string().max(2000).optional().describe('Для чего она.'),
      provider: z
        .string()
        .optional()
        .describe('Подключение к ИИ-сервису для векторов: название или идентификатор.'),
      chunk_size: z
        .number()
        .int()
        .min(200)
        .max(4000)
        .optional()
        .describe('Размер куска в символах. По умолчанию 900.'),
      chunk_overlap: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe('Нахлёст между кусками. По умолчанию 120.'),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Сколько фрагментов подмешивать в ответ. По умолчанию 4.'),
      min_score: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Порог близости: ниже него фрагмент не берётся. По умолчанию 0.25.'),
      active: z.boolean().optional().describe('Включена ли база. Выключенная не ищет.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const provider = args.provider ? await findProvider(ctx, found.id, args.provider) : null;

      const payload = body({
        name: args.name,
        description: args.description,
        provider_id: provider?.id,
        chunk_size: args.chunk_size,
        chunk_overlap: args.chunk_overlap,
        top_k: args.top_k,
        min_score: args.min_score,
        is_active: args.active,
      });

      if (!args.base) {
        if (!args.name) return 'Чтобы создать базу знаний, нужно название.';
        const created = await ctx.api.post<Base>(`/cases/${found.id}/knowledge`, payload);
        return report('База знаний создана.', {
          ...showBase(created),
          дальше: 'Добавьте материалы: knowledge_add_document.',
        });
      }

      const base = await findBase(ctx, found.id, args.base);
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const updated = await ctx.api.patch<Base>(
        `/cases/${found.id}/knowledge/${base.id}`,
        payload,
      );
      return report('База знаний обновлена.', showBase(updated));
    },
  }),

  tool({
    name: 'knowledge_add_document',
    title: 'Добавить материал',
    kind: 'write',
    description:
      'Кладёт в базу текст или страницу по ссылке. Разбор идёт в фоне: сразу после добавления ' +
      'материал в состоянии pending, проверьте его позже через knowledge_list. Повторный вызов ' +
      'создаёт дубликат, а не обновляет прежний материал.',
    input: {
      case: caseField,
      base: z.string().describe('База знаний: название или идентификатор.'),
      title: z.string().max(240).optional().describe('Название материала.'),
      text: z.string().optional().describe('Текст материала. Нужен, если ссылка не задана.'),
      url: z
        .string()
        .max(2000)
        .optional()
        .describe('Ссылка на страницу: панель скачает её и вырежет разметку.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const base = await findBase(ctx, found.id, args.base);

      if (!args.text && !args.url) return 'Нужен либо текст материала, либо ссылка на страницу.';

      const document = await ctx.api.post<Document>(
        `/cases/${found.id}/knowledge/${base.id}/documents`,
        body({
          title: args.title,
          source: args.url ? 'url' : 'text',
          content: args.text ?? '',
          url: args.url,
        }),
      );

      return report(`Материал добавлен в базу «${base.name}».`, {
        материал: document.title,
        идентификатор: document.id,
        состояние: document.status,
        подсказка: 'Разбор идёт в фоне — проверьте состояние через knowledge_list.',
      });
    },
  }),

  tool({
    name: 'knowledge_document',
    title: 'Материал целиком',
    kind: 'read',
    description:
      'Материал с его текстом: что в нём написано на самом деле. Список материалов текста не ' +
      'отдаёт. Материал можно назвать по имени — идентификатор не обязателен. С chunks=true ' +
      'вдобавок покажет нарезку: те самые куски, которыми материал ляжет модели.',
    input: {
      case: caseField,
      base: z.string().describe('База знаний: название или идентификатор.'),
      document: z.string().describe('Материал: название или идентификатор.'),
      chunks: z
        .boolean()
        .optional()
        .describe('Показать куски. По умолчанию нет: они повторяют текст и удваивают ответ.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const base = await findBase(ctx, found.id, args.base);
      const brief = await findDocument(ctx, found.id, base.id, args.document);

      const document = await ctx.api.get<DocumentDetail>(
        `/cases/${found.id}/knowledge/${base.id}/documents/${brief.id}`,
      );

      return report(`Материал «${document.title}» из базы «${base.name}»`, {
        материал: document.title,
        идентификатор: document.id,
        откуда: document.source_url ?? document.source,
        состояние: document.status,
        ошибка: document.error,
        символов: document.chars,
        фрагментов: document.chunks_count,
        разобран: document.indexed_at,
        текст: document.content,
        ...(args.chunks
          ? {
              нарезка: document.chunks.map((chunk) => ({
                номер: chunk.ordinal + 1,
                символов: chunk.text.length,
                текст: chunk.text,
              })),
            }
          : {}),
      });
    },
  }),

  tool({
    name: 'knowledge_document_update',
    title: 'Изменить материал',
    kind: 'write',
    description:
      'Правит название и текст материала. Изменённый текст сам уходит на пересборку — иначе ' +
      'бот отвечал бы по прежней нарезке. Вид источника и ссылку сменить нельзя: это уже другой ' +
      'материал. Для материала по ссылке refetch=true перечитывает страницу заново — страница ' +
      'забирается один раз, при добавлении, и дальше живёт снимком.',
    input: {
      case: caseField,
      base: z.string().describe('База знаний: название или идентификатор.'),
      document: z.string().describe('Материал: название или идентификатор.'),
      title: z.string().max(240).optional().describe('Новое название.'),
      text: z.string().optional().describe('Новый текст целиком — заменяет прежний.'),
      refetch: z
        .boolean()
        .optional()
        .describe('Перечитать страницу по ссылке. Только для материала-ссылки.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const base = await findBase(ctx, found.id, args.base);
      const brief = await findDocument(ctx, found.id, base.id, args.document);
      const root = `/cases/${found.id}/knowledge/${base.id}/documents/${brief.id}`;

      if (args.refetch) {
        const updated = await ctx.api.post<DocumentDetail>(`${root}/refetch`);
        return report(`Страница перечитана, материал «${updated.title}» разбирается заново.`, {
          символов: updated.chars,
          состояние: updated.status,
        });
      }

      const payload = body({ title: args.title, content: args.text });
      if (Object.keys(payload).length === 0) {
        return 'Нечего менять: передайте название, текст или refetch=true.';
      }

      const updated = await ctx.api.patch<DocumentDetail>(root, payload);
      return report(`Материал «${updated.title}» изменён.`, {
        символов: updated.chars,
        состояние: updated.status,
        подсказка:
          updated.status === 'ready'
            ? undefined
            : 'Текст изменился — разбор идёт в фоне, проверьте позже.',
      });
    },
  }),

  tool({
    name: 'knowledge_reindex',
    title: 'Пересобрать материалы',
    kind: 'write',
    description:
      'Ставит материалы в очередь на повторный разбор. Нужно после смены размера куска или ' +
      'подключения к ИИ-сервису: старые фрагменты нарезаны по-прежнему. Без параметра document ' +
      'пересобирается вся база.',
    input: {
      case: caseField,
      base: z.string().describe('База знаний: название или идентификатор.'),
      document: z.string().optional().describe('Один материал: название или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const base = await findBase(ctx, found.id, args.base);
      const root = `/cases/${found.id}/knowledge/${base.id}`;

      const one = args.document
        ? await findDocument(ctx, found.id, base.id, args.document)
        : null;

      const result = one
        ? await ctx.api.post<{ message?: string }>(`${root}/documents/${one.id}/reindex`)
        : await ctx.api.post<{ message?: string }>(`${root}/reindex`);

      return result.message ?? 'Материалы поставлены в очередь на разбор.';
    },
  }),

  tool({
    name: 'knowledge_search',
    title: 'Проверить поиск по базе',
    kind: 'read',
    description:
      'Показывает, какие фрагменты база подставит модели в ответ на такой вопрос. Так проверяют, ' +
      'что материалы разобраны и порог близости выбран верно. Если база выключена или векторы ' +
      'не считаются, ответ будет пустым без ошибки.',
    input: {
      case: caseField,
      base: z.string().describe('База знаний: название или идентификатор.'),
      question: z.string().min(1).max(2000).describe('Вопрос, как его задал бы человек.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Сколько фрагментов вернуть. По умолчанию 4.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const base = await findBase(ctx, found.id, args.base);

      const result = await ctx.api.post<{ found: string[]; message: string | null }>(
        `/cases/${found.id}/knowledge/${base.id}/search`,
        body({ question: args.question, limit: args.limit }),
      );

      if (result.found.length === 0) {
        return (
          `По вопросу «${args.question}» база «${base.name}» ничего не нашла. ` +
          (result.message ?? '') +
          '\nПроверьте: разобраны ли материалы, включена ли база, не слишком ли высок порог близости.'
        );
      }

      return report(`Найдено фрагментов: ${result.found.length}`, result.found);
    },
  }),

  tool({
    name: 'knowledge_delete',
    title: 'Удалить базу или материал',
    kind: 'danger',
    description:
      'С параметром document удаляет один материал, без него — базу знаний целиком вместе ' +
      'со всеми материалами и векторами. Восстановить нельзя.',
    input: {
      case: caseField,
      base: z.string().describe('База знаний: название или идентификатор.'),
      document: z
        .string()
        .optional()
        .describe('Материал: название или идентификатор. Без него удалится вся база.'),
      confirm_name: z
        .string()
        .optional()
        .describe('Точное название базы — обязательно при удалении базы целиком.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const base = await findBase(ctx, found.id, args.base);
      const root = `/cases/${found.id}/knowledge/${base.id}`;

      if (args.document) {
        const one = await findDocument(ctx, found.id, base.id, args.document);
        await ctx.api.delete(`${root}/documents/${one.id}`);
        return `Материал «${one.title}» удалён из базы «${base.name}».`;
      }

      if (args.confirm_name?.trim() !== base.name) {
        return (
          `Не удаляю базу целиком: нужно подтверждение — точное название «${base.name}» ` +
          'в параметре confirm_name. Чтобы удалить один материал, передайте document.'
        );
      }

      await ctx.api.delete(root);
      return `База знаний «${base.name}» удалена вместе с ${base.documents_count} материалами.`;
    },
  }),
];
