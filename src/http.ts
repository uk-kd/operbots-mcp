/**
 * Тонкий слой поверх fetch: таймауты и разбор ошибок панели.
 *
 * Выделен отдельно, чтобы проверка токена (`auth.ts`) и обычные вызовы
 * API (`api.ts`) пользовались одним разбором ответов и не зависели друг
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
    headers: { Accept: 'application/json', ...latin1(headers) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  };

  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
  }

  try {
    return await fetch(url, init);
  } catch (error) {
    throw new ConnectionError(describeNetworkFailure(url, error), error);
  }
}

/**
 * Приводит значения заголовков к однобайтовым знакам.
 *
 * Заголовок с кириллицей внутри — а она попадает туда через имя
 * компьютера — обрушивает запрос целиком, ещё до отправки. Лучше
 * потерять пару знаков в подписи, чем связь с панелью.
 */
function latin1(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    safe[name] = /[^\u0000-ÿ]/.test(value) ? value.replace(/[^\u0000-ÿ]/g, '') : value;
  }
  return safe;
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

  // «fetch failed» само по себе ничего не объясняет — разворачиваем цепочку
  // причин, иначе человек видит отказ без единой зацепки.
  const reason = [...causes(error)].join(': ');
  const scheme = url.toLowerCase().startsWith('https://') ? 'https' : 'http';
  const hint =
    scheme === 'https'
      ? ' Если панель работает без шифрования, укажите адрес с http:// в начале.'
      : '';
  return `Не удалось обратиться к ${host}: ${reason}.${hint}`;
}

/** Сообщения ошибки и всех её причин, без повторов. */
function* causes(error: unknown): Generator<string> {
  const seen = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !seen.has(message)) {
      seen.add(message);
      yield message;
    }
    current = (current as { cause?: unknown }).cause;
  }
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
  const text = await parseText(response);

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

/**
 * Тело ответа как есть, без разбора.
 *
 * Выгрузку переписки панель отдаёт готовым файлом, а не JSON, и через
 * `parse` она читалась бы как «адрес ведёт не на API operbots». Ошибку
 * панель и в этом случае присылает обычным JSON — её разбираем тем же.
 */
export async function parseText(response: Response): Promise<string> {
  return new TextDecoder().decode(await parseBytes(response));
}

/** Читает всё тело под таймаутом fetch и сохраняет общий разбор ошибок API. */
export async function parseBytes(response: Response): Promise<Uint8Array> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new ConnectionError(describeNetworkFailure(response.url, error), error);
  }
  if (!response.ok) throw failure(response, new TextDecoder().decode(data));
  return data;
}

/** Streams a successful body under the same fetch timeout and API error contract. */
export async function* streamBytes(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.ok) await parseBytes(response);
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read().catch(error => {
        throw new ConnectionError(describeNetworkFailure(response.url, error), error);
      });
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Ошибка панели из тела ответа — с телом любого вида. */
function failure(response: Response, text: string): ApiError {
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

  return new ApiError(response.status, code, message, details);
}
