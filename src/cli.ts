/**
 * Команды в терминале: установка, вход, выход и проверка подключения.
 *
 * Вход спрашивает адрес панели и токен доступа. Пароль здесь не нужен и
 * не принимается: токен выпускается в самой панели, где человек уже
 * вошёл, и там же отзывается.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { AuthManager, TOKEN_PREFIX } from './auth.js';
import { OperbotsApi } from './api.js';
import {
  PACKAGE_NAME,
  VERSION,
  applyProfileSettings,
  loadConfig,
  normalizeBaseUrl,
} from './config.js';
import {
  listProfiles,
  loadProfile,
  removeProfile,
  saveSettings,
  withCredentialsLock,
} from './credentials.js';
import { describeError } from './errors.js';
import { selectTools } from './server.js';

const out = (text = '') => process.stdout.write(`${text}\n`);

/** Откуда Claude Code берёт плагин. */
const REPO = 'uk-kd/operbots-mcp';
const MARKETPLACE = 'operbots';
const PLUGIN = 'operbots-mcp';

/** Ниже этого пакет не запустится, а `npx` о версии не предупреждает. */
const NODE_MIN = 20;

interface PanelCase {
  id: string;
  name: string;
  emoji: string;
  slug?: string;
}

/** Прерывание с клавиатуры и забой — в сыром режиме это обычные символы. */
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

/** Читает секрет, не показывая его в терминале. */
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
        // Управляющие последовательности в значение не берём.
        if (char >= ' ') value += char;
      }
    };

    stdin.on('data', onData);
  });
}

/** Да или нет с понятным значением по умолчанию. */
async function confirm(question: string, fallback: boolean): Promise<boolean> {
  const answer = (await ask(`${question} (${fallback ? 'Д/н' : 'д/Н'})`)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith('д') || answer.startsWith('y');
}

// ── Внешние команды ──────────────────────────────────────────

/**
 * Зовёт стороннюю программу, показывая её вывод человеку.
 *
 * На Windows `claude` и `npm` — это `.cmd`, а не исполняемые файлы, и
 * порождение процесса без оболочки падает с ENOENT. Ровно на этом и
 * ломался запуск сервера через `npx`, поэтому здесь оболочка нужна.
 *
 * Команда собирается строкой, а не списком: список вместе с оболочкой
 * Node считает опасным и предупреждает об этом на каждый запуск. Все
 * части здесь — постоянные, снаружи в них ничего не попадает.
 */
function run(command: string): boolean {
  const result = spawnSync(command, { stdio: 'inherit', shell: true });
  return !result.error && result.status === 0;
}

function hasCommand(command: string): boolean {
  const result = spawnSync(`${command} --version`, { stdio: 'ignore', shell: true });
  return !result.error && result.status === 0;
}

/** Полный путь к точке входа сервера — для клиентов без плагинов. */
function serverEntry(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url));
}

/** Запущены ли мы из временного кэша npx, который уберут. */
function isEphemeral(path: string): boolean {
  return /[\\/]_npx[\\/]/.test(path);
}

