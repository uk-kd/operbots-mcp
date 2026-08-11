/**
 * Ошибки MCP-сервера.
 *
 * Панель operbots отвечает на ошибку телом `{code, message, details}` —
 * это же тело мы показываем модели, не превращая его в невнятное
 * «request failed with status 403».
 */

/** Ошибка, пришедшая от API панели. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Доступ не подтверждён: токен просрочен, отозван или отсутствует. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Прав не хватает: пользователь вошёл, но роль не позволяет действие. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Текст для модели: сообщение панели плюс полезные подробности. */
  describe(): string {
    const parts = [this.message];

    if (this.isForbidden) {
      const required = this.details?.required;
      if (Array.isArray(required) && required.length > 0) {
        parts.push(`Не хватает прав: ${required.join(', ')}.`);
      }
      parts.push('Права выдаются в панели: дело → Участники → роль.');
    }

    const fields = this.details?.fields;
    if (fields && typeof fields === 'object') {
      const lines = Object.entries(fields as Record<string, unknown>).map(
        ([field, problem]) => `  ${field}: ${String(problem)}`,
      );
      if (lines.length > 0) parts.push(`Поля с ошибками:\n${lines.join('\n')}`);
    }

    return parts.join('\n');
  }
}

/** Нет сохранённого доступа или он больше не работает. */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** Не удалось достучаться до панели: сеть, адрес, сертификат. */
export class ConnectionError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** Ошибка в настройках сервера (переменные окружения, файл доступа). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Читаемое описание любой ошибки — то, что увидит модель или человек. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.describe();
  if (error instanceof Error) return error.message;
  return String(error);
}
