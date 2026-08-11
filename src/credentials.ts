/**
 * Хранилище доступа: `~/.operbots/credentials.json`.
 *
 * В файле лежит только токен обновления — пароль не сохраняется нигде.
 * Панель при каждом обновлении выдаёт новый токен и сразу гасит старый,
 * поэтому файл переписывается на каждом обновлении, а на время записи
 * берётся блокировка: рядом может работать вторая сессия Claude Code с
 * тем же файлом, и без блокировки они отберут доступ друг у друга.
 */

import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_REFRESH_COOKIE } from './config.js';
import { ConfigError } from './errors.js';

export interface StoredProfile {
  /** Адрес панели — он же ключ профиля. */
  baseUrl: string;
  /** Токен обновления: единственный секрет в файле. */
  refreshToken: string;
  /** Имя cookie, под которым панель отдала токен. */
  cookieName: string;
  email?: string;
  userId?: string;
  displayName?: string;
  updatedAt: string;
}

interface CredentialsFile {
  version: 1;
  /** Профиль, который берётся, когда адрес панели не указан явно. */
  current: string | null;
  profiles: Record<string, StoredProfile>;
}

const EMPTY: CredentialsFile = { version: 1, current: null, profiles: {} };

// ── Блокировка файла ─────────────────────────────────────────

const LOCK_STALE_MS = 20_000;
const LOCK_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Выполняет действие, держа исключительную блокировку на файле доступа.
 *
 * Блокировка — соседний файл `.lock`, созданный в режиме «только если не
 * существует». Если процесс с блокировкой упал, замок протухает и снимается
 * по времени: иначе один сбой заблокировал бы вход навсегда.
 */
export async function withCredentialsLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new ConfigError(
          `Файл доступа ${path} занят другим процессом дольше ${LOCK_WAIT_MS / 1000} с. ` +
            `Если это остаток от сбоя, удалите ${lockPath}.`,
        );
      }
      await sleep(40 + Math.floor(Math.random() * 60));
    }
  }

  try {
    return await action();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

// ── Чтение и запись ──────────────────────────────────────────

async function readCredentials(path: string): Promise<CredentialsFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, profiles: {} };
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
    return {
      version: 1,
      current: parsed.current ?? null,
      profiles: parsed.profiles ?? {},
    };
  } catch {
    throw new ConfigError(
      `Файл доступа ${path} повреждён — удалите его и выполните вход заново: operbots-mcp login`,
    );
  }
}

/**
 * Пишет файл целиком: сначала во временный, затем переименованием.
 *
 * Обрыв на середине записи не должен оставить пустой файл — иначе
 * пользователь теряет доступ на ровном месте.
 */
async function writeCredentials(path: string, data: CredentialsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.credentials.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  // На Windows права posix почти не работают, поэтому ошибку глушим.
  await chmod(path, 0o600).catch(() => {});
}

// ── Операции над профилями ───────────────────────────────────

/** Профиль для адреса панели; без адреса — текущий. */
export async function loadProfile(
  path: string,
  baseUrl: string | null,
): Promise<StoredProfile | null> {
  const file = await readCredentials(path);
  const key = baseUrl ?? file.current;
  if (!key) return null;
  return file.profiles[key] ?? null;
}

/** Все сохранённые профили. */
export async function listProfiles(
  path: string,
): Promise<{ current: string | null; profiles: StoredProfile[] }> {
  const file = await readCredentials(path);
  return { current: file.current, profiles: Object.values(file.profiles) };
}

/** Сохраняет профиль и делает его текущим. Вызывать под блокировкой. */
export async function saveProfile(
  path: string,
  profile: Omit<StoredProfile, 'updatedAt' | 'cookieName'> & { cookieName?: string },
): Promise<void> {
  const file = await readCredentials(path);
  const previous = file.profiles[profile.baseUrl];
  file.profiles[profile.baseUrl] = {
    ...previous,
    ...profile,
    cookieName: profile.cookieName ?? previous?.cookieName ?? DEFAULT_REFRESH_COOKIE,
    updatedAt: new Date().toISOString(),
  };
  file.current = profile.baseUrl;
  await writeCredentials(path, file);
}

/** Обновляет только токен: так пишется результат каждой ротации. */
export async function updateRefreshToken(
  path: string,
  baseUrl: string,
  refreshToken: string,
): Promise<void> {
  const file = await readCredentials(path);
  const profile = file.profiles[baseUrl];
  if (!profile) return;
  file.profiles[baseUrl] = { ...profile, refreshToken, updatedAt: new Date().toISOString() };
  await writeCredentials(path, file);
}

/** Убирает профиль из файла. */
export async function removeProfile(path: string, baseUrl: string): Promise<boolean> {
  const file = await readCredentials(path);
  if (!file.profiles[baseUrl]) return false;
  delete file.profiles[baseUrl];
  if (file.current === baseUrl) {
    file.current = Object.keys(file.profiles)[0] ?? null;
  }
  await writeCredentials(path, file);
  return true;
}
