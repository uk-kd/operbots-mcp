/**
 * Люди в деле: участники, роли и ссылки-приглашения.
 *
 * Итоговые права участника считаются как «права роли + выданные
 * точечно − отозванные»; у владельца всегда полный набор.
 */

import { z } from 'zod';

import type { Context } from '../context.js';
import { PERMISSIONS, ROLE_PRESETS } from '../enums.js';
import { ApiError } from '../errors.js';
import { report } from '../format.js';
import { caseField, body, optional, tool, type Tool } from './kit.js';

interface Role {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: boolean;
  position: number;
  members_count: number;
}

interface Member {
  id: string;
  user: { id: string; email: string; display_name: string; full_name: string };
  role: Role | null;
  is_owner: boolean;
  extra_permissions: string[];
  revoked_permissions: string[];
  effective_permissions: string[];
  note: string | null;
  last_seen_at: string | null;
}

interface Invite {
  id: string;
  email: string | null;
  role: Role | null;
  url: string;
  expires_at: string;
  max_uses: number;
  uses: number;
}

const permission = z.enum(PERMISSIONS);

async function findRole(ctx: Context, caseId: string, hint: string): Promise<Role> {
  const roles = await ctx.api.get<Role[]>(`/cases/${caseId}/roles`);
  const needle = hint.trim().toLowerCase();

  const match =
    roles.find((role) => role.id === hint) ??
    roles.find((role) => role.slug.toLowerCase() === needle) ??
    roles.find((role) => role.name.toLowerCase() === needle) ??
    roles.find((role) => role.name.toLowerCase().includes(needle));

  if (!match) {
    throw new ApiError(
      404,
      'role_not_found',
      `Роли «${hint}» нет в деле. Есть: ${roles.map((role) => `${role.name} (${role.slug})`).join(', ')}`,
    );
  }
  return match;
}

async function findMember(ctx: Context, caseId: string, hint: string): Promise<Member> {
  const members = await ctx.api.get<Member[]>(`/cases/${caseId}/members`);
  const needle = hint.trim().toLowerCase();

  const match =
    members.find((item) => item.id === hint) ??
    members.find((item) => item.user.id === hint) ??
    members.find((item) => item.user.email.toLowerCase() === needle) ??
    members.find((item) => item.user.display_name.toLowerCase() === needle) ??
    members.find((item) => item.user.full_name.toLowerCase().includes(needle));

  if (!match) {
    throw new ApiError(
      404,
      'member_not_found',
      `Участника «${hint}» в деле нет. Есть: ${members.map((item) => `${item.user.display_name} <${item.user.email}>`).join('; ')}`,
    );
  }
  return match;
}

const showRole = (role: Role) => ({
  роль: role.name,
  идентификатор: role.id,
  короткое_имя: role.slug,
  описание: role.description,
  системная: role.is_system || undefined,
  участников: role.members_count,
  прав: role.permissions.length,
  права: role.permissions,
});

