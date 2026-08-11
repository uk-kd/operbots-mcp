/**
 * Сборка MCP-сервера: подключение к панели и регистрация инструментов.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { OperbotsApi } from './api.js';
import { AuthManager } from './auth.js';
import { PACKAGE_NAME, VERSION, loadConfig, type Config } from './config.js';
import { Context } from './context.js';
import { describeError } from './errors.js';
import { accountTools } from './tools/account.js';
import { aiTools } from './tools/ai.js';
import { botTools } from './tools/bots.js';
import { caseTools } from './tools/cases.js';
import { catalogTools } from './tools/catalog.js';
import { dialogTools } from './tools/dialogs.js';
import { flowTools } from './tools/flows.js';
import { knowledgeTools } from './tools/knowledge.js';
import { peopleTools } from './tools/people.js';
import type { Tool } from './tools/kit.js';

const ALL_TOOLS: Tool[] = [
  ...catalogTools,
  ...accountTools,
  ...caseTools,
  ...peopleTools,
  ...botTools,
  ...flowTools,
  ...dialogTools,
  ...knowledgeTools,
  ...aiTools,
];

/** Что показываем клиенту с учётом режима «только чтение». */
export function selectTools(config: Config): Tool[] {
  return config.readOnly ? ALL_TOOLS.filter((item) => item.kind === 'read') : ALL_TOOLS;
}

export function buildContext(config: Config): Context {
  const auth = new AuthManager(config);
  const api = new OperbotsApi(auth, config);
  return new Context(api, auth, config);
}

export function createServer(config: Config): McpServer {
  const ctx = buildContext(config);

  const server = new McpServer(
    { name: PACKAGE_NAME, version: VERSION },
    {
      instructions:
        'operbots — панель управления телеграм-ботами: дела, боты, сценарии на полотне, ' +
        'диалоги, база знаний и подключения к ИИ.\n\n' +
        'Сервер работает от имени вошедшего пользователя и ограничен ровно его правами: ' +
        'всё, что не позволено роли в панели, вернёт отказ. Начните с whoami, чтобы узнать ' +
        'учётную запись, доступные дела и права в них.\n\n' +
        'Дела, ботов, сценарии и подключения можно указывать по названию — идентификаторы ' +
        'не обязательны. Если дело не указано, берётся дело по умолчанию, иначе последнее ' +
        'открытое в панели.\n\n' +
        'Правка сценария заменяет граф целиком: сначала flows_get, затем flows_save со всеми ' +
        'узлами и связями. Состав настроек каждого вида узла — в operbots_catalog what=node_kinds.',
    },
  );

  for (const item of selectTools(config)) {
    server.registerTool(
      item.name,
      {
        title: item.title,
        description: item.description,
        inputSchema: item.input,
        annotations: {
          title: item.title,
          readOnlyHint: item.kind === 'read',
          destructiveHint: item.kind === 'danger',
          idempotentHint: item.kind === 'read',
          // Панель — внешняя система: её состояние меняется и без нас.
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const text = await item.run(args ?? {}, ctx);
          return { content: [{ type: 'text' as const, text }] };
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: describeError(error) }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

/** Запускает сервер на стандартном вводе-выводе — так его зовёт Claude Code. */
export async function serve(): Promise<void> {
  const config = loadConfig();

  if (config.insecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.stderr.write(
      'operbots-mcp: проверка сертификата отключена (OPERBOTS_INSECURE_TLS).\n',
    );
  }

  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}
