import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(join(resolve(process.argv[3] ?? root), 'package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const plugin = join(root, 'plugins', 'operbots-mcp');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const portable = read(join(plugin, 'plugin.json'));
const mcp = read(join(plugin, 'mcp.json'));
const claude = read(join(plugin, '.claude-plugin', 'plugin.json'));
const overlay = read(join(plugin, '.codex-plugin', 'plugin.json'));
const version = read(join(root, 'package.json')).version;

await test('release versions agree across clients', () => {
  for (const manifest of [portable, claude, overlay]) {
    assert.equal(manifest.name, 'operbots-mcp');
    assert.equal(manifest.version, version);
  }
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
});

for (const [clientName, config, variable] of [
  ['Codex', mcp.mcpServers.operbots, '${PLUGIN_ROOT}'],
  ['Claude Code', claude.mcpServers.operbots, '${CLAUDE_PLUGIN_ROOT}'],
]) {
  for (const readOnly of [false, true]) {
    await test(`${clientName}: packaged handshake and tools, readOnly=${readOnly}`, { timeout: 15000 }, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'operbots mcp test '));
      const expand = value => value.replaceAll(variable, plugin);
      const args = config.args.map(expand);
      assert.ok(args.every(arg => !arg.includes('${')), 'unresolved client-specific variable');
      const transport = new StdioClientTransport({
        command: config.command === 'node' ? process.execPath : config.command,
        args,
        cwd: config.cwd ? expand(config.cwd) : cwd,
        env: { ...process.env, OPERBOTS_CREDENTIALS: join(cwd, 'credentials.json'),
          OPERBOTS_URL: '', OPERBOTS_TOKEN: '', OPERBOTS_READ_ONLY: readOnly ? '1' : '0' },
        stderr: 'pipe',
      });
      let errors = '';
      transport.stderr?.on('data', chunk => { errors += chunk; });
      const client = new Client({ name: 'operbots-plugin-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        assert.equal(client.getServerVersion().version, version);
        const { tools } = await client.listTools();
        assert.equal(tools.length, readOnly ? 31 : 82, errors);
        assert.ok(tools.some(tool => tool.name === 'whoami'));
        assert.ok(tools.some(tool => tool.name === 'operbots_login'));
        if (readOnly) assert.ok(!tools.some(tool => tool.name === 'broadcasts_start'));
      } finally { await client.close(); }
    });
  }
}
