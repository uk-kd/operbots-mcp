#!/usr/bin/env node
/**
 * Точка входа.
 *
 * Без аргументов запускается сервер MCP на стандартном вводе-выводе —
 * именно так его поднимает Claude Code. Всё остальное — команды для
 * человека в терминале.
 */

import { VERSION } from './config.js';
import { describeError } from './errors.js';
import { help, login, logout, status, tools } from './cli.js';
import { serve } from './server.js';

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case 'serve':
      await serve();
      return 0;
    case 'login':
      return login(rest);
    case 'logout':
      return logout(rest);
    case 'status':
      return status();
    case 'tools':
      return tools();
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      process.stderr.write(`Неизвестная команда: ${command}\n\n`);
      help();
      return 1;
  }
}

main()
  .then((code) => {
    // Запущенный сервер живёт на своём транспорте: выход не форсируем.
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
