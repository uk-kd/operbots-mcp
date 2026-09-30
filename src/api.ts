/**
 * Клиент REST API панели.
 *
 * Ничего не решает за пользователя: просто подписывает запрос его
 * токеном доступа. Любые проверки прав остаются на стороне панели,
 * поэтому MCP-сервер физически не может сделать больше, чем разрешено
 * роли вошедшего человека.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';

import { API_PREFIX, USER_AGENT, type Config } from './config.js';
import type { AuthManager } from './auth.js';
import { ApiError, ConfigError } from './errors.js';
import { parse, parseBytes, parseText, send } from './http.js';

export type Query = Record<string, string | number | boolean | string[] | undefined | null>;

interface CallOptions {
  query?: Query;
  body?: unknown;
}

/** Страница списка. Некоторые разделы возвращают обычные массивы. */
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

  put<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.call<T>('PUT', path, { body, query });
  }

  delete<T>(path: string, query?: Query): Promise<T> {
    return this.call<T>('DELETE', path, { query });
  }

  /** Загрузка локального файла: тот же multipart, которым пользуется панель. */
  async upload<T>(
    path: string,
    filePath: string,
    fields: Record<string, string | number | boolean> = {},
    contentType?: string,
  ): Promise<T> {
    requireLocalPath(filePath);
    const info = await stat(filePath);
    if (!info.isFile()) throw new ConfigError('Укажите путь к файлу, а не к папке.');
    const maxBytes = 20 * 1024 * 1024;
    if (info.size > maxBytes) throw new ConfigError('Файл больше 20 МиБ — предел загрузки панели.');
    const data = await readFile(filePath);
    if (data.length > maxBytes) throw new ConfigError('Файл больше 20 МиБ — предел загрузки панели.');

    const form = new FormData();
    const mediaTypes: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
      '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
    };
    form.append('file', new Blob([data], { type: contentType || mediaTypes[extname(filePath).toLowerCase()] || 'application/octet-stream' }), basename(filePath));
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    return this.post<T>(path, form);
  }

  /** Сохраняет ответ файлом; существующий файл никогда не перезаписывает. */
  async download(
    path: string,
    destination: string,
    query?: Query,
  ): Promise<{ path: string; bytes: number; content_type: string }> {
    requireLocalPath(destination);
    const response = await this.request('GET', path, { query });
    let data: Uint8Array;
    try {
      data = await parseBytes(response);
    } catch (error) {
      throw enrich(error);
    }
    await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
    return { path: destination, bytes: data.length,
      content_type: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** Ответ, который панель отдаёт готовым файлом: выгрузка переписки. */
  async text(path: string, query?: Query): Promise<string> {
    const response = await this.request('GET', path, { query });
    try {
      return await parseText(response);
    } catch (error) {
      throw enrich(error);
    }
  }

  private async call<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
    const response = await this.request(method, path, options);
    try {
      return await parse<T>(response);
    } catch (error) {
      throw enrich(error);
    }
  }

  private async request(
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<Response> {
    const base = await this.auth.baseUrl();
    const token = await this.auth.token();
    const url = `${base}${API_PREFIX}${path}${buildQuery(options.query)}`;

    return send(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
      ...(options.body === undefined ? {} : { body: options.body }),
      timeoutMs: this.config.timeoutMs,
    });
  }
}

export function requireLocalPath(path: string): void {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(path))) {
    throw new ConfigError('Укажите абсолютный локальный путь к обычному файлу; UNC и device пути не поддерживаются.');
  }
}

/** Дополняет частые ошибки подсказкой, что делать дальше. */
function enrich(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.isUnauthenticated) {
    return new ApiError(
      error.status,
      error.code,
      `${error.message}\nВыпустите новый токен в панели (аккаунт → Интеграции) и вызовите operbots_login.`,
      error.details,
    );
  }
  if (error.code === 'session_required') {
    return new ApiError(
      error.status,
      error.code,
      'Токенами доступа управляют только из панели: выпустить или отозвать токен ' +
        'по самому токену нельзя — иначе утёкший ключ выписывал бы себе новые.',
      error.details,
    );
  }
  if (error.code === 'profile_incomplete') {
    return new ApiError(
      error.status,
      error.code,
      'Учётная запись не прошла шаг знакомства: нужны фамилия, имя и дата рождения. ' +
        'До этого API закрыт целиком. Заполнить можно отсюда: ' +
        'account_update last_name, first_name, birth_date (ГГГГ-ММ-ДД).',
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
    // Список уходит повторяющимся ключом: так панель принимает отбор
    // сразу по нескольким значениям — ?kind=ai.reply&kind=ai.error.
    if (Array.isArray(value)) {
      for (const item of value) if (item !== '') params.append(key, item);
      continue;
    }
    params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
