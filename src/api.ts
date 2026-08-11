/**
 * Клиент REST API панели.
 *
 * Ничего не решает за пользователя: просто подписывает запрос его
 * токеном доступа. Любые проверки прав остаются на стороне панели,
 * поэтому MCP-сервер физически не может сделать больше, чем разрешено
 * роли вошедшего человека.
 */

import { API_PREFIX, USER_AGENT, type Config } from './config.js';
import type { AuthManager } from './auth.js';
import { ApiError } from './errors.js';
import { parse, send } from './http.js';

export type Query = Record<string, string | number | boolean | undefined | null>;

interface CallOptions {
  query?: Query;
  body?: unknown;
  /** Разрешить повтор после обновления токена. Внутренний флаг. */
  retry?: boolean;
}

/** Страница списка: панель отвечает так на все перечисления. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export class OperbotsApi {
  constructor(
    private readonly auth: AuthManager,
    private readonly config: Config,
  ) {}

  get<T>(path: string, query?: Query): Promise<T> {
    return this.call<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.call<T>('POST', path, { body, query });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.call<T>('PATCH', path, { body });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.call<T>('PUT', path, { body });
  }

  delete<T>(path: string, query?: Query): Promise<T> {
    return this.call<T>('DELETE', path, { query });
  }

  private async call<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
    const base = await this.auth.baseUrl();
    const token = await this.auth.accessToken();
    const url = `${base}${API_PREFIX}${path}${buildQuery(options.query)}`;

    const response = await send(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
      ...(options.body === undefined ? {} : { body: options.body }),
      timeoutMs: this.config.timeoutMs,
    });

    try {
      return await parse<T>(response);
    } catch (error) {
      // Токен мог истечь между проверкой срока и запросом — один повтор
      // со свежим токеном дешевле, чем ошибка в диалоге.
      if (error instanceof ApiError && error.isUnauthenticated && options.retry !== false) {
        this.auth.invalidate();
        return this.call<T>(method, path, { ...options, retry: false });
      }
      throw enrich(error);
    }
  }
}

/** Дополняет частые ошибки подсказкой, что делать дальше. */
function enrich(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code === 'profile_incomplete') {
    return new ApiError(
      error.status,
      error.code,
      'Учётная запись не прошла шаг знакомства: откройте панель и заполните ФИО и дату рождения. ' +
        'До этого API закрыт целиком.',
      error.details,
    );
  }
  return error;
}

function buildQuery(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
