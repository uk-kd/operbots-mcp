/**
 * Кладёт сервер внутрь плагина Claude Code — одним файлом.
 *
 * Плагин раньше поднимал сервер через `npx -y operbots-mcp`, а такая
 * команда разрешается заново при каждом запуске и в чужом окружении:
 * на Windows `npx` — это `.cmd`, и клиент, порождающий процесс без
 * оболочки, получает ENOENT; на холодном кэше первый старт уходит в
 * реестр и не укладывается в рукопожатие; про Node ниже двадцатого
 * `npx` вообще молчит. Поэтому плагин везёт сервер с собой: запуск
 * настоящим `node` по полному пути, без сети и без установки.
 *
 * Зависимости вшиты в файл намеренно. Иначе рядом пришлось бы держать
 * `node_modules`, а это тысячи файлов в репозитории ради двух пакетов.
 */

import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', 'operbots-mcp');
const outDir = join(plugin, 'dist');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  // Часть зависимостей внутри — обычные модули CommonJS и зовут require.
  // В модуле ESM его нет, поэтому заводим свой.
  banner: {
    js:
      "import { createRequire as __nodeRequire } from 'node:module';\n" +
      'const require = __nodeRequire(import.meta.url);',
  },
  metafile: true,
});

/**
 * Свой package.json рядом с файлом — не формальность.
 *
 * Без `"type": "module"` Node прочитает `index.js` как CommonJS и
 * упадёт на первом же импорте, а сервер читает из этого файла своё имя
 * и версию, чтобы представиться клиенту.
 */
writeFileSync(
  join(plugin, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: 'Собранный сервер плагина. Собирается из src — править здесь нечего.',
      private: true,
      type: 'module',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
process.stdout.write(
  `Плагин собран: plugins/operbots-mcp/dist/index.js, ${Math.round(bytes / 1024)} КБ\n`,
);
