import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { ApiError } from '../dist/errors.js';
import { botTools, findProvider } from '../dist/tools/bots.js';
import { peopleTools, findMember } from '../dist/tools/people.js';
import { knowledgeTools, findBase } from '../dist/tools/knowledge.js';
import { marketTools, findItem } from '../dist/tools/market.js';
import { selectTools } from '../dist/server.js';

const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = '2026-01-02T03:04:05Z';
const user = { id: U, email: 'test@example.invalid', display_name: 'Test User',
  full_name: 'Test User Full', initials: 'TU', avatar_url: 'https://example.invalid/user.png',
  telegram_id: 123, max_id: 456 };
const bot = { id: B, case_id: C, name: 'Bot', platform: 'telegram', username: 'test_bot',
  description: null, mode: 'polling', status: 'stopped', status_message: null,
  is_enabled: true, autostart: true, token_hint: 'hidden', external_id: 987,
  avatar_url: 'https://example.invalid/bot.png', ai_provider_id: null, settings: { language: 'ru' },
  stats: { received: 17 }, dialogs_count: 2, unread_count: 1,
  active_flow_id: null, active_flows: {}, webhook_url: 'https://example.invalid/hook/PRIVATE_KEY',
  webhook_ready: true, webhook_hint: '', started_at: null, last_update_at: null,
  archived_at: at, created_at: at, updated_at: at };
const role = { id: 'role-1', case_id: C, name: 'Operator', slug: 'operator', description: null,
  accent: 'blue', permissions: ['case.view'], is_system: false, position: 4, members_count: 1 };
const member = { id: 'member-1', case_id: C, user, role, is_owner: false,
  extra_permissions: [], revoked_permissions: [], effective_permissions: ['case.view'],
  note: 'note', created_at: at, last_seen_at: at };
const invite = { id: 'invite-1', case_id: C, email: null, role, token: 'SAFE_INVITE-1',
  url: 'https://example.invalid/invite/SAFE_INVITE-1', expires_at: at, accepted_at: at,
  max_uses: 3, uses: 1, created_at: at };
const base = { id: 'base-1', case_id: C, name: 'Manual', description: null, provider_id: null,
  embedding_model: 'embedding', chunk_size: 900, chunk_overlap: 120, top_k: 4,
  min_score: 0.25, is_active: true, documents_count: 1, chunks_count: 1, ready_count: 1,
  created_at: at, updated_at: at, created_by: user };
const document = { id: 'doc-1', base_id: base.id, title: 'Policy', source: 'url',
  source_url: 'https://example.invalid/policy', status: 'ready', error: null,
  chunks_count: 1, chars: 4, indexed_at: at, created_at: at, updated_at: at,
  content: 'text', chunks: [{ ordinal: 0, text: 'text' }] };
const item = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', slug: 'support-bot',
  source: 'community', title: 'Поддержка', summary: 'Помощь', category: 'other', scope: 'dialog',
  version: 3, facts: { nodes: 1, edges: 0, triggers: [], kinds: ['start'], needs: {}, platforms: ['telegram'] },
  installs_count: 2, likes_count: 1, author_name: 'Test User', origin_case_name: 'Case',
  show_origin: true, origin_case_id: C, published_at: at, updated_at: at, liked: true,
  installed: [{ flow_id: 'installed-flow', bot_id: B, bot_name: 'Bot', version: 2 }],
  origin_flow_id: 'origin-flow', description: 'Description', graph: {}, versions: [] };
const tools = [...botTools, ...peopleTools, ...knowledgeTools, ...marketTools];

function entry(name) {
  const value = tools.find(tool => tool.name === name);
  assert.ok(value, `tool ${name} is missing`);
  return value;
}

function harness(handler) {
  const calls = [];
  const forgotten = [];
  const api = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map(method => [method,
    async (path, payload, query) => {
      calls.push({ method, path, payload, query });
      return handler(method, path, payload, query);
    }]));
  const ctx = { api,
    resolveCase: async () => ({ id: C, name: 'Case' }),
    resolveBot: async (_caseId, hint) => hint === 'Target' ? { ...bot, id: T, name: 'Target' } : bot,
    forgetBots: id => forgotten.push(id), forgetCases: () => forgotten.push('cases') };
  return { ctx, calls, forgotten,
    run: async (name, args) => {
      const tool = entry(name);
      return tool.run(z.object(tool.input).parse(args), ctx);
    } };
}

