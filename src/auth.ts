/**
 * Доступ к панели по токену.
 *
 * Токен выпускается в панели: аккаунт → Интеграции → «Выпустить токен».
 * Он не истекает сам по себе и не требует обновления, поэтому здесь нет
 * ни ротации, ни гонки между двумя сессиями Claude Code за общий файл —
 * всё это ушло вместе с входом по паролю. Пароль сервер теперь не видит
 * вовсе и хранить его негде.
 *
 * Прав токен не добавляет: он опознаёт того же пользователя, и панель
 * применяет к запросам ровно его роли. Отзывают токен там же, где
 * выпускали.
 */

import { API_PREFIX, USER_AGENT, type Config } from './config.js';
import {
  loadProfile,
  saveProfile,
  withCredentialsLock,
  type StoredProfile,
} from './credentials.js';
import { AuthRequiredError } from './errors.js';
import { parse, send } from './http.js';

/** Пользователь панели — то, что отдаёт `/users/me`. */
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

/** Приставка, по которой токен доступа отличается от прочих строк. */
export const TOKEN_PREFIX = 'opb_';

const LOGIN_HINT =
  'Вызовите инструмент operbots_login — откроется окно для адреса панели и токена. ' +
  'Токен выпускается в панели: аккаунт → Интеграции. ' +
  'Либо выполните в терминале operbots-mcp login, либо задайте OPERBOTS_URL и OPERBOTS_TOKEN.';

export class AuthManager {
  private identity: Identity | null = null;
  private profile: StoredProfile | null = null;
  private loaded = false;

  constructor(private readonly config: Config) {}

  // ── Что известно о доступе ─────────────────────────────────

  private async storedProfile(): Promise<StoredProfile | null> {
    if (!this.loaded) {
      this.profile = await loadProfile(this.config.credentialsPath, this.config.baseUrl);
      this.loaded = true;
    }
    return this.profile;
  }

  /** Адрес панели: из окружения, иначе из сохранённого профиля. */
  async baseUrl(): Promise<string> {
    if (this.config.baseUrl) return this.config.baseUrl;
    const profile = await this.storedProfile();
    if (profile) return profile.baseUrl;
    throw new AuthRequiredError(`Панель не выбрана. ${LOGIN_HINT}`);
  }

  /** Адрес панели, если он известен. В отличие от `baseUrl`, не бросает. */
  async knownBaseUrl(): Promise<string | null> {
    if (this.config.baseUrl) return this.config.baseUrl;
    return (await this.storedProfile())?.baseUrl ?? null;
  }

  /** Токен доступа: из окружения или из сохранённого профиля. */
  async token(): Promise<string> {
    if (this.config.token) return this.config.token;

    const profile = await this.storedProfile();
    if (profile?.token) return profile.token;

    // Файл от прежних выпусков хранил токен обновления сессии. Его
    // больше не принимают, и молчать об этом нельзя: человек увидел бы
    // отказ без всякого объяснения.
    if (profile?.refreshToken) {
      throw new AuthRequiredError(
        'Сохранённый доступ остался от входа по паролю, который больше не поддерживается. ' +
          `Выпустите токен в панели и войдите заново. ${LOGIN_HINT}`,
      );
    }

    throw new AuthRequiredError(`Доступ к панели не сохранён. ${LOGIN_HINT}`);
  }

  /** Выполнен ли вход. */
  async signedIn(): Promise<boolean> {
    if (this.config.token) return true;
    return Boolean((await this.storedProfile())?.token);
  }

  // ── Кто вошёл ──────────────────────────────────────────────

  /** Владелец токена. Ответ запоминается на время работы процесса. */
  async whoami(): Promise<Identity> {
    if (this.identity) return this.identity;
    this.identity = await this.fetchIdentity(await this.baseUrl(), await this.token());
    return this.identity;
  }

  private async fetchIdentity(base: string, token: string): Promise<Identity> {
    const response = await send(`${base}${API_PREFIX}/users/me`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
      timeoutMs: this.config.timeoutMs,
    });
    return parse<Identity>(response);
  }

  // ── Вход и выход ───────────────────────────────────────────

  /**
   * Проверяет токен живым запросом и сохраняет его.
   *
   * Проверка обязательна: сохранить непроверенный токен значит отложить
   * отказ до первого настоящего действия, когда объяснить его будет уже
   * нечем.
   */
  async signIn(base: string, token: string): Promise<Identity> {
    const value = token.trim();
    if (!value) throw new AuthRequiredError('Токен пустой.');
    if (!value.startsWith(TOKEN_PREFIX)) {
      throw new AuthRequiredError(
        `Это не похоже на токен панели — он начинается с «${TOKEN_PREFIX}». ` +
          'Выпустите токен в панели: аккаунт → Интеграции.',
      );
    }

    const user = await this.fetchIdentity(base, value);

    await withCredentialsLock(this.config.credentialsPath, () =>
      saveProfile(this.config.credentialsPath, {
        baseUrl: base,
        token: value,
        email: user.email,
        userId: user.id,
        displayName: user.display_name,
      }),
    );

    this.profile = await loadProfile(this.config.credentialsPath, base);
    this.loaded = true;
    this.identity = user;
    return user;
  }

  /** Забывает доступ на этой машине. Сам токен остаётся действующим. */
  forget(): void {
    this.identity = null;
    this.profile = null;
    this.loaded = false;
  }
}
