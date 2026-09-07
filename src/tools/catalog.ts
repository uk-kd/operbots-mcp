/**
 * Справочники панели: из чего можно собирать сценарии, какие бывают
 * ИИ-сервисы и права. Один инструмент вместо четырёх — справочники
 * запрашивают редко и обычно по одному. Готовые сценарии здесь больше
 * не живут: они переехали в маркет (market_list, market_install).
 */

import { z } from 'zod';

import { BOT_PLATFORMS, FLOW_SCOPES } from '../enums.js';
import { report } from '../format.js';
import { tool, type Tool } from './kit.js';

interface NodeType {
  kind: string;
  group: string;
  title: string;
  description: string;
  inputs: number;
  outputs: string[];
  config_schema: Record<string, unknown>[];
}

interface AIKind {
  kind: string;
  title: string;
  description: string;
  docs_url: string | null;
  default_model: string;
  models: string[];
  credential_fields: { key: string; label: string; secret?: boolean; required?: boolean }[];
  requires_base_url: boolean;
}

interface Platform {
  slug: string;
  title: string;
  capabilities: string[];
  media_kinds: string[];
  parse_modes: string[];
  limits: {
    text: number;
    caption: number;
    upload: number;
    button_value: number;
    /** Чем меряется значение кнопки: у Telegram байты, у MAX знаки. */
    button_value_unit: 'bytes' | 'chars';
    buttons_per_row: number;
    button_rows: number;
  };
  token_hint: string;
  token_where: string;
}

interface PermissionInfo {
  key: string;
  group: string;
  title: string;
  description: string;
  dangerous: boolean;
}

export const catalogTools: Tool[] = [
  tool({
    name: 'operbots_catalog',
    title: 'Справочники панели',
    kind: 'read',
    description:
      'Что можно использовать при сборке: платформы с их пределами, виды узлов сценария с ' +
      'полным составом их настроек, разделы маркета, виды ИИ-сервисов с нужными ключами ' +
      'и каталог прав. Готовые сценарии ищите в маркете: market_list и market_install. Смотрите node_kinds перед тем, как собирать или править сценарий: ' +
      'config каждого узла описан именно там — и передавайте platform: сами узлы у платформ ' +
      'одни и те же, а варианты в их настройках разные (у MAX нет разметки MarkdownV2 и ' +
      'голосового среди вложений).',
    input: {
      what: z
        .enum(['platforms', 'node_kinds', 'market_categories', 'ai_kinds', 'permissions'])
        .describe('Какой справочник показать.'),
      kind: z
        .string()
        .optional()
        .describe('Показать подробно только один вид: например action.ai или openai.'),
      platform: z
        .enum(BOT_PLATFORMS)
        .optional()
        .describe(
          'Для node_kinds: под какую платформу отобрать варианты настроек. Без него ' +
            'придёт полный набор, и сценарий можно собрать с вариантом, которого у ' +
            'платформы бота нет.',
        ),
      scope: z
        .enum(FLOW_SCOPES)
        .optional()
        .describe(
          'Для node_kinds: под какой вид сценария — dialog (личная переписка) или ' +
            'community (группы и каналы). Без него — узлы обоих видов, у каждого поле scopes.',
        ),
    },
    async run(args, ctx) {
      switch (args.what) {
        case 'platforms': {
          const list = await ctx.api.get<Platform[]>('/platforms');
          return report(
            `Платформ: ${list.length}`,
            list.map((item) => ({
              платформа: item.slug,
              название: item.title,
              токен: `${item.token_hint} — ${item.token_where}`,
              умеет: item.capabilities,
              вложения: item.media_kinds,
              разметка: item.parse_modes,
              предел_текста: item.limits.text,
              предел_подписи: item.limits.caption,
              предел_файла: `${Math.round(item.limits.upload / (1024 * 1024))} МБ`,
              значение_кнопки:
                `${item.limits.button_value} ` +
                (item.limits.button_value_unit === 'bytes' ? 'байт' : 'знаков'),
              кнопок_в_ряду: item.limits.buttons_per_row,
              рядов_кнопок: item.limits.button_rows,
            })),
          );
        }

        case 'node_kinds': {
          const list = await ctx.api.get<NodeType[]>('/flow-nodes', {
            platform: args.platform,
            scope: args.scope,
          });
          const wanted = args.kind
            ? list.filter((item) => item.kind === args.kind || item.kind.includes(args.kind ?? ''))
            : list;

          if (wanted.length === 0) {
            return `Узла «${args.kind}» нет. Есть: ${list.map((item) => item.kind).join(', ')}`;
          }

          // Без явного отбора состав настроек не разворачиваем: полный
          // каталог с ним занимает несколько экранов и мешает читать.
          const detailed = Boolean(args.kind) || wanted.length <= 3;
          return report(
            `Видов узлов: ${wanted.length}`,
            wanted.map((item) => ({
              узел: item.kind,
              раздел: item.group,
              название: item.title,
              описание: item.description,
              выходы: item.outputs.length > 0 ? item.outputs : 'один',
              настройки: detailed
                ? item.config_schema
                : `${item.config_schema.length} полей — запросите с kind=${item.kind}`,
            })),
          );
        }

        case 'market_categories': {
          const list = await ctx.api.get<{ key: string; title: string }[]>('/market/categories');
          return report(
            `Разделов маркета: ${list.length}`,
            list.map((item) => ({ ключ: item.key, название: item.title })),
          );
        }

        case 'ai_kinds': {
          const list = await ctx.api.get<AIKind[]>('/ai-providers/catalog');
          const wanted = args.kind ? list.filter((item) => item.kind === args.kind) : list;
          return report(
            `Видов ИИ-сервисов: ${wanted.length}`,
            wanted.map((item) => ({
              вид: item.kind,
              название: item.title,
              описание: item.description,
              документация: item.docs_url,
              модель_по_умолчанию: item.default_model,
              модели: item.models,
              нужен_адрес_сервера: item.requires_base_url || undefined,
              ключи: item.credential_fields.map(
                (field) =>
                  `${field.key} — ${field.label}` +
                  (field.required ? ' (обязательно)' : '') +
                  (field.secret ? ', секрет' : ''),
              ),
            })),
          );
        }

        case 'permissions': {
          const list = await ctx.api.get<PermissionInfo[]>('/cases/permissions');
          const groups = new Map<string, PermissionInfo[]>();
          for (const item of list) {
            const bucket = groups.get(item.group) ?? [];
            bucket.push(item);
            groups.set(item.group, bucket);
          }

          return report(
            `Прав в системе: ${list.length}`,
            Object.fromEntries(
              [...groups].map(([group, items]) => [
                group,
                items.map(
                  (item) =>
                    `${item.key} — ${item.title}: ${item.description}` +
                    (item.dangerous ? ' [опасное]' : ''),
                ),
              ]),
            ),
          );
        }

        default:
          return 'Неизвестный справочник.';
      }
    },
  }),
];
