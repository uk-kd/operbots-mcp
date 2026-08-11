/**
 * Разносит версию из package.json по остальным файлам выпуска.
 *
 * Версия живёт в четырёх местах: пакет, плагин Claude Code и две записи
 * в server.json — сервера и его пакета. Реестр MCP отклоняет публикацию
 * при расхождении, а плагин молча остаётся со старым номером, поэтому
 * правка вручную рано или поздно расходится. Запускается сам из
 * `npm version` — правленые файлы попадают в тот же коммит.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const write = (path, value) =>
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const { version } = read('package.json');

const plugin = read('plugins/operbots-mcp/.claude-plugin/plugin.json');
plugin.version = version;
write('plugins/operbots-mcp/.claude-plugin/plugin.json', plugin);

const server = read('server.json');
server.version = version;
for (const item of server.packages ?? []) item.version = version;
write('server.json', server);

process.stdout.write(`Версия ${version} разнесена: plugin.json, server.json\n`);
