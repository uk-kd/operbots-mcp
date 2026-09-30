/**
 * Учётная запись: кто вошёл, какие права и какие устройства подключены.
 */

import { z } from 'zod';
import { open } from 'node:fs/promises';
import { requireLocalPath } from '../api.js';

import { PACKAGE_NAME, normalizeBaseUrl } from '../config.js';
import { removeProfile, withCredentialsLock } from '../credentials.js';
import { PERMISSIONS } from '../enums.js';
import { ApiError } from '../errors.js';
import { report } from '../format.js';
import { body, tool, type Tool } from './kit.js';

interface Session {
  id: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  expires_at: string;
}

/** Секреты вводят вне MCP: файл читает только локальный сервер. */
async function readSecretFile(path: string): Promise<string> {
  requireLocalPath(path);
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16 * 1024) throw new ApiError(400, 'invalid_secret_file', 'Нужен обычный файл размером до 16 КБ.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

export const accountTools: Tool[] = [
  tool({
    name: 'operbots_login',
    title: 'Подключиться к панели',
    kind: 'write',
    session: true,
    description:
      'Проверяет доступ или подключается по токену из локального token_file. Токен выпускается в самой панели: ' +
      'аккаунт → Интеграции → «Выпустить токен», и показывается там один раз. ' +
      'Человек вводит его через CLI login или локальный файл; формы MCP не запрашивают секреты. Вызывайте, когда другие инструменты ' +
      'сообщают, что доступ не настроен или токен больше не действует.',
    input: {
      url: z
        .string()
        .optional()
        .describe('Адрес панели. По умолчанию сохранённый адрес или http://localhost:8080.'),
      switch_account: z
        .boolean()
        .optional()
        .describe('Подключиться заново, даже если доступ уже настроен.'),
      token_file: z.string().optional().describe('Абсолютный путь к UTF-8 файлу с токеном. Значение читает локальный сервер, в переписку оно не попадает.'),
    },
    async run(args, ctx) {
      ctx.auth.forget();
      ctx.forgetCases();
      if (!args.switch_account && !args.token_file && (await ctx.auth.signedIn())) {
        try {
          const me = await ctx.auth.whoami();
          return (
            `Доступ уже настроен: ${me.display_name} <${me.email}> — панель ${await ctx.auth.baseUrl()}.\n` +
            'Чтобы подключиться заново, вызовите этот же инструмент с switch_account=true.'
          );
        } catch {
          // Токен отозван или просрочен — значит, подключаемся заново.
        }
      }

      const suggested = args.url ?? (await ctx.auth.knownBaseUrl()) ?? 'http://localhost:8080';

      if (!args.token_file) {
        return (
          'Выполните в терминале (токен вводится скрыто):\n' +
          `  npx ${PACKAGE_NAME} login\n` +
          `либо задайте переменные окружения OPERBOTS_URL и OPERBOTS_TOKEN.\n` +
          `Токен выпускается в панели: ${suggested}/dashboard/account → Интеграции.`
        );
      }

      const token = (await readSecretFile(args.token_file)).trim();
      const base = normalizeBaseUrl(suggested);
      const user = await ctx.auth.signIn(base, token);

      const cases = await ctx.caseList(true).catch(() => []);
      return report(`Подключено: ${user.display_name} <${user.email}>`, {
        панель: base,
        профиль_заполнен: user.profile_completed,
        дела:
          cases.length > 0
            ? cases.map(
                (item) =>
                  `${item.emoji} ${item.name} — ${item.is_owner ? 'владелец' : (item.role_name ?? 'без роли')}`,
              )
            : 'ни одного',
        подсказка: !user.profile_completed
          ? 'Профиль не заполнен, и до этого API закрыт целиком. Заполните его отсюда: ' +
            'account_update с фамилией, именем и датой рождения (birth_date).'
          : 'Отозвать токен можно в панели: аккаунт → Интеграции.',
      });
    },
  }),

  tool({
    name: 'operbots_logout',
    title: 'Забыть доступ на этой машине',
    kind: 'danger',
    session: true,
    description:
      'Стирает сохранённый токен с этой машины. Сам токен при этом продолжает действовать — ' +
      'чтобы он перестал работать везде, отзовите его в панели: аккаунт → Интеграции.',
    input: {},
    async run(_args, ctx) {
      const base = await ctx.auth.knownBaseUrl();
      if (!base) return 'Сохранённого доступа нет — забывать нечего.';

      const removed = await withCredentialsLock(ctx.config.credentialsPath, () =>
        removeProfile(ctx.config.credentialsPath, base),
      );
      ctx.config.baseUrl = base;
      ctx.config.token = null;
      ctx.auth.forget();
      ctx.forgetCases();

      return (
        (removed
          ? `Токен для ${base} удалён с этой машины.`
          : `Сохранённого доступа к ${base} не было.`) +
        '\nСам токен продолжает действовать — отзовите его в панели, если он больше не нужен.'
      );
    },
  }),

  tool({
    name: 'whoami',
    title: 'Кто я в панели',
    kind: 'read',
    description:
      'С какой учётной записью работает сервер, к какой панели подключён и какие дела доступны ' +
      'с перечнем прав в каждом. Полезно вызвать первым: дальше можно обращаться к делам по названию.',
    input: {},
    async run(_args, ctx) {
      const me = await ctx.auth.whoami();
      const cases = await ctx.caseList(true);
      const base = await ctx.auth.baseUrl();

      const rows = cases.map((item) => ({
        дело: `${item.emoji} ${item.name}`,
        идентификатор: item.id,
        роль: item.is_owner ? 'владелец' : (item.role_name ?? 'без роли'),
        прав: `${item.permissions.length} из ${PERMISSIONS.length}`,
        боты: `${item.running_bots_count} из ${item.bots_count} работают`,
        непрочитано: item.unread_count || undefined,
        архив: item.is_archived || undefined,
      }));

      return report(`${me.display_name} <${me.email}> — панель ${base}`, {
        профиль: me,
        профиль_заполнен: me.profile_completed,
        часовой_пояс: me.timezone,
        суперпользователь: me.is_superuser || undefined,
        дела: rows.length > 0 ? rows : 'ни одного дела',
        права: 'Сервер работает от имени этой учётной записи и ограничен ровно её правами.',
      });
    },
  }),

  tool({
    name: 'sessions_list',
    title: 'Устройства с входом в панель',
    kind: 'read',
    description:
      'Браузеры и другие устройства, где выполнен вход в панель под этой учётной записью. ' +
      'Токены доступа сюда не попадают — их видно в панели, в разделе «Интеграции».',
    input: {},
    async run(_args, ctx) {
      const sessions = await ctx.api.get<Session[]>('/auth/sessions');

      return report(`Активных входов: ${sessions.length}`, {
        устройства: sessions.map((session) => ({
          идентификатор: session.id,
          устройство: session.user_agent ?? 'неизвестно',
          адрес: session.ip_address ?? '—',
          вход: session.created_at,
          действует_до: session.expires_at,
        })),
      });
    },
  }),

  tool({
    name: 'sessions_revoke',
    title: 'Завершить вход на устройстве',
    kind: 'danger',
    description:
      'Завершает сессию по идентификатору из sessions_list — устройство выкинет из панели. ' +
      'На токены доступа не влияет.',
    input: {
      session_id: z.uuid().optional().describe('Идентификатор сессии из sessions_list.'),
      all: z.boolean().optional().describe('true — завершить входы на всех устройствах. Токены интеграций продолжают действовать.'),
    },
    async run(args, ctx) {
      if (args.all && args.session_id) throw new ApiError(400, 'invalid_selection', 'Укажите session_id или all=true, а не оба.');
      if (args.all) {
        await ctx.api.post('/auth/logout-all');
        return 'Сессии на всех устройствах завершены.';
      }
      if (!args.session_id) throw new ApiError(400, 'selection_required', 'Укажите session_id или all=true.');
      await ctx.api.delete(`/auth/sessions/${args.session_id}`);
      return `Сессия ${args.session_id} завершена.`;
    },
  }),

  tool({
    name: 'account_update',
    title: 'Изменить данные аккаунта',
    kind: 'write',
    description:
      'Меняет ФИО, дату рождения, телефон, часовой пояс и номера в Telegram и MAX учётной ' +
      'записи — по номерам бот шлёт участнику весточки из сценария (узел «Сообщить в чат» с ' +
      'адресатом «участник команды»). Передавайте только ' +
      'те поля, которые нужно изменить: остальные останутся как есть. Этим же инструментом ' +
      'проходят шаг знакомства: пока фамилии, имени и даты рождения нет, API закрыт целиком.',
    input: {
      last_name: z.string().max(80).nullable().optional().describe('Фамилия.'),
      first_name: z.string().max(80).nullable().optional().describe('Имя.'),
      middle_name: z.string().max(80).nullable().optional().describe('Отчество.'),
      birth_date: z
        .string()
        .nullable()
        .optional()
        .describe('Дата рождения в виде ГГГГ-ММ-ДД. Без неё профиль считается незаполненным.'),
      phone: z.string().max(32).nullable().optional().describe('Телефон.'),
      timezone: z.string().max(64).nullable().optional().describe('Часовой пояс, например Europe/Moscow.'),
      avatar_url: z.url().nullable().optional().describe('Адрес аватара; null — удалить.'),
      telegram_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Номер в Telegram (число, не @имя). null — стереть.'),
      max_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Номер человека в MAX. null — стереть.'),
    },
    async run(args, ctx) {
      const payload = Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const user = await ctx.api.patch<Record<string, unknown>>('/users/me', payload);
      return report('Данные обновлены.', {
        имя: user.full_name,
        дата_рождения: user.birth_date,
        телефон: user.phone,
        часовой_пояс: user.timezone,
        telegram_id: user.telegram_id,
        max_id: user.max_id,
        профиль_заполнен: user.profile_completed,
      });
    },
  }),

  tool({ name: 'account_appearance', title: 'Оформление панели', kind: 'write',
    description: 'Меняет язык, тему, акцент, плотность и анимации панели. Пропущенные настройки сохраняет.',
    input: { locale: z.enum(['ru', 'en']).optional(), mode: z.enum(['light', 'dark', 'auto']).optional(),
      accent: z.string().optional(), custom_hue: z.number().int().min(0).max(360).nullable().optional(),
      glass_intensity: z.number().min(0).max(1).optional(), motion: z.enum(['full', 'reduced', 'off']).optional(),
      density: z.enum(['comfortable', 'compact']).optional(), sidebar_collapsed: z.boolean().optional() },
    async run(args, ctx) {
      const previous = await ctx.api.get<{ appearance: Record<string, unknown> }>('/users/me');
      const updated = await ctx.api.put<{ appearance: Record<string, unknown> }>('/users/me/appearance', { ...previous.appearance, ...body(args) });
      return report('Оформление сохранено.', updated.appearance);
    } }),
  tool({ name: 'account_password', title: 'Изменить пароль', kind: 'danger',
    description: 'Меняет пароль из локального JSON-файла с current_password и new_password, созданного человеком вне MCP. Пароли не запрашиваются через формы MCP, не попадают в аргументы или ответ. Прежние браузерные сессии завершаются.',
    input: { password_file: z.string().describe('Абсолютный путь к локальному JSON с current_password и new_password. После смены удалите файл.') }, async run(args, ctx) {
      let payload: { current_password: string; new_password: string };
      try {
        payload = z.object({ current_password: z.string().min(1), new_password: z.string().min(8).max(128) }).strict().parse(JSON.parse(await readSecretFile(args.password_file)));
      } catch {
        throw new ApiError(400, 'invalid_password_file', 'Не удалось прочитать пароль: нужен локальный JSON с current_password и new_password длиной 8–128 знаков.');
      }
      const result = await ctx.api.post<{ message: string }>('/users/me/password', payload);
      return result.message;
    } }),
  tool({ name: 'users_search', title: 'Найти человека для приглашения', kind: 'read',
    description: 'Поиск пользователей по имени или почте. Сервер скрывает чужие полные адреса и номера платформ.',
    input: { query: z.string().trim().min(3).max(120) }, async run(args, ctx) {
      return report('Найденные пользователи.', await ctx.api.get('/users/search', { query: args.query }));
    } }),
  tool({ name: 'account_security', title: 'Безопасность и токены аккаунта', kind: 'read',
    description: 'Ссылка на управление вторым фактором, кодами восстановления и интеграционными токенами. Эти операции требуют браузерной сессии: токен интеграции не может выпускать новые токены или менять второй фактор.',
    input: { section: z.enum(['security', 'integrations']).optional() }, async run(args, ctx) {
      return report('Откройте панель и выполните вход в браузере.', { url: `${await ctx.auth.baseUrl()}/dashboard/account?tab=${args.section ?? 'security'}` });
    } }),
];
