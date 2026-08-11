/**
 * Команды в терминале: вход, выход и проверка подключения.
 *
 * Вход спрашивает пароль один раз и никуда его не сохраняет: пароль
 * сразу обменивается на токен обновления, и на диск ложится только он.
 */

import { createInterface } from 'node:readline/promises';

import { AuthManager } from './auth.js';
import { OperbotsApi } from './api.js';
import { PACKAGE_NAME, VERSION, loadConfig, normalizeBaseUrl } from './config.js';
import { listProfiles, removeProfile, withCredentialsLock } from './credentials.js';
import { describeError } from './errors.js';
import { selectTools } from './server.js';

const out = (text = '') => process.stdout.write(`${text}\n`);

/** Прерывание с клавиатуры и забой — в сыром режиме они приходят как обычные символы. */
const CTRL_C = String.fromCharCode(3);
const DELETE = String.fromCharCode(127);

// ── Ввод ─────────────────────────────────────────────────────

async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${question}${hint}: `)).trim();
    return answer || fallback || '';
  } finally {
    rl.close();
  }
}

/** Читает пароль, не показывая его в терминале. */
async function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);

  process.stdout.write(`${question}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const done = (finish: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      finish();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(() => resolve(value));
        if (char === CTRL_C) return done(() => reject(new Error('Отменено')));
        if (char === DELETE || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        // Управляющие последовательности (стрелки и прочее) в пароль не берём.
        if (char >= ' ') value += char;
      }
    };

    stdin.on('data', onData);
  });
}

// ── Команды ──────────────────────────────────────────────────

export async function login(argv: string[]): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags(argv);

  const rawUrl =
    flags.url ?? config.baseUrl ?? (await ask('Адрес панели', 'http://localhost:8080'));
  let base: string;
  try {
    base = normalizeBaseUrl(rawUrl);
  } catch (error) {
    out(describeError(error));
    return 1;
  }

  const email = flags.email ?? config.email ?? (await ask('Почта'));
  if (!email) {
    out('Без почты войти нельзя.');
    return 1;
  }

  const password = config.password ?? (await askSecret('Пароль'));
  if (!password) {
    out('Без пароля войти нельзя.');
    return 1;
  }

  const auth = new AuthManager({ ...config, baseUrl: base });
  try {
    const user = await auth.signIn(base, email, password);
    const api = new OperbotsApi(auth, { ...config, baseUrl: base });
    const cases = await api
      .get<{ name: string; emoji: string }[]>('/cases')
      .catch(() => [] as { name: string; emoji: string }[]);

    out();
    out(`Вход выполнен: ${user.display_name} <${user.email}>`);
    out(`Панель: ${base}`);
    out(`Доступно дел: ${cases.length}${cases.length ? ` — ${cases.map((item) => `${item.emoji} ${item.name}`).join(', ')}` : ''}`);
    if (!user.profile_completed) {
      out();
      out('Внимание: профиль не заполнен — откройте панель и пройдите шаг знакомства,');
      out('иначе API закрыт целиком.');
    }
    out();
    out(`Доступ сохранён в ${config.credentialsPath}`);
    out('Подключение видно в панели: аккаунт → Активные сессии. Оттуда же его можно отозвать.');
    out();
    out('Подключить к Claude Code:');
    out(`  claude mcp add operbots -- npx -y ${PACKAGE_NAME}`);
    return 0;
  } catch (error) {
    out();
    out(describeError(error));
    return 1;
  }
}

export async function logout(argv: string[]): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags(argv);
  const auth = new AuthManager(config);

  let base: string;
  try {
    base = flags.url ? normalizeBaseUrl(flags.url) : await auth.baseUrl();
  } catch (error) {
    out(describeError(error));
    return 1;
  }

  await auth.signOut();
  const removed = await withCredentialsLock(config.credentialsPath, () =>
    removeProfile(config.credentialsPath, base),
  );

  out(removed ? `Доступ к ${base} удалён, сессия в панели завершена.` : `Сохранённого доступа к ${base} не было.`);
  return 0;
}

