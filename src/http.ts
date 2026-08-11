/**
 * Тонкий слой поверх fetch: таймауты, разбор ошибок панели и cookie.
 *
 * Выделен отдельно, чтобы вход (`auth.ts`) и обычные вызовы API
 * (`api.ts`) пользовались одним разбором ответов и не зависели друг
 * от друга по кругу.
 */

import { ApiError, ConnectionError } from './errors.js';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/** Выполняет запрос, переводя сетевые сбои в понятный текст. */
export async function send(url: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', headers = {}, body, timeoutMs } = options;

  const init: RequestInit = {
    method,
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    // Панель кладёт токен обновления в cookie; заголовок Cookie мы ставим
    // руками, поэтому автоматическое хранилище cookie не нужно.
    redirect: 'follow',
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
  }

  try {
    return await fetch(url, init);
  } catch (error) {
    throw new ConnectionError(describeNetworkFailure(url, error), error);
  }
}

function describeNetworkFailure(url: string, error: unknown): string {
  const host = safeHost(url);
  const code = findErrorCode(error);

  switch (code) {
    case 'ECONNREFUSED':
      return `Панель ${host} не отвечает: соединение отклонено. Проверьте, что она запущена и адрес указан верно.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Не удалось найти адрес ${host}. Проверьте написание и доступность сети.`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return (
        `Сертификат ${host} не прошёл проверку (${code}). ` +
        `Если панель работает с самоподписанным сертификатом, задайте OPERBOTS_INSECURE_TLS=1.`
      );
    case 'ECONNRESET':
      return `Панель ${host} оборвала соединение.`;
    default:
      break;
  }

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `Панель ${host} не ответила вовремя. Увеличьте OPERBOTS_TIMEOUT_MS, если операция долгая.`;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return `Не удалось обратиться к ${host}: ${reason}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Код ошибки может лежать в `cause`, как это делает undici. */
function findErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Разбирает ответ: тело как JSON либо ошибка панели `{code, message, details}`.
 */
export async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (response.ok) {
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        response.status,
        'bad_response',
        'Панель вернула не JSON. Похоже, адрес ведёт не на API operbots.',
      );
    }
  }

  let code = `http_${response.status}`;
  let message = `Панель ответила ошибкой ${response.status}`;
  let details: Record<string, unknown> | undefined;

  try {
    const payload = JSON.parse(text) as {
      code?: string;
      message?: string;
      detail?: unknown;
      details?: Record<string, unknown>;
    };
    if (payload.code) code = payload.code;
    if (payload.message) message = payload.message;
    else if (typeof payload.detail === 'string') message = payload.detail;
    if (payload.details) details = payload.details;
  } catch {
    if (text.trim()) {
      // HTML-страница вместо JSON — почти всегда чужой прокси или неверный путь.
      message = text.trim().startsWith('<')
        ? `Панель ответила ошибкой ${response.status} и вернула HTML вместо JSON. Проверьте адрес панели.`
        : `${message}: ${text.slice(0, 300)}`;
    }
  }

  throw new ApiError(response.status, code, message, details);
}

export interface Cookie {
  name: string;
  value: string;
}

/**
 * Достаёт токен обновления из заголовков ответа.
 *
 * Имя cookie настраивается в панели (`REFRESH_COOKIE_NAME`), поэтому
 * ищем сначала ожидаемое имя, затем любое похожее на refresh, и только
 * потом берём единственную установленную cookie.
 */
export function readCookie(response: Response, preferred: string): Cookie | null {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : splitLegacy(response.headers.get('set-cookie'));

  const cookies: Cookie[] = [];
  for (const line of raw) {
    const pair = line.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name && value) cookies.push({ name, value });
  }

  return (
    cookies.find((cookie) => cookie.name === preferred) ??
    cookies.find((cookie) => /refresh/i.test(cookie.name)) ??
    cookies[0] ??
    null
  );
}

/** Запасной разбор для сред, где нет `Headers.getSetCookie`. */
function splitLegacy(header: string | null): string[] {
  return header ? [header] : [];
}
