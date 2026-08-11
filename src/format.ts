/**
 * Вывод результатов инструментов.
 *
 * Модель читает текст, а не JSON-дамп: пустые поля выброшены,
 * вложенность обозначена отступами, длинные значения не обрезаны.
 * Такой вид короче JSON примерно вдвое и читается без разбора кавычек.
 */

/** Поля, которые ничего не добавляют модели и только занимают место. */
const NOISE = new Set(['avatar_url', 'initials', 'appearance', 'accent_hint']);

/** Ключи-секреты: их не показываем, даже если панель вернула значение. */
const SECRET = /token|secret|password|api_key/i;

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function scalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

/** Разворачивает значение в текст с отступами. */
export function render(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (isScalar(value)) return `${pad}${scalar(value)}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}—`;
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scalar(item)}`;
        const body = render(item, indent + 1).trimStart();
        return `${pad}- ${body}`;
      })
      .join('\n');
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key, item]) => !NOISE.has(key) && !isEmpty(item),
  );
  if (entries.length === 0) return `${pad}—`;

  return entries
    .map(([key, item]) => {
      const label = `${pad}${key}:`;
      if (SECRET.test(key) && typeof item === 'string' && item.length > 12) {
        return `${label} ···${item.slice(-4)}`;
      }
      if (isScalar(item)) return `${label} ${scalar(item)}`;
      if (Array.isArray(item) && item.every(isScalar)) return `${label} ${item.join(', ')}`;
      return `${label}\n${render(item, indent + 1)}`;
    })
    .join('\n');
}

/** Итог инструмента: заголовок и, если есть, разобранное тело ответа. */
export function report(summary: string, payload?: unknown): string {
  if (payload === undefined || isEmpty(payload)) return summary;
  return `${summary}\n\n${render(payload)}`;
}

/** Строка «показано N из M» для страниц списков. */
export function pageFooter(page: { items: unknown[]; total: number; offset: number }): string {
  const shown = page.offset + page.items.length;
  if (shown >= page.total) return `Всего: ${page.total}`;
  return `Показано ${page.offset + 1}–${shown} из ${page.total}. Продолжить: offset=${shown}`;
}