export async function status(): Promise<number> {
  const config = loadConfig();
  const { current, profiles } = await listProfiles(config.credentialsPath);

  out(`${PACKAGE_NAME} ${VERSION}`);
  out(`Файл доступа: ${config.credentialsPath}`);
  out();

  if (profiles.length === 0 && !config.refreshToken && !(config.email && config.password)) {
    out('Вход не выполнен. Выполните: operbots-mcp login');
    return 1;
  }

  for (const profile of profiles) {
    const mark = profile.baseUrl === current ? '→' : ' ';
    out(`${mark} ${profile.baseUrl} — ${profile.displayName ?? profile.email ?? 'неизвестно кто'} (обновлён ${profile.updatedAt})`);
  }
  if (config.refreshToken) out('  доступ задан переменной OPERBOTS_REFRESH_TOKEN');
  if (config.email && config.password) out('  вход по OPERBOTS_EMAIL и OPERBOTS_PASSWORD');
  out();

  const auth = new AuthManager(config);
  const api = new OperbotsApi(auth, config);
  try {
    const user = await auth.whoami();
    const cases = await api.get<{ name: string; emoji: string; permissions: string[]; role_name: string | null; is_owner: boolean }[]>(
      '/cases',
    );

    out(`Связь с панелью есть: ${user.display_name} <${user.email}>`);
    for (const item of cases) {
      const role = item.is_owner ? 'владелец' : (item.role_name ?? 'без роли');
      out(`  ${item.emoji} ${item.name} — ${role}, прав ${item.permissions.length} из 27`);
    }
  } catch (error) {
    out(`Связи с панелью нет: ${describeError(error)}`);
    return 1;
  }

  const tools = selectTools(config);
  out();
  out(
    `Инструментов доступно: ${tools.length}` +
      (config.readOnly ? ' (режим только чтения, OPERBOTS_READ_ONLY)' : ''),
  );
  if (config.defaultCase) out(`Дело по умолчанию: ${config.defaultCase}`);
  return 0;
}

export function tools(): number {
  const config = loadConfig();
  const label: Record<string, string> = {
    read: 'чтение',
    write: 'изменение',
    danger: 'опасное',
  };

  for (const item of selectTools(config)) {
    out(`${item.name.padEnd(24)} ${label[item.kind]?.padEnd(10)} ${item.title}`);
  }
  return 0;
}

export function help(): number {
  out(`${PACKAGE_NAME} ${VERSION} — MCP-сервер панели operbots

Использование:
  operbots-mcp                 запустить сервер MCP (так его вызывает Claude Code)
  operbots-mcp login           войти в панель и сохранить доступ
  operbots-mcp logout          завершить сессию и удалить сохранённый доступ
  operbots-mcp status          проверить связь с панелью и показать права
  operbots-mcp tools           перечислить доступные инструменты

Ключи команды login:
  --url <адрес>                адрес панели, например https://panel.example.com
  --email <почта>              почта учётной записи

Переменные окружения:
  OPERBOTS_URL                 адрес панели
  OPERBOTS_EMAIL               почта для входа без вопросов
  OPERBOTS_PASSWORD            пароль для входа без вопросов
  OPERBOTS_REFRESH_TOKEN       готовый токен обновления вместо файла
  OPERBOTS_CASE                дело по умолчанию: название или идентификатор
  OPERBOTS_READ_ONLY=1         оставить только инструменты чтения
  OPERBOTS_CREDENTIALS         путь к файлу с сохранённым доступом
  OPERBOTS_TIMEOUT_MS          сколько ждать ответ панели, по умолчанию 30000
  OPERBOTS_INSECURE_TLS=1      не проверять сертификат панели

Подключение к Claude Code:
  claude mcp add operbots -- npx -y ${PACKAGE_NAME}`);
  return 0;
}

// ── Разбор ключей ────────────────────────────────────────────

function parseFlags(argv: string[]): { url?: string; email?: string } {
  const flags: { url?: string; email?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--url') flags.url = argv[++index];
    else if (item === '--email') flags.email = argv[++index];
  }
  return flags;
}