test('bot creation applies enabled, settings and AI detach after creation', async () => {
  const h = harness((method, _path, payload) => ({ ...bot, ...(method === 'patch' ? payload : {}) }));
  await h.run('bots_save', { name: 'Bot', token: 'BOT_TEST_ONLY', description: null,
    enabled: false, settings: { language: 'en' }, ai_provider: null });
  assert.deepEqual(h.calls.map(({ method, path, payload }) => ({ method, path, payload })), [
    { method: 'post', path: `/cases/${C}/bots`,
      payload: { name: 'Bot', token: 'BOT_TEST_ONLY', description: null } },
    { method: 'patch', path: `/cases/${C}/bots/${B}`,
      payload: { is_enabled: false, settings: { language: 'en' }, ai_provider_id: null } },
  ]);
});

test('bot cards preserve backend identifiers, settings, statistics, archive and timestamps without webhook keys', async () => {
  const h = harness((_method, path) => path.endsWith('/commands') ? [
    { id: 'command-id', bot_id: B, command: 'start', description: '', is_visible: true,
      position: 0, flow_id: null, node_id: null },
  ] : path.endsWith('/variables') ? [
    { id: 'variable-id', bot_id: B, key: 'price', value: '100', description: null, is_secret: false },
  ] : path.endsWith('/flows') ? [] : bot);
  const output = await h.run('bots_get', { bot: 'Bot' });
  for (const expected of [C, '987', 'bot.png', 'received: 17', 'language: ru',
    'command-id', 'variable-id', 'архивирован', at]) assert.ok(output.includes(expected), expected);
  assert.ok(!output.includes('PRIVATE_KEY'));
});

test('live bot status reads the runtime status route', async () => {
  const h = harness(() => ({ id: B, status: 'running', here: true, uptime_seconds: 55, checked_at: at }));
  const output = await h.run('bots_status', { bot: 'Bot' });
  assert.equal(h.calls[0].path, `/cases/${C}/bots/${B}/status`);
  assert.ok(output.includes('55'));
  assert.equal(entry('bots_status').kind, 'read');
});

test('panel webhook readiness is available independently of a bot', async () => {
  const h = harness(() => ({ webhook_ready: false, public_url: 'http://localhost', hint: 'HTTPS required' }));
  const output = await h.run('bots_webhook_info', {});
  assert.equal(h.calls[0].path, `/cases/${C}/bots/webhook-info`);
  assert.ok(output.includes('HTTPS required'));
});

test('bot detach requires exact confirmation and forwards preservation choices and the target bot', async () => {
  const h = harness(() => ({ ok: true, message: 'Archived' }));
  await h.run('bots_detach', { bot: 'Bot', confirm_name: 'bot' });
  assert.equal(h.calls.length, 0);
  const output = await h.run('bots_detach', { bot: 'Bot', confirm_name: 'Bot',
    keep_flows: true, keep_dialogs: false, keep_broadcasts: false, keep_journal: true, flows_to: 'Target' });
  assert.deepEqual(h.calls[0], { method: 'post', path: `/cases/${C}/bots/${B}/detach`,
    payload: { name: 'Bot', keep_flows: true, keep_dialogs: false, keep_broadcasts: false,
      keep_journal: true, flows_to: T }, query: undefined });
  assert.ok(output.includes('Archived'));
  assert.equal(entry('bots_detach').kind, 'danger');
});

test('command updates can explicitly clear both scenario links', async () => {
  const h = harness((method) => method === 'get' ? [
    { id: 'cmd-1', bot_id: B, command: 'start', description: '', is_visible: true,
      position: 0, flow_id: 'flow-1', node_id: 'node-1' },
  ] : {});
  await h.run('bots_commands_apply', { bot: 'Bot', sync: false,
    commands: [{ command: 'start', flow: null, node_id: null }] });
  assert.deepEqual(h.calls[1].payload, { flow_id: null, node_id: null, position: 0 });
});

test('variable metadata updates preserve values and new variables require a value before writes', async () => {
  const h = harness(method => method === 'get' ? [
    { id: 'var-1', bot_id: B, key: 'price', value: '100', description: null, is_secret: true },
  ] : {});
  await h.run('bots_variables_set', { bot: 'Bot', variables: [{ key: 'price', secret: false }] });
  assert.deepEqual(h.calls[1].payload, { is_secret: false });
  h.calls.length = 0;
  await assert.rejects(h.run('bots_variables_set', { bot: 'Bot',
    variables: [{ key: 'price', value: '200' }, { key: 'new' }] }),
    error => error instanceof ApiError && error.status === 400);
  assert.equal(h.calls.filter(call => call.method !== 'get').length, 0);
});

