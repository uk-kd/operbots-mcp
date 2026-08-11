/**
 * Справочники панели: из чего можно собирать сценарии, какие бывают
 * ИИ-сервисы и права. Один инструмент вместо четырёх — справочники
 * запрашивают редко и обычно по одному.
 */

import { z } from 'zod';

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

interface Template {
  key: string;
  title: string;
  description: string;
  nodes: number;
  edges: number;
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
      'Что можно использовать при сборке: виды узлов сценария с полным составом их настроек, ' +
      'заготовки сценариев, виды ИИ-сервисов с нужными ключами и каталог прав. ' +
      'Смотрите node_kinds перед тем, как собирать или править сценарий: config каждого узла ' +
      'описан именно там.',
    input: {
      what: z
        .enum(['node_kinds', 'flow_templates', 'ai_kinds', 'permissions'])
        .describe('Какой справочник показать.'),
      kind: z
        .string()
        .optional()
        .describe('Показать подробно только один вид: например action.ai или openai.'),
    },
    async run(args, ctx) {
      switch (args.what) {
        case 'node_kinds': {
          const list = await ctx.api.get<NodeType[]>('/flow-nodes');
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

        case 'flow_templates': {
          const list = await ctx.api.get<Template[]>('/flow-templates');
          return report(
            `Заготовок сценариев: ${list.length}`,
            list.map((item) => ({
              ключ: item.key,
              название: item.title,
              описание: item.description,
              узлов: item.nodes,
              связей: item.edges,
            })),
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
