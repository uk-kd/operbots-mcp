/**
 * Доступ к панели по токену.
 *
 * Токен выпускается в панели: аккаунт → Интеграции → «Выпустить токен».
 * Он не истекает сам по себе и не требует обновления, поэтому здесь нет
 * ни ротации, ни гонки между двумя сессиями Claude Code за общий файл —
 * всё это ушло вместе с входом по паролю. Для входа хранится только токен;
 * явная смена пароля — отдельная операция аккаунта без сохранения паролей.
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
  'Вызовите operbots_login для инструкции подключения или с локальным token_file. ' +
  'Токен выпускается в панели: аккаунт → Интеграции. ' +
  'Либо выполните в терминале operbots-mcp login, либо задайте OPERBOTS_URL и OPERBOTS_TOKEN.';

export class AuthManager {
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
    if (this.config.token) return validateToken(this.config.token);

    const profile = await this.storedProfile();
    if (profile?.token) return validateToken(profile.token);

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

  /** Владелец токена: перечитываем, чтобы видеть правки профиля и отзыв доступа. */
  async whoami(): Promise<Identity> {
    return this.fetchIdentity(await this.baseUrl(), await this.token());
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
    const value = validateToken(token);

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
    // Явный вход выбирает подключение на время этого процесса, включая
    // сервер, который изначально получил адрес и токен из окружения.
    this.config.baseUrl = base;
    this.config.token = null;
    return user;
  }

  /** Забывает доступ на этой машине. Сам токен остаётся действующим. */
  forget(): void {
    this.profile = null;
    this.loaded = false;
  }
}

/** Не даём ошибке заголовка HTTP раскрыть неправильно вставленный токен. */
function validateToken(raw: string): string {
  const value = raw.trim();
  if (!value) throw new AuthRequiredError('Токен пустой.');
  if (!/^opb_[A-Za-z0-9_-]+$/.test(value)) {
    throw new AuthRequiredError(
      `Это не похоже на токен панели — он начинается с «${TOKEN_PREFIX}» ` +
        'и содержит только латинские буквы, цифры, дефис и подчёркивание. ' +
        'Выпустите токен в панели: аккаунт → Интеграции.',
    );
  }
  return value;
}