/** Куда Claude Code кладёт установленный плагин. */
function installedPluginEntry(): string | null {
  const root = join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE, PLUGIN);
  let versions: string[];
  try {
    versions = readdirSync(root);
  } catch {
    return null;
  }
  // Свою версию проверяем первой: она же только что поставилась.
  for (const version of [VERSION, ...versions.filter((item) => item !== VERSION)]) {
    const file = join(root, version, 'dist', 'index.js');
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Поднимает сервер тем же способом, каким его поднимет клиент.
 *
 * Установщик, который сказал «готово» и ушёл, — половина работы: сервер
 * падал уже после неё, и человек оставался с кодом ошибки вместо причины.
 * Здесь настоящее рукопожатие MCP, и если оно не выходит, наружу идёт то,
 * что сервер написал в поток ошибок.
 */
function checkServer(entry: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    let answered = '';
    let failed = '';
    let done = false;

    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ ok, detail });
    };

    const timer = setTimeout(
      () => finish(false, failed.trim() || 'сервер не ответил за 15 секунд'),
      15_000,
    );

    child.stdout.on('data', (chunk: Buffer) => {
      answered += chunk.toString();
      for (const line of answered.split('\n')) {
        if (!line.includes('"result"')) continue;
        try {
          const message = JSON.parse(line) as {
            result?: { serverInfo?: { name: string; version: string } };
          };
          const info = message.result?.serverInfo;
          if (info) finish(true, `${info.name} ${info.version}`);
        } catch {
          // Строка ещё не дописана — дождёмся следующего куска.
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (failed += chunk.toString()));
    child.on('error', (error) => finish(false, error.message));
    child.on('exit', (code) =>
      finish(false, failed.trim() || `сервер завершился с кодом ${code}`),
    );

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: PACKAGE_NAME, version: VERSION },
        },
      })}\n`,
    );
  });
}

function manualPluginSteps(): void {
  out(`  /plugin marketplace add ${REPO}`);
  out(`  /plugin install ${PLUGIN}@${MARKETPLACE}`);
}

// ── Команды ──────────────────────────────────────────────────

/**
 * Установка одной командой: спрашивает всё нужное и подключает плагин.
 *
 * Раньше человек шёл четырьмя шагами по двум разным инструкциям, а
 * сервер запускался через `npx` — команду, которая разрешается заново
 * при каждом старте, в чужом окружении. Здесь всё в одном окне, и по
 * итогу сервер запускается из файла, а не из реестра пакетов.
 */
export async function setup(argv: string[]): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags(argv);

  out(`${PACKAGE_NAME} ${VERSION} — установка`);
  out();

  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < NODE_MIN) {
    out(`Нужен Node ${NODE_MIN} или новее, а запущен ${process.versions.node}.`);
    out('Обновите Node и повторите: https://nodejs.org');
    return 1;
  }

  const previous = await loadProfile(config.credentialsPath, null).catch(() => null);
  const rawUrl =
    flags.url ??
    config.baseUrl ??
    (await ask('Адрес панели', previous?.baseUrl ?? 'http://localhost:8080'));

  let base: string;
  try {
    base = normalizeBaseUrl(rawUrl);
  } catch (error) {
    out(describeError(error));
    return 1;
  }

  if (!flags.token && !config.token) {
    out();
    out(`Токен выпускается в панели: ${base}/dashboard/account → Интеграции → «Выпустить токен».`);
    out('Значение показывается один раз — скопируйте его сразу.');
    out();
  }

  const token = flags.token ?? config.token ?? (await askSecret('Токен'));
  if (!token) {
    out('Без токена подключаться не к чему.');
    return 1;
  }

  const auth = new AuthManager({ ...config, baseUrl: base, token: null });
  let cases: PanelCase[] = [];
  try {
    const user = await auth.signIn(base, token);
    const api = new OperbotsApi(auth, { ...config, baseUrl: base, token: null });
    cases = await api.get<PanelCase[]>('/cases').catch(() => []);

    out();
    out(`Вход выполнен: ${user.display_name} <${user.email}>`);
    out(`Панель: ${base}`);
    out(
      `Доступно дел: ${cases.length}` +
        (cases.length ? ` — ${cases.map((item) => `${item.emoji} ${item.name}`).join(', ')}` : ''),
    );
    out(`Токен сохранён в ${config.credentialsPath}`);
    if (!user.profile_completed) {
      out();
      out('Внимание: профиль не заполнен — откройте панель и пройдите шаг знакомства,');
      out('иначе API закрыт целиком.');
    }
  } catch (error) {
    out();
    out(describeError(error));
    return 1;
  }

  // ── Настройки рядом с токеном ──────────────────────────────
  // Плагин запускает сервер без переменных окружения, поэтому спросить
  // их надо здесь и положить в профиль.
  const defaultCase = await pickCase(cases);
  const readOnly = await confirm('Оставить только инструменты чтения?', false);
  await withCredentialsLock(config.credentialsPath, () =>
    saveSettings(config.credentialsPath, base, { defaultCase, readOnly }),
  );

  // ── Подключение к Claude Code ──────────────────────────────
  out();
  if (hasCommand('claude')) {
    out('Подключаю плагин к Claude Code…');
    const connected =
      run(`claude plugin marketplace add ${REPO}`) &&
      run(`claude plugin install ${PLUGIN}@${MARKETPLACE}`);
    out();
    if (connected) {
      await reportServerCheck();
    } else {
      out('Подключить командой не вышло. Выполните в Claude Code вручную:');
      manualPluginSteps();
    }
  } else {
    out('Claude Code в PATH не нашёлся. Выполните в нём вручную:');
    manualPluginSteps();
  }

  out();
  out('Другой клиент MCP — запускайте сервер по полному пути, без npx:');
  if (isEphemeral(serverEntry())) {
    // Запуск через npx живёт во временном кэше: путь оттуда работает до
    // первой уборки, и советовать его — подкладывать грабли.
    out(`  npm i -g ${PACKAGE_NAME}`);
    out(`  ${PACKAGE_NAME} status   — покажет путь, который надо вписать в клиент`);
  } else {
    out(`  node "${serverEntry()}"`);
  }
  out();
  out(`Проверить в любой момент: ${PACKAGE_NAME} status`);
  return 0;
}

/** Проверяет поставленный плагин и говорит, что делать дальше. */
async function reportServerCheck(): Promise<void> {
  const entry = installedPluginEntry();
  if (!entry) {
    out('Плагин установлен, но файла сервера в кэше не нашлось.');
    out(`Ожидался: ${join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE, PLUGIN)}`);
    out('Обновите маркетплейс: claude plugin marketplace update operbots');
    return;
  }

  out('Проверяю запуск сервера…');
  const { ok, detail } = await checkServer(entry);
  if (ok) {
    out(`Сервер отвечает: ${detail}.`);
    out('Перезапустите Claude Code — плагин подхватится.');
    return;
  }

  out('Плагин установлен, но сервер не поднялся. Вот что он сказал:');
  out();
  for (const line of detail.split('\n').slice(0, 12)) out(`  ${line}`);
  out();
  out(`Запустить вручную и посмотреть целиком: node "${entry}" --version`);
}

/** Какое дело подставлять, когда инструмент вызван без него. */
async function pickCase(cases: PanelCase[]): Promise<string | null> {
  if (cases.length === 0) return null;

  out();
  out('Дело по умолчанию — его подставят, когда дело не названо.');
  out('  0. любое — то, что открыто в панели последним');
  cases.forEach((item, index) => out(`  ${index + 1}. ${item.emoji} ${item.name}`));

  const answer = await ask('Номер', '0');
  const chosen = cases[Number(answer) - 1];
  return chosen ? (chosen.slug ?? chosen.name) : null;
}

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

  if (!flags.token && !config.token) {
    out();
    out(`Токен выпускается в панели: ${base}/dashboard/account → Интеграции → «Выпустить токен».`);
    out('Значение показывается один раз — скопируйте его сразу.');
    out();
  }

  const token = flags.token ?? config.token ?? (await askSecret('Токен'));
  if (!token) {
    out('Без токена войти нельзя.');
    return 1;
  }

  const auth = new AuthManager({ ...config, baseUrl: base, token: null });
  try {
    const user = await auth.signIn(base, token);
    const api = new OperbotsApi(auth, { ...config, baseUrl: base, token: null });
    const cases = await api
      .get<{ name: string; emoji: string }[]>('/cases')
      .catch(() => [] as { name: string; emoji: string }[]);

    out();
    out(`Вход выполнен: ${user.display_name} <${user.email}>`);
    out(`Панель: ${base}`);
    out(
      `Доступно дел: ${cases.length}` +
        (cases.length ? ` — ${cases.map((item) => `${item.emoji} ${item.name}`).join(', ')}` : ''),
    );
    if (!user.profile_completed) {
      out();
      out('Внимание: профиль не заполнен — откройте панель и пройдите шаг знакомства,');
      out('иначе API закрыт целиком.');
    }
    out();
    out(`Токен сохранён в ${config.credentialsPath}`);
    out('Отозвать его можно в панели: аккаунт → Интеграции.');
    out();
    out('Подключить к Claude Code — одной командой:');
    out(`  npx ${PACKAGE_NAME}@latest setup`);
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
    base = flags.url ? normalizeBaseUrl(flags.url) : ((await auth.knownBaseUrl()) ?? '');
  } catch (error) {
    out(describeError(error));
    return 1;
  }
  if (!base) {
    out('Сохранённого доступа нет — выходить не из чего.');
    return 0;
  }

  const removed = await withCredentialsLock(config.credentialsPath, () =>
    removeProfile(config.credentialsPath, base),
  );
  auth.forget();

  out(
    removed
      ? `Токен для ${base} удалён с этой машины.`
      : `Сохранённого доступа к ${base} не было.`,
  );
  out('Сам токен продолжает действовать — отзовите его в панели: аккаунт → Интеграции.');
  return 0;
}

export async function status(): Promise<number> {
  const config = await applyProfileSettings(loadConfig());
  const { current, profiles } = await listProfiles(config.credentialsPath);

  out(`${PACKAGE_NAME} ${VERSION}`);
  out(`Файл доступа: ${config.credentialsPath}`);
  // Путь к серверу — это то, что вписывают в клиент MCP руками. Спрашивать
  // его больше негде, поэтому печатаем здесь.
  out(`Файл сервера: ${serverEntry()}${isEphemeral(serverEntry()) ? ' (временный кэш npx!)' : ''}`);
  out();

  if (profiles.length === 0 && !config.token) {
    out('Вход не выполнен. Выполните: operbots-mcp login');
    return 1;
  }

  for (const profile of profiles) {
    const mark = profile.baseUrl === current ? '→' : ' ';
    const who = profile.displayName ?? profile.email ?? 'неизвестно кто';
    const kind = profile.token ? 'токен' : 'устаревший доступ по паролю';
    out(`${mark} ${profile.baseUrl} — ${who} (${kind}, обновлён ${profile.updatedAt})`);
  }
  if (config.token) out('  токен задан переменной OPERBOTS_TOKEN');
  out();

  const auth = new AuthManager(config);
  const api = new OperbotsApi(auth, config);
  try {
    const user = await auth.whoami();
    const cases = await api.get<
      { name: string; emoji: string; permissions: string[]; role_name: string | null; is_owner: boolean }[]
    >('/cases');

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
  operbots-mcp setup           установка целиком: токен, настройки, плагин
  operbots-mcp                 запустить сервер MCP (так его вызывает Claude Code)
  operbots-mcp login           только сохранить токен доступа к панели
  operbots-mcp logout          удалить токен с этой машины
  operbots-mcp status          проверить связь с панелью и показать права
  operbots-mcp tools           перечислить доступные инструменты

Ключи команд setup и login:
  --url <адрес>                адрес панели, например https://panel.example.com
  --token <${TOKEN_PREFIX}…>            токен, если не хочется вводить его отдельно

Переменные окружения:
  OPERBOTS_URL                 адрес панели
  OPERBOTS_TOKEN               токен доступа вместо сохранённого файла
  OPERBOTS_CASE                дело по умолчанию: название или идентификатор
  OPERBOTS_READ_ONLY=1         оставить только инструменты чтения
  OPERBOTS_CREDENTIALS         путь к файлу с сохранённым доступом
  OPERBOTS_TIMEOUT_MS          сколько ждать ответ панели, по умолчанию 30000
  OPERBOTS_INSECURE_TLS=1      не проверять сертификат панели

Токен выпускается в панели: аккаунт → Интеграции → «Выпустить токен».

Подключение к Claude Code:
  npx ${PACKAGE_NAME}@latest setup`);
  return 0;
}

// ── Разбор ключей ────────────────────────────────────────────

function parseFlags(argv: string[]): { url?: string; token?: string } {
  const flags: { url?: string; token?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--url') flags.url = argv[++index];
    else if (item === '--token') flags.token = argv[++index];
  }
  return flags;
}
