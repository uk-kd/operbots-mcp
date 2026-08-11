/**
 * Настройки сервера: переменные окружения и пути.
 *
 * Обычный путь — один раз выполнить `operbots-mcp login`; переменные
 * окружения нужны для запуска без человека (CI, контейнер, сервер).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;

/** Как сессия подпишется в разделе «Активные сессии» панели. */
export const USER_AGENT = `operbots-mcp/${VERSION} (${process.platform}; node ${process.versions.node})`;

/** Префикс API панели — совпадает с `api_prefix` в настройках operbots. */
export const API_PREFIX = '/api/v1';

/** Имя cookie с токеном обновления по умолчанию (`refresh_cookie_name`). */
export const DEFAULT_REFRESH_COOKIE = 'operbots_refresh';

export interface Config {
  /** Адрес панели без хвостового слэша, если задан явно. */
  baseUrl: string | null;
  /** Путь к файлу с сохранённым доступом. */
  credentialsPath: string;
  /** Токен обновления из окружения — вместо файла. */
  refreshToken: string | null;
  /** Готовый токен доступа: только для отладки, не обновляется. */
  accessToken: string | null;
  /** Почта и пароль для входа без участия человека. */
  email: string | null;
  password: string | null;
  /** Дело по умолчанию: подставляется, когда инструмент вызван без `case_id`. */
  defaultCase: string | null;
  /** Скрыть все инструменты, которые что-либо меняют. */
  readOnly: boolean;
  /** Предел ожидания ответа панели, мс. */
  timeoutMs: number;
  /** Не проверять сертификат: только для панели с самоподписанным TLS. */
  insecureTls: boolean;
}

function env(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function flag(name: string): boolean {
  const value = env(name)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Приводит адрес панели к виду `https://host[:port]` без хвостового слэша. */
export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) throw new Error('Адрес панели не может быть пустым');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Не похоже на адрес панели: ${raw}`);
  }
  // Хвостовой /api или /api/v1 — частая ошибка при вводе: панель ждёт корень.
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
  return `${parsed.origin}${path}`;
}

export function loadConfig(): Config {
  const rawBase = env('OPERBOTS_URL') ?? env('OPERBOTS_BASE_URL');
  const timeout = Number(env('OPERBOTS_TIMEOUT_MS') ?? '30000');

  return {
    baseUrl: rawBase ? normalizeBaseUrl(rawBase) : null,
    credentialsPath:
      env('OPERBOTS_CREDENTIALS') ?? join(homedir(), '.operbots', 'credentials.json'),
    refreshToken: env('OPERBOTS_REFRESH_TOKEN'),
    accessToken: env('OPERBOTS_ACCESS_TOKEN'),
    email: env('OPERBOTS_EMAIL'),
    password: env('OPERBOTS_PASSWORD'),
    defaultCase: env('OPERBOTS_CASE'),
    readOnly: flag('OPERBOTS_READ_ONLY'),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
    insecureTls: flag('OPERBOTS_INSECURE_TLS'),
  };
}
