/**
 * Разносит версию из package.json по остальным файлам выпуска.
 *
 * Номер живёт в двух местах: пакет и плагин Claude Code. Плагин молча
 * остаётся со старым номером, если поправить только package.json, а
 * замечают это уже пользователи — у них в списке плагинов чужая
 * версия. Запускается сам из `npm version`, поэтому правленые файлы
 * попадают в тот же коммит.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const write = (path, value) =>
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const { version } = read('package.json');

for (const path of [
  'plugins/operbots-mcp/.claude-plugin/plugin.json',
  'plugins/operbots-mcp/.codex-plugin/plugin.json',
  'plugins/operbots-mcp/plugin.json',
]) {
  const plugin = read(path);
  plugin.version = version;
  write(path, plugin);
}

process.stdout.write(`Version ${version} synchronized for Claude Code and Codex\n`);
