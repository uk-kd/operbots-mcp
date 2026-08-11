/**
 * Каркас описания инструмента.
 *
 * Инструменты объявляются данными, а не обращениями к SDK: так их
 * можно пересчитать, отфильтровать по режиму «только чтение» и
 * зарегистрировать одним проходом в `server.ts`.
 */

import { z } from 'zod';

import type { Context } from '../context.js';

/**
 * read — ничего не меняет; write — меняет данные; danger — необратимо
 * или раскрывает секрет. Признак уходит в подсказки MCP, и клиент
 * спрашивает подтверждение на danger-инструментах.
 */
export type Kind = 'read' | 'write' | 'danger';

export interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  kind: Kind;
  run: (args: Record<string, unknown>, ctx: Context) => Promise<string>;
}

/** Объявляет инструмент, сохраняя вывод типов для аргументов. */
export function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  input: S;
  kind: Kind;
  run: (args: z.infer<z.ZodObject<S>>, ctx: Context) => Promise<string>;
}): Tool {
  return def as unknown as Tool;
}

// ── Часто повторяющиеся поля ─────────────────────────────────

export const caseField = z
  .string()
  .optional()
  .describe(
    'Дело: название или идентификатор. Если не указать, берётся дело по умолчанию, ' +
      'иначе последнее открытое в панели.',
  );

export const botField = z
  .string()
  .describe('Бот: название, @username или идентификатор.');

export const limitField = (max: number, fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Сколько записей вернуть, максимум ${max}. По умолчанию ${fallback}.`);

/** Убирает из объекта ключи со значением undefined — тело запроса. */
export function body<T extends Record<string, unknown>>(values: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<T>;
}

/**
 * Выполняет запрос, но не роняет весь инструмент, если у пользователя
 * нет права на этот кусок: сводные карточки собирают несколько
 * разделов, и отсутствие одного не должно скрывать остальные.
 */
export async function optional<T>(request: Promise<T>): Promise<T | string> {
  try {
    return await request;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `недоступно (${message})`;
  }
}
