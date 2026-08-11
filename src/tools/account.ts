/**
 * Учётная запись: кто вошёл, какие права и какие клиенты подключены.
 */

import { z } from 'zod';

import { PACKAGE_NAME } from '../config.js';
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

      return report(
        `${me.display_name} <${me.email}> — панель ${base}`,
        {
          профиль_заполнен: me.profile_completed,
          часовой_пояс: me.timezone,
          суперпользователь: me.is_superuser || undefined,
          дела: rows.length > 0 ? rows : 'ни одного дела',
          права: 'Сервер работает от имени этой учётной записи и ограничен ровно её правами.',
        },
      );
    },
  }),

  tool({
    name: 'sessions_list',
    title: 'Активные подключения',
    kind: 'read',
    description:
      'Все действующие сессии учётной записи: браузеры и MCP-клиенты. Показывает устройство, ' +
      'адрес и срок. Позволяет заметить лишнее подключение и отозвать его.',
    input: {},
    async run(_args, ctx) {
      const sessions = await ctx.api.get<Session[]>('/auth/sessions');

      const decorate = (session: Session) => ({
        идентификатор: session.id,
        устройство: session.user_agent ?? 'неизвестно',
        адрес: session.ip_address ?? '—',
        подключено: session.created_at,
        действует_до: session.expires_at,
      });

      const mcp = sessions.filter((item) => item.user_agent?.startsWith(PACKAGE_NAME));
      const other = sessions.filter((item) => !item.user_agent?.startsWith(PACKAGE_NAME));

      return report(`Активных сессий: ${sessions.length}`, {
        подключения_mcp: mcp.length > 0 ? mcp.map(decorate) : 'нет',
        прочие_устройства: other.length > 0 ? other.map(decorate) : 'нет',
      });
    },
  }),

  tool({
    name: 'sessions_revoke',
    title: 'Отозвать подключение',
    kind: 'danger',
    description:
      'Завершает сессию по идентификатору из sessions_list. Отозванный клиент теряет доступ ' +
      'при следующем обновлении токена. Отозвав собственную сессию, придётся входить заново.',
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
