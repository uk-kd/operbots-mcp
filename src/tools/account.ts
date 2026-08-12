/**
 * Учётная запись: кто вошёл, какие права и какие устройства подключены.
 */

import { z } from 'zod';

import { TOKEN_PREFIX } from '../auth.js';
import { PACKAGE_NAME, normalizeBaseUrl } from '../config.js';
import { removeProfile, withCredentialsLock } from '../credentials.js';
import { report } from '../format.js';
import { tool, type Tool } from './kit.js';

interface Session {
  id: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  expires_at: string;
}

export const accountTools: Tool[] = [
  tool({
    name: 'operbots_login',
    title: 'Подключиться к панели',
    kind: 'write',
    description:
      'Открывает окно для адреса панели и токена доступа. Токен выпускается в самой панели: ' +
      'аккаунт → Интеграции → «Выпустить токен», и показывается там один раз. ' +
      'Вводит его человек, в переписку он не попадает. Вызывайте, когда другие инструменты ' +
      'сообщают, что доступ не настроен или токен больше не действует.',
    input: {
      url: z
        .string()
        .optional()
        .describe('Адрес панели, если он известен. Иначе его спросят в окне.'),
      switch_account: z
        .boolean()
        .optional()
        .describe('Подключиться заново, даже если доступ уже настроен.'),
    },
    async run(args, ctx) {
      if (!args.switch_account && (await ctx.auth.signedIn())) {
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

      if (!ctx.prompter?.available()) {
        return (
          'Этот клиент не умеет показывать окно ввода. Выполните в терминале:\n' +
          `  npx ${PACKAGE_NAME} login\n` +
          `либо задайте переменные окружения OPERBOTS_URL и OPERBOTS_TOKEN.\n` +
          `Токен выпускается в панели: ${suggested}/dashboard/account → Интеграции.`
        );
      }

      const answer = await ctx.prompter.form(
        'Подключение к панели operbots. Токен выпускается в самой панели: ' +
          'аккаунт → Интеграции → «Выпустить токен». Он попадёт только на диск этой машины, ' +
          'в переписку с моделью — нет.',
        {
          url: {
            type: 'string',
            title: 'Адрес панели',
            description: 'Например https://panel.example.com',
            default: suggested,
            format: 'uri',
          },
          token: {
            type: 'string',
            title: 'Токен доступа',
            description: `Начинается с ${TOKEN_PREFIX}`,
            minLength: 1,
          },
        },
        ['url', 'token'],
      );

      if (answer.action === 'decline') return 'Подключение отклонено.';
      if (answer.action !== 'accept') return 'Окно закрыто, доступ не настроен.';

      const url = String(answer.content?.url ?? '').trim();
      const token = String(answer.content?.token ?? '').trim();
      if (!url || !token) return 'Не настроено: заполнены не все поля.';

      const base = normalizeBaseUrl(url);
      const user = await ctx.auth.signIn(base, token);
      ctx.forgetCases();

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
          ? 'Профиль не заполнен — откройте панель и пройдите шаг знакомства, иначе API закрыт целиком.'
          : 'Отозвать токен можно в панели: аккаунт → Интеграции.',
      });
    },
  }),

  tool({
    name: 'operbots_logout',
    title: 'Забыть доступ на этой машине',
    kind: 'danger',
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
        прав: `${item.permissions.length} из 27`,
        боты: `${item.running_bots_count} из ${item.bots_count} работают`,
        непрочитано: item.unread_count || undefined,
        архив: item.is_archived || undefined,
      }));

      return report(`${me.display_name} <${me.email}> — панель ${base}`, {
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
      session_id: z.string().describe('Идентификатор сессии из sessions_list.'),
    },
    async run(args, ctx) {
      await ctx.api.delete(`/auth/sessions/${args.session_id}`);
      return `Сессия ${args.session_id} завершена.`;
    },
  }),

  tool({
    name: 'account_update',
    title: 'Изменить данные аккаунта',
    kind: 'write',
    description:
      'Меняет ФИО, телефон и часовой пояс учётной записи. Передавайте только те поля, ' +
      'которые нужно изменить: остальные останутся как есть.',
    input: {
      last_name: z.string().max(80).optional().describe('Фамилия.'),
      first_name: z.string().max(80).optional().describe('Имя.'),
      middle_name: z.string().max(80).optional().describe('Отчество.'),
      phone: z.string().max(32).optional().describe('Телефон.'),
      timezone: z.string().max(64).optional().describe('Часовой пояс, например Europe/Moscow.'),
    },
    async run(args, ctx) {
      const payload = Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(payload).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const user = await ctx.api.patch<Record<string, unknown>>('/users/me', payload);
      return report('Данные обновлены.', {
        имя: user.full_name,
        телефон: user.phone,
        часовой_пояс: user.timezone,
      });
    },
  }),
];
