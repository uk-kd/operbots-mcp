/**
 * Настройки сервера: переменные окружения и пути.
 *
 * Обычный путь — один раз выполнить `operbots-mcp login`; переменные
 * окружения нужны для запуска без человека (CI, контейнер, сервер).
 */

import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;

/**
 * Имя машины для подписи сессии — только из знаков ASCII.
 *
 * Заголовки HTTP передаются однобайтовой строкой, поэтому кириллица в
 * имени компьютера (а на русской Windows оно обычное дело) обрушила бы
 * не только вход, а вообще каждый запрос.
 */
function asciiHostname(): string {
  const cleaned = hostname()
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[;()]/g, ' ')
    .trim();
  return cleaned || 'unknown';
}

/** Как подключение подпишется в разделе «Интеграции» панели. */
export const USER_AGENT =
  `operbots-mcp/${VERSION} ` +
  `(${process.platform}; node ${process.versions.node}; ${asciiHostname()})`;

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

/** Локальные адреса, куда панель обычно смотрит без шифрования. */
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)(:|$)/i;

/**
 * Приводит адрес панели к виду `схема://host[:port]` без хвостового слэша.
 *
 * Схему угадываем: `localhost:8080` без неё почти всегда означает свою
 * машину без сертификата, а `panel.example.com` — боевую панель за
 * шифрованием. Иначе человек, набравший привычное `localhost:8080`,
 * упирался бы в невразумительный отказ рукопожатия.
 */
export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) throw new Error('Адрес панели не может быть пустым');
  if (!/^https?:\/\//i.test(value)) {
    value = `${LOCAL.test(value) ? 'http' : 'https'}://${value}`;
  }

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
