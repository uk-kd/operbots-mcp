import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { selectTools, buildContext } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';

const caseId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const summary = { id: caseId, name: 'QA', slug: 'qa', emoji: '◆', is_owner: true, permissions: [], is_archived: false };

test('all panel groups are discoverable and read-only exposes no panel mutation', () => {
  const all = selectTools({ readOnly: false });
  const names = all.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const name of ['requests_save', 'counterparties_link', 'extensions_save', 'notifications_list', 'ai_usage', 'account_appearance']) {
    assert.ok(names.includes(name), `Missing panel section tool ${name}`);
  }
  const reads = selectTools({ readOnly: true });
  assert.ok(reads.every(tool => tool.kind === 'read' || tool.session));
  for (const name of ['requests_save', 'notifications_read', 'extensions_save', 'account_password', 'broadcasts_start']) {
    assert.equal(reads.some(tool => tool.name === name), false);
  }
});

test('local logout removes both stored and environment access in the running server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'operbots-logout-'));
  try {
    const config = { ...loadConfig(), credentialsPath: join(dir, 'credentials.json'), baseUrl: 'http://localhost:12345', token: 'opb_qa' };
    const ctx = buildContext(config);
    assert.equal(await ctx.auth.signedIn(), true);
    const tool = selectTools(config).find(tool => tool.name === 'operbots_logout');
    await tool.run({}, ctx);
    assert.equal(await ctx.auth.signedIn(), false);
    await assert.rejects(ctx.auth.token(), /сохранён/);
  } finally { await rm(dir, { recursive: true }); }
});

for (const readOnly of [false, true]) {
  test(`real SDK stdio round trip validates scopes, revisions, errors and readOnly=${readOnly}`, { timeout: 15000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'operbots protocol '));
    const calls = [];
    const api = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      assert.equal(req.headers.authorization, 'Bearer opb_qa');
      res.setHeader('Content-Type', 'application/json');
      const path = req.url.split('?')[0];
      if (path === '/api/v1/users/me') return res.end(JSON.stringify({ id: requestId, email: 'qa@example.org', display_name: 'QA', profile_completed: true, last_case_id: caseId }));
      if (path === '/api/v1/cases') return res.end(JSON.stringify([summary]));
      if (path === `/api/v1/cases/${caseId}/requests` && req.method === 'GET') return res.end(JSON.stringify([{ id: requestId, title: 'Request', revision: 7, workflow: { steps: [], edges: [] } }]));
      if (path === `/api/v1/cases/${caseId}/requests/${requestId}` && req.method === 'PATCH') {
        res.statusCode = 409;
        return res.end(JSON.stringify({ code: 'request_conflict', message: 'Revision conflict' }));
      }
      if (path === `/api/v1/cases/${caseId}/counterparties`) return res.end(JSON.stringify([]));
      if (path === `/api/v1/cases/${caseId}/extensions`) return res.end(JSON.stringify([]));
      if (path === '/api/v1/notifications') return res.end(JSON.stringify({ items: [], total: 0, limit: 30, offset: 0 }));
      if (path === `/api/v1/cases/${caseId}/ai-usage`) return res.end(JSON.stringify({ totals: { total_tokens: 42 }, choices: {} }));
      res.statusCode = 403;
      res.end(JSON.stringify({ code: 'permission_denied', message: 'Denied', details: { required: ['request.manage'] } }));
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], cwd: dir,
      env: { ...process.env, OPERBOTS_URL: `http://127.0.0.1:${api.address().port}`, OPERBOTS_TOKEN: 'opb_qa',
        OPERBOTS_CASE: 'qa', OPERBOTS_CREDENTIALS: join(dir, 'credentials.json'), OPERBOTS_READ_ONLY: readOnly ? '1' : '0' }, stderr: 'pipe' });
    const client = new Client({ name: 'qa', version: '1' });
    try {
      await client.connect(transport);
      const discovered = await client.listTools();
      assert.equal(discovered.tools.length, selectTools({ readOnly }).length);
      for (const name of ['requests_list', 'counterparties_list', 'extensions_list', 'notifications_list', 'ai_usage']) {
        const result = await client.callTool({ name, arguments: {} });
        assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
      }
      const denied = await client.callTool({ name: 'requests_get', arguments: { request_id: requestId } });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /request.manage/);
      if (!readOnly) {
        const conflict = await client.callTool({ name: 'requests_save', arguments: { request_id: requestId, revision: 7, title: 'Changed' } });
        assert.equal(conflict.isError, true);
        assert.match(conflict.content[0].text, /Revision conflict/);
        assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
        assert.equal(calls.find(call => call.method === 'PATCH').body.revision, 7);
        const before = calls.length;
        const invalid = await client.callTool({ name: 'requests_save', arguments: { request_id: 'not-a-uuid', revision: 7 } });
        assert.equal(invalid.isError, true);
        assert.equal(calls.length, before, 'invalid inputs must not reach HTTP');
      } else {
        const before = calls.length;
        const unavailable = await client.callTool({ name: 'requests_save', arguments: { request_id: requestId, revision: 7 } });
        assert.equal(unavailable.isError, true);
        assert.equal(calls.length, before, 'hidden write must not reach HTTP');
      }
    } finally {
      await client.close();
      api.closeAllConnections();
      await new Promise(done => api.close(done));
      await rm(dir, { recursive: true });
    }
  });
}
