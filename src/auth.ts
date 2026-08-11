/**
 * Вход в панель и поддержание доступа.
 *
 * Как это устроено. Панель выдаёт короткоживущий токен доступа (по
 * умолчанию 30 минут) и токен обновления на 30 дней. Обновление —
 * с ротацией: в ответ приходит новый токен обновления, а прежний
 * гасится в ту же секунду. Отсюда два следствия, которые определяют
 * весь код ниже:
 *
 * 1. Новый токен нужно записать на диск раньше, чем он понадобится
 *    снова, иначе перезапуск сервера потеряет доступ.
 * 2. Два процесса не должны обновляться одновременно: второй придёт
 *    с уже погашенным токеном. Поэтому обновление идёт под общей
 *    блокировкой файла, а токен перечитывается прямо перед запросом.
 *
 * Сервер не получает никаких особенных прав: он работает обычной
 * пользовательской сессией. Всё, что запрещено роли в панели, будет
 * запрещено и здесь — проверку делает бэкенд, а не этот код.
 */

import {
  API_PREFIX,
  DEFAULT_REFRESH_COOKIE,
  USER_AGENT,
  type Config,
} from './config.js';
import {
  loadProfile,
  saveProfile,
  updateRefreshToken,
  withCredentialsLock,
  type StoredProfile,
} from './credentials.js';
import { ApiError, AuthRequiredError, ConfigError } from './errors.js';
import { parse, readCookie, send } from './http.js';

/** Пользователь панели — то, что приходит в ответе входа. */
export interface Identity {
  id: string;
  email: string;
  full_name: string;
  display_name: string;
  profile_completed: boolean;
  is_superuser: boolean;
  timezone: string;
  last_case_id: string | null;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  user: Identity;
}

/** За сколько секунд до истечения считаем токен доступа непригодным. */
const EXPIRY_SKEW_SECONDS = 60;

const LOGIN_HINT =
  'Вызовите инструмент operbots_login — откроется окно входа. ' +
  'Либо выполните в терминале operbots-mcp login, либо задайте OPERBOTS_URL, ' +
  'OPERBOTS_EMAIL и OPERBOTS_PASSWORD.';

export class AuthManager {
  private access: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  private identity: Identity | null = null;
  private profile: StoredProfile | null = null;
  /** Токен обновления из окружения: живёт только в памяти процесса. */
  private envRefresh: string | null;

  constructor(private readonly config: Config) {
    this.envRefresh = config.refreshToken;
    if (config.accessToken) {
      this.access = { token: config.accessToken, expiresAt: Number.POSITIVE_INFINITY };
    }
  }

  // ── Адрес панели ───────────────────────────────────────────

  /** Адрес панели: из окружения, иначе из сохранённого профиля. */
  async baseUrl(): Promise<string> {
    if (this.config.baseUrl) return this.config.baseUrl;
    const profile = await this.storedProfile();
    if (profile) return profile.baseUrl;
    throw new AuthRequiredError(`Панель не выбрана. ${LOGIN_HINT}`);
  }

  private async storedProfile(): Promise<StoredProfile | null> {
    if (this.profile) return this.profile;
    this.profile = await loadProfile(this.config.credentialsPath, this.config.baseUrl);
    return this.profile;
  }

  /** Адрес панели, если он уже известен. В отличие от `baseUrl`, не бросает. */
  async knownBaseUrl(): Promise<string | null> {
    if (this.config.baseUrl) return this.config.baseUrl;
    return (await this.storedProfile())?.baseUrl ?? null;
  }

  /** Выполнен ли вход: есть ли чем получить токен доступа. */
  async signedIn(): Promise<boolean> {
    if (this.config.accessToken || this.envRefresh) return true;
    if (this.config.email && this.config.password) return true;
    return (await this.storedProfile()) !== null;
  }