test('ambiguous providers, roles, members and knowledge bases cannot select the first record', async () => {
  const providers = [{ id: 'p1', name: 'Help one' }, { id: 'p2', name: 'Help two' }];
  const h = harness((_method, path) => path.endsWith('/ai-providers') ? providers :
    path.endsWith('/members') ? [member, { ...member, id: 'm2',
      user: { ...user, id: 'u2', email: 'other@example.invalid', display_name: 'Test Other', full_name: 'Test Other Full' } }] :
    path.endsWith('/roles') ? [{ ...role, name: 'Help one' }, { ...role, id: 'r2', slug: 'help-two', name: 'Help two' }] :
    [{ ...base, name: 'Help one' }, { ...base, id: 'base-2', name: 'Help two' }]);
  for (const action of [() => findProvider(h.ctx, C, 'Help'), () => findMember(h.ctx, C, 'Test'),
    () => findBase(h.ctx, C, 'Help'), () => h.run('roles_delete', { role: 'Help' })]) {
    await assert.rejects(action(), error => error instanceof ApiError && error.code === 'ambiguous');
  }
  assert.equal(h.calls.filter(call => call.method === 'delete').length, 0);
});

test('member creation applies explicit no-role and individual rights instead of dropping them', async () => {
  const h = harness((_method, _path, payload) => ({ ...member,
    role: payload?.role_id === null ? null : role,
    extra_permissions: payload?.extra_permissions ?? [],
    revoked_permissions: payload?.revoked_permissions ?? [] }));
  await h.run('members_save', { email: user.email, role: null, note: null,
    extra_permissions: ['bot.view'], revoked_permissions: ['case.view'] });
  assert.deepEqual(h.calls.map(({ method, path, payload }) => ({ method, path, payload })), [
    { method: 'post', path: `/cases/${C}/members`, payload: { email: user.email, role_id: null, note: null } },
    { method: 'patch', path: `/cases/${C}/members/member-1`,
      payload: { role_id: null, extra_permissions: ['bot.view'], revoked_permissions: ['case.view'] } },
  ]);
});

test('role creation accepts a slug and nullable description; slug updates are rejected', async () => {
  const h = harness(() => role);
  await h.run('roles_save', { name: 'Operator', slug: 'custom-op', description: null });
  assert.deepEqual(h.calls[0].payload,
    { name: 'Operator', slug: 'custom-op', description: null, permissions: [] });
  await assert.rejects(h.run('roles_save', { role: 'Operator', slug: 'renamed' }),
    error => error instanceof ApiError && error.status === 400);
});

test('member lists expose user and role metadata and invite acceptance dates', async () => {
  const h = harness((_method, path) => path.endsWith('/members') ? [member] : path.endsWith('/roles') ? [role] : [invite]);
  const output = await h.run('members_list', {});
  for (const expected of [U, C, 'role-1', 'blue', 'Test User Full', 'user.png',
    'telegram_id: 123', 'max_id: 456', 'принято', at]) assert.ok(output.includes(expected), expected);
});

test('member list explains an invitation link redacted by the current backend', async () => {
  const hidden = { ...invite, token: '', url: '' };
  const h = harness((_method, path) => path.endsWith('/members') ? [member]
    : path.endsWith('/roles') ? [role] : [hidden]);
  const output = await h.run('members_list', {});
  assert.ok(output.includes(invite.id));
  assert.ok(output.includes('member.invite'));
  assert.ok(!output.includes(invite.url));
  assert.ok(!output.includes(invite.token));
  assert.equal(h.calls.length, 3);
});

for (const active of [true, false]) {
  test(`market installation reports the actual activation state: ${active}`, async () => {
    const flow = { id: 'installed-flow', bot_id: B, name: 'Installed', scope: 'dialog',
      is_active: active, version: 1, graph: { nodes: [], edges: [] }, problems: [] };
    const h = harness((method, path) => method === 'post' && path.endsWith('/install')
      ? { flow, warnings: [] } : item);
    const output = await h.run('market_install', { bot: 'Bot', item: item.id });
    assert.equal(output.includes('В работу не включён'), !active);
    if (active) assert.ok(output.includes('включён в работу'));
    assert.equal(h.calls.filter(call => call.method === 'post').length, 1);
  });
}