export const peopleTools: Tool[] = [
  tool({
    name: 'members_list',
    title: 'Участники, роли и приглашения',
    kind: 'read',
    description:
      'Кто состоит в деле, с какой ролью и какими итоговыми правами; какие роли заведены ' +
      'в деле и какие ссылки-приглашения действуют. Разделы, на которые не хватает прав, ' +
      'помечаются как недоступные.',
    input: {
      case: caseField,
      with_permissions: z
        .boolean()
        .optional()
        .describe('Показывать полный список прав каждого участника. По умолчанию нет.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const [members, roles, invites] = await Promise.all([
        optional(ctx.api.get<Member[]>(`/cases/${found.id}/members`)),
        optional(ctx.api.get<Role[]>(`/cases/${found.id}/roles`)),
        optional(ctx.api.get<Invite[]>(`/cases/${found.id}/invites`)),
      ]);

      return report(`Люди в деле «${found.name}»`, {
        участники:
          typeof members === 'string'
            ? members
            : members.map((item) => ({
                человек: `${item.user.display_name} <${item.user.email}>`,
                участие: item.id,
                роль: item.is_owner ? 'владелец' : (item.role?.name ?? 'без роли'),
                прав: item.effective_permissions.length,
                выдано_дополнительно: item.extra_permissions.length ? item.extra_permissions : undefined,
                отозвано: item.revoked_permissions.length ? item.revoked_permissions : undefined,
                права: args.with_permissions ? item.effective_permissions : undefined,
                пометка: item.note,
                был_в_деле: item.last_seen_at,
              })),
        роли:
          typeof roles === 'string'
            ? roles
            : roles.map((role) => ({
                роль: role.name,
                идентификатор: role.id,
                короткое_имя: role.slug,
                системная: role.is_system || undefined,
                участников: role.members_count,
                прав: role.permissions.length,
                права: args.with_permissions ? role.permissions : undefined,
              })),
        приглашения:
          typeof invites === 'string'
            ? invites
            : invites.length === 0
              ? 'нет действующих'
              : invites.map((invite) => ({
                  идентификатор: invite.id,
                  для: invite.email ?? 'для любого по ссылке',
                  роль: invite.role?.name ?? 'по умолчанию',
                  ссылка: invite.url,
                  использовано: `${invite.uses} из ${invite.max_uses}`,
                  действует_до: invite.expires_at,
                })),
      });
    },
  }),

  tool({
    name: 'members_save',
    title: 'Добавить участника или изменить его права',
    kind: 'write',
    description:
      'Без параметра member добавляет в дело уже зарегистрированного человека по почте. ' +
      'С параметром member меняет его роль и точечные права поверх роли. ' +
      'Если человек ещё не зарегистрирован, создайте ссылку-приглашение через invites_create.',
    input: {
      case: caseField,
      member: z
        .string()
        .optional()
        .describe('Кого менять: почта, имя или идентификатор участия. Не указывайте для добавления.'),
      email: z.string().optional().describe('Почта того, кого добавляем в дело.'),
      role: z
        .string()
        .optional()
        .describe(
          `Роль: название, короткое имя или идентификатор. Готовые: ${ROLE_PRESETS.join(', ')}. ` +
            'По умолчанию при добавлении назначается «оператор».',
        ),
      extra_permissions: z
        .array(permission)
        .optional()
        .describe('Права поверх роли. Заменяет прежний список целиком.'),
      revoked_permissions: z
        .array(permission)
        .optional()
        .describe('Права, отбираемые у участника вопреки роли. Заменяет прежний список целиком.'),
      note: z.string().max(240).optional().describe('Служебная пометка об участнике.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const role = args.role ? await findRole(ctx, found.id, args.role) : null;

      if (!args.member) {
        if (!args.email) return 'Чтобы добавить человека, нужна его почта.';
        const created = await ctx.api.post<Member>(
          `/cases/${found.id}/members`,
          body({ email: args.email, role_id: role?.id, note: args.note }),
        );
        return report('Участник добавлен.', {
          человек: `${created.user.display_name} <${created.user.email}>`,
          участие: created.id,
          роль: created.role?.name ?? 'без роли',
          прав: created.effective_permissions.length,
        });
      }

      const member = await findMember(ctx, found.id, args.member);
      const updated = await ctx.api.patch<Member>(
        `/cases/${found.id}/members/${member.id}`,
        body({
          role_id: role?.id,
          extra_permissions: args.extra_permissions,
          revoked_permissions: args.revoked_permissions,
          note: args.note,
        }),
      );

      return report('Права участника обновлены.', {
        человек: `${updated.user.display_name} <${updated.user.email}>`,
        роль: updated.is_owner ? 'владелец' : (updated.role?.name ?? 'без роли'),
        выдано_дополнительно: updated.extra_permissions,
        отозвано: updated.revoked_permissions,
        итоговые_права: updated.effective_permissions,
      });
    },
  }),

  tool({
    name: 'members_remove',
    title: 'Исключить участника',
    kind: 'danger',
    description:
      'Убирает человека из дела. Он теряет доступ ко всем ботам, сценариям и переписке дела. ' +
      'Владельца исключить нельзя.',
    input: {
      case: caseField,
      member: z.string().describe('Кого исключить: почта, имя или идентификатор участия.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const member = await findMember(ctx, found.id, args.member);
      await ctx.api.delete(`/cases/${found.id}/members/${member.id}`);
      return `${member.user.display_name} <${member.user.email}> исключён из дела «${found.name}».`;
    },
  }),

  tool({
    name: 'case_transfer',
    title: 'Передать дело',
    kind: 'danger',
    description:
      'Делает другого участника владельцем дела. Прежний владелец переводится в администраторы ' +
      'и теряет право на повторную передачу — вернуть дело сможет только новый владелец.',
    input: {
      case: z.string().describe('Дело: название или идентификатор.'),
      member: z.string().describe('Новый владелец: почта, имя или идентификатор участия.'),
      confirm_name: z.string().describe('Точное название дела — подтверждение передачи.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      if (args.confirm_name.trim() !== found.name) {
        return `Не передаю: подтверждение «${args.confirm_name}» не совпадает с названием «${found.name}».`;
      }

      const member = await findMember(ctx, found.id, args.member);
      const owner = await ctx.api.post<Member>(`/cases/${found.id}/members/${member.id}/transfer`);
      ctx.forgetCases();
      return report(`Дело «${found.name}» передано.`, {
        новый_владелец: `${owner.user.display_name} <${owner.user.email}>`,
        роль: owner.role?.name ?? 'владелец',
      });
    },
  }),

  tool({
    name: 'roles_save',
    title: 'Создать или изменить роль',
    kind: 'write',
    description:
      'Заводит в деле свою роль с нужным набором прав или меняет существующую. ' +
      'Готовые роли (владелец, администратор, конструктор, оператор, наблюдатель) правке ' +
      'не поддаются — укажите copy_of, чтобы сделать копию пресета и настроить её.',
    input: {
      case: caseField,
      role: z.string().optional().describe('Какую роль менять. Не указывайте, чтобы создать новую.'),
      copy_of: z
        .string()
        .optional()
        .describe('Скопировать эту роль (обычно готовый пресет), чтобы править копию.'),
      name: z.string().min(2).max(80).optional().describe('Название роли.'),
      description: z.string().max(1000).optional().describe('Описание роли.'),
      accent: z.string().max(24).optional().describe('Цвет метки роли.'),
      permissions: z
        .array(permission)
        .optional()
        .describe('Набор прав. Заменяет прежний целиком, а не дополняет его.'),
      position: z.number().int().optional().describe('Порядок в списке ролей.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const changes = body({
        name: args.name,
        description: args.description,
        accent: args.accent,
        permissions: args.permissions,
        position: args.position,
      });

      if (args.copy_of) {
        const source = await findRole(ctx, found.id, args.copy_of);
        const copy = await ctx.api.post<Role>(`/cases/${found.id}/roles/${source.id}/duplicate`);
        const result =
          Object.keys(changes).length > 0
            ? await ctx.api.patch<Role>(`/cases/${found.id}/roles/${copy.id}`, changes)
            : copy;
        return report(`Роль «${source.name}» скопирована.`, showRole(result));
      }

      if (!args.role) {
        if (!args.name) return 'Чтобы создать роль, нужно название.';
        const created = await ctx.api.post<Role>(`/cases/${found.id}/roles`, {
          name: args.name,
          ...changes,
          permissions: args.permissions ?? [],
        });
        return report('Роль создана.', showRole(created));
      }

      const role = await findRole(ctx, found.id, args.role);
      if (Object.keys(changes).length === 0) return 'Нечего менять: не передано ни одного поля.';

      const updated = await ctx.api.patch<Role>(`/cases/${found.id}/roles/${role.id}`, changes);
      return report('Роль обновлена.', showRole(updated));
    },
  }),

  tool({
    name: 'roles_delete',
    title: 'Удалить роль',
    kind: 'danger',
    description:
      'Удаляет роль дела. Готовые роли удалить нельзя, и роль с участниками — тоже: ' +
      'сначала переведите людей на другую роль.',
    input: {
      case: caseField,
      role: z.string().describe('Роль: название, короткое имя или идентификатор.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const role = await findRole(ctx, found.id, args.role);
      await ctx.api.delete(`/cases/${found.id}/roles/${role.id}`);
      return `Роль «${role.name}» удалена.`;
    },
  }),

  tool({
    name: 'invites_create',
    title: 'Создать приглашение',
    kind: 'write',
    description:
      'Делает ссылку для вступления в дело — в том числе для человека, который ещё не ' +
      'зарегистрирован в панели. Ссылку сервер никуда не отправляет: её нужно передать самому. ' +
      'Любой, у кого есть ссылка, войдёт в дело с указанной ролью.',
    input: {
      case: caseField,
      email: z
        .string()
        .optional()
        .describe('Ограничить приглашение одной почтой. Без этого ссылка сработает у кого угодно.'),
      role: z.string().optional().describe('Роль для вступающего. По умолчанию «оператор».'),
      max_uses: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Сколько раз можно воспользоваться ссылкой. По умолчанию 1.'),
      ttl_hours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .optional()
        .describe('Сколько часов ссылка действует. По умолчанию 72, максимум 720 (30 суток).'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const role = args.role ? await findRole(ctx, found.id, args.role) : null;

      const invite = await ctx.api.post<Invite>(
        `/cases/${found.id}/invites`,
        body({
          email: args.email,
          role_id: role?.id,
          max_uses: args.max_uses,
          ttl_hours: args.ttl_hours,
        }),
      );

      return report('Приглашение создано. Ссылку передайте человеку сами.', {
        ссылка: invite.url,
        идентификатор: invite.id,
        для: invite.email ?? 'для любого по ссылке',
        роль: invite.role?.name ?? 'по умолчанию',
        использований: invite.max_uses,
        действует_до: invite.expires_at,
      });
    },
  }),

  tool({
    name: 'invites_revoke',
    title: 'Отозвать приглашение',
    kind: 'danger',
    description: 'Гасит ссылку-приглашение: перейти по ней больше не получится.',
    input: {
      case: caseField,
      invite_id: z.string().describe('Идентификатор приглашения из members_list.'),
    },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      await ctx.api.delete(`/cases/${found.id}/invites/${args.invite_id}`);
      return 'Приглашение отозвано, ссылка больше не работает.';
    },
  }),
];