  private url(base: string, path: string): string {
    return `${base}${API_PREFIX}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'User-Agent': USER_AGENT, ...extra };
  }

  // ── Токен доступа ──────────────────────────────────────────

  /** Действующий токен доступа; при необходимости обновляет его. */
  async accessToken(): Promise<string> {
    if (this.access && Date.now() < this.access.expiresAt) return this.access.token;
    if (this.config.accessToken) return this.config.accessToken;

    // Одно обновление на процесс: параллельные вызовы ждут общий запрос,
    // иначе ротация погасит токен, который второй запрос ещё не получил.
    this.pending ??= this.renew().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Сбрасывает токен доступа: следующий вызов возьмёт свежий. */
  invalidate(): void {
    if (!this.config.accessToken) this.access = null;
  }

  /** Кто вошёл. Берётся из ответа входа, иначе спрашивается у панели. */
  async whoami(): Promise<Identity> {
    if (this.identity) return this.identity;

    const base = await this.baseUrl();
    const token = await this.accessToken();
    if (this.identity) return this.identity;

    const response = await send(this.url(base, '/users/me'), {
      headers: this.headers({ Authorization: `Bearer ${token}` }),
      timeoutMs: this.config.timeoutMs,
    });
    this.identity = await parse<Identity>(response);
    return this.identity;
  }

  // ── Обновление ─────────────────────────────────────────────

  private async renew(): Promise<string> {
    const base = await this.baseUrl();

    // Режим окружения: файла нет, ротация живёт только в памяти.
    if (this.envRefresh) {
      try {
        return await this.exchange(base, this.envRefresh, DEFAULT_REFRESH_COOKIE, (token) => {
          this.envRefresh = token;
        });
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthenticated) return this.loginFromEnv(base);
        throw error;
      }
    }

    if (this.config.email && this.config.password && !(await this.storedProfile())) {
      return this.loginFromEnv(base);
    }

    return withCredentialsLock(this.config.credentialsPath, async () => {
      // Перечитываем прямо под блокировкой: соседний процесс мог только
      // что провести ротацию, и наш токен в памяти уже погашен.
      const stored = await loadProfile(this.config.credentialsPath, this.config.baseUrl);
      if (!stored) throw new AuthRequiredError(`Доступ к панели не сохранён. ${LOGIN_HINT}`);
      this.profile = stored;

      try {
        return await this.exchange(stored.baseUrl, stored.refreshToken, stored.cookieName, (token) =>
          updateRefreshToken(this.config.credentialsPath, stored.baseUrl, token),
        );
      } catch (error) {
        if (!(error instanceof ApiError) || !error.isUnauthenticated) throw error;
        if (this.config.email && this.config.password) return this.loginFromEnv(stored.baseUrl);
        throw new AuthRequiredError(
          `Сессия панели больше не действует (${error.message}). ` +
            'Возможно, её отозвали в разделе «Активные сессии» или прошло больше 30 дней. ' +
            'Войдите заново: operbots-mcp login',
        );
      }
    });
  }

  /**
   * Меняет токен обновления на новую пару и сохраняет результат.
   *
   * Сохранение происходит до возврата токена доступа: если запись
   * упадёт, лучше сообщить об этом сразу, чем потерять доступ при
   * следующем запуске.
   */
  private async exchange(
    base: string,
    refreshToken: string,
    cookieName: string,
    persist: (token: string) => void | Promise<void>,
  ): Promise<string> {
    const response = await send(this.url(base, '/auth/refresh'), {
      method: 'POST',
      headers: this.headers({ Cookie: `${cookieName}=${refreshToken}` }),
      timeoutMs: this.config.timeoutMs,
    });

    const payload = await parse<TokenResponse>(response);
    const rotated = readCookie(response, cookieName);
    if (rotated) await persist(rotated.value);

    return this.remember(payload, base, rotated?.name ?? cookieName);
  }

  private remember(payload: TokenResponse, base: string, cookieName: string): string {
    this.identity = payload.user;
    this.access = {
      token: payload.access_token,
      expiresAt: Date.now() + Math.max(payload.expires_in - EXPIRY_SKEW_SECONDS, 5) * 1000,
    };
    if (this.profile) this.profile = { ...this.profile, baseUrl: base, cookieName };
    return payload.access_token;
  }

  // ── Вход ───────────────────────────────────────────────────

  private async loginFromEnv(base: string): Promise<string> {
    if (!this.config.email || !this.config.password) {
      throw new AuthRequiredError(`Доступ к панели не сохранён. ${LOGIN_HINT}`);
    }
    const result = await this.authenticate(base, this.config.email, this.config.password);

    // Пароль в окружении означает, что вход можно повторить в любой
    // момент, поэтому файл не трогаем — процесс самодостаточен.
    this.envRefresh = result.refreshToken;
    return this.remember(result.payload, base, result.cookieName);
  }

  /**
   * Вход по почте и паролю. Пароль никуда не сохраняется: он сразу
   * обменивается на токен обновления.
   */
  async signIn(base: string, email: string, password: string): Promise<Identity> {
    const result = await this.authenticate(base, email, password);

    await withCredentialsLock(this.config.credentialsPath, () =>
      saveProfile(this.config.credentialsPath, {
        baseUrl: base,
        refreshToken: result.refreshToken,
        cookieName: result.cookieName,
        email: result.payload.user.email,
        userId: result.payload.user.id,
        displayName: result.payload.user.display_name,
      }),
    );

    this.profile = await loadProfile(this.config.credentialsPath, base);
    this.remember(result.payload, base, result.cookieName);
    return result.payload.user;
  }

  private async authenticate(
    base: string,
    email: string,
    password: string,
  ): Promise<{ payload: TokenResponse; refreshToken: string; cookieName: string }> {
    const response = await send(this.url(base, '/auth/login'), {
      method: 'POST',
      headers: this.headers(),
      body: { email, password },
      timeoutMs: this.config.timeoutMs,
    });

    const payload = await parse<TokenResponse>(response);
    const cookie = readCookie(response, DEFAULT_REFRESH_COOKIE);
    if (!cookie) {
      throw new ConfigError(
        'Панель не вернула токен обновления. Так бывает, если запрос прошёл через прокси, ' +
          'вырезающий заголовок Set-Cookie: проверьте настройки обратного прокси.',
      );
    }

    return { payload, refreshToken: cookie.value, cookieName: cookie.name };
  }

  /** Завершает сессию в панели. Ошибку сети не считаем помехой выходу. */
  async signOut(): Promise<void> {
    const profile = await this.storedProfile();
    if (!profile) return;

    await send(this.url(profile.baseUrl, '/auth/logout'), {
      method: 'POST',
      headers: this.headers({ Cookie: `${profile.cookieName}=${profile.refreshToken}` }),
      timeoutMs: this.config.timeoutMs,
    }).catch(() => undefined);

    this.access = null;
    this.identity = null;
    this.profile = null;
    this.envRefresh = null;
  }
}