test('invite preview and acceptance use token-specific routes and reject path syntax', async () => {
  const h = harness(method => method === 'get'
    ? { token: 'SAFE_INVITE-1', status: 'ok', case_id: C, case_name: 'Case',
      case_emoji: '◆', case_description: null, case_accent: 'blue', role_name: 'Operator',
      invited_by: 'Test', email_hint: null, expires_at: at, max_uses: 3, uses: 1 }
    : { id: C, name: 'Case', slug: 'case' });
  await h.run('invites_get', { token: 'SAFE_INVITE-1' });
  await h.run('invites_accept', { token: 'SAFE_INVITE-1' });
  assert.deepEqual(h.calls.map(({ method, path }) => ({ method, path })), [
    { method: 'get', path: '/cases/invites/SAFE_INVITE-1' },
    { method: 'post', path: '/cases/invites/SAFE_INVITE-1/accept' },
  ]);
  assert.ok(h.forgotten.includes('cases'));
  await assert.rejects(h.run('invites_get', { token: '../bad?query=1' }), z.ZodError);
  await assert.rejects(h.run('invites_accept', { token: 'bad/path' }), z.ZodError);
});

test('knowledge documents preserve file source with already extracted text', async () => {
  const h = harness(method => method === 'get' ? [base] : document);
  await h.run('knowledge_add_document', { base: 'Manual', source: 'file', title: 'Policy.txt', text: 'extracted text' });
  assert.deepEqual(h.calls[1].payload, { source: 'file', title: 'Policy.txt', content: 'extracted text' });
});

test('refetch rejects incompatible title or text before sending a mutation', async () => {
  const h = harness((_method, path) => path.endsWith('/knowledge') ? [base] : path.endsWith('/documents') ? [document] : document);
  await assert.rejects(h.run('knowledge_document_update', { base: 'Manual', document: 'Policy',
    refetch: true, title: 'New title' }), error => error instanceof ApiError && error.status === 400);
  assert.equal(h.calls.filter(call => call.method !== 'get').length, 0);
});

test('knowledge search with external embedding use is hidden in read-only mode', () => {
  assert.equal(entry('knowledge_search').kind, 'write');
  assert.ok(!selectTools({ readOnly: true }).some(tool => tool.name === 'knowledge_search'));
});

test('knowledge GET output keeps creator and date metadata for bases and documents', async () => {
  const h = harness((_method, path) => path.endsWith('/knowledge') ? [base] :
    path.endsWith('/documents') ? [document] : document);
  const list = await h.run('knowledge_list', { base: 'Manual' });
  for (const expected of [C, U, at, 'создан', 'обновлён']) assert.ok(list.includes(expected), expected);
  const detail = await h.run('knowledge_document', { base: 'Manual', document: 'Policy' });
  for (const expected of ['base-1', at, 'создан', 'обновлён']) assert.ok(detail.includes(expected), expected);
});

test('knowledge document deletion rejects ambiguous titles', async () => {
  const h = harness((_method, path) => path.endsWith('/knowledge') ? [base] : [
    { ...document, title: 'Help one' }, { ...document, id: 'doc-2', title: 'Help two' },
  ]);
  await assert.rejects(h.run('knowledge_delete', { base: 'Manual', document: 'Help' }),
    error => error instanceof ApiError && error.code === 'ambiguous');
  assert.equal(h.calls.filter(call => call.method === 'delete').length, 0);
});

test('market filters by explicit origin and returns publication and installation identities', async () => {
  const h = harness(() => ({ items: [item], total: 1, limit: 30, offset: 0 }));
  const output = await h.run('market_list', { origin_case_id: T });
  assert.equal(h.calls[0].payload.origin_case_id, T);
  for (const expected of [item.id, C, B, 'installed-flow', 'версия: 2', 'мой_лайк: да']) {
    assert.ok(output.includes(expected), expected);
  }
});

test('market lookup supports slugs absent from searchable title and description', async () => {
  const h = harness((_method, path, query) => path === '/market/items'
    ? { items: query?.query ? [] : [item], total: query?.query ? 0 : 1, limit: 100, offset: 0 } : item);
  assert.equal((await findItem(h.ctx, 'support-bot')).id, item.id);
  const output = await h.run('market_get', { item: item.id });
  assert.ok(output.includes('origin-flow'));
});
