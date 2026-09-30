/** Real MCP -> HTTP -> PostgreSQL check against tests/backend-fixture.py only. */
import assert from 'node:assert/strict';
import { readFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fixturePath = process.env.OPERBOTS_QA_FIXTURE;
assert.ok(fixturePath, 'OPERBOTS_QA_FIXTURE must point to the disposable backend fixture');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.database, 'operbots_mcp_qa', 'Refusing to mutate a non-QA database');
assert.equal(new URL(fixture.url).hostname, '127.0.0.1');
const directory = await mkdtemp(join(tmpdir(), 'operbots-backend-check-'));
const clients = [];
async function connect(token, readOnly = false) {
  const client = new Client({ name: 'operbots-backend-qa', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')],
    cwd: directory, env: { ...process.env, OPERBOTS_URL: fixture.url, OPERBOTS_TOKEN: token,
      OPERBOTS_CASE: fixture.case_id, OPERBOTS_READ_ONLY: readOnly ? '1' : '0',
      OPERBOTS_CREDENTIALS: join(directory, 'credentials.json') }, stderr: 'pipe' }));
  clients.push(client);
  return client;
}
async function call(client, name, args = {}, error = false) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError === true, error, `${name}: ${result.content[0].text}`);
  return result.content[0].text;
}
function json(text) { return JSON.parse(text.slice(text.indexOf('\n\n') + 2)); }
async function get(path, token = fixture.owner_token) {
  const response = await fetch(`${fixture.url}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response.json();
}
let assertions = 0;
try {
  const owner = await connect(fixture.owner_token);
  const viewer = await connect(fixture.viewer_token);
  const readonly = await connect(fixture.owner_token, true);
  await call(owner, 'whoami');
  await call(owner, 'cases_get');
  await call(owner, 'bots_status', { bot: fixture.bot_id });
  await call(owner, 'bots_webhook_info');
  assertions += 4;
  await call(owner, 'members_list');
  await call(owner, 'users_search', { query: 'Viewer' });
  await call(owner, 'market_list');
  await call(owner, 'operbots_catalog', { what: 'node_kinds', platform: 'telegram' });
  assertions += 4;
  await call(owner, 'flows_save', { bot: fixture.bot_id, name: 'QA flow',
    nodes: [{ id: 'start', kind: 'trigger.command', config: { command: 'start' }, x: 10, y: 20 },
      { id: 'reply', kind: 'action.message', config: { text: 'Hi' }, width: 400, data: { color: 'sky' } }],
    edges: [{ id: 'edge', from: 'start', to: 'reply', data: { highlight: true } }],
    comments: [{ id: 'note', text: 'Keep this note', color: 'sky', x: 40, y: 50 }],
    viewport: { x: 12, y: 24, zoom: 0.9 } });
  const flowRoot = `/cases/${fixture.case_id}/bots/${fixture.bot_id}/flows`;
  const flowId = (await get(flowRoot)).find(flow => flow.name === 'QA flow').id;
  let flow = await get(`${flowRoot}/${flowId}`);
  await call(owner, 'flows_save', { bot: fixture.bot_id, flow: flowId,
    nodes: flow.graph.nodes.map(node => ({ id: node.id, kind: node.data.kind, title: 'Changed' })) });
  flow = await get(`${flowRoot}/${flowId}`);
  assert.equal(flow.graph.comments[0].text, 'Keep this note');
  assert.equal(flow.graph.nodes[1].width, 400);
  assert.equal(flow.graph.nodes[1].data.config.text, 'Hi');
  assert.equal(flow.graph.edges[0].data.highlight, true);
  assert.equal(flow.graph.viewport.zoom, 0.9);
  await call(owner, 'flows_simulate', { bot: fixture.bot_id, flow: flowId, command: 'start' });
  await call(owner, 'flows_save', { bot: fixture.bot_id, copy_of: flowId, name: 'QA copy', description: null });
  assert.equal((await get(flowRoot)).some(flow => flow.name === 'QA copy'), true);
  assertions += 4;
  await call(owner, 'broadcasts_save', { bot: fixture.bot_id, title: 'QA draft', text: 'Hi',
    audience: { joined_after: '2000-01-01', tags: ['qa'] } });
  const broadcastId = (await get(`/cases/${fixture.case_id}/broadcasts`)).items.find(item => item.title === 'QA draft').id;
  await call(owner, 'broadcasts_save', { broadcast: broadcastId, audience: {} });
  const clearedAudience = (await get(`/cases/${fixture.case_id}/broadcasts/${broadcastId}`)).audience;
  assert.equal(clearedAudience.joined_after, null);
  assert.deepEqual(clearedAudience.tags, []);
  await call(owner, 'broadcasts_preview', { bot: fixture.bot_id, text: 'Hi', audience: { joined_after: '2000-01-01' } });
  await call(owner, 'broadcasts_targets', { broadcast: broadcastId });
  await call(owner, 'broadcasts_delete', { broadcast: broadcastId, confirm_name: 'QA draft' });
  assertions += 5;
  await call(owner, 'knowledge_save', { name: 'QA knowledge', active: false });
  const baseId = (await get(`/cases/${fixture.case_id}/knowledge`)).find(item => item.name === 'QA knowledge').id;
  await call(owner, 'knowledge_add_document', { base: baseId, title: 'QA file', source: 'file', text: 'Extracted QA text' });
  const docs = await get(`/cases/${fixture.case_id}/knowledge/${baseId}/documents`);
  assert.equal(docs[0].source, 'file');
  await call(owner, 'knowledge_document', { base: baseId, document: docs[0].id });
  await call(owner, 'knowledge_delete', { base: baseId, confirm_name: 'QA knowledge' });
  assertions += 4;
  const party = json(await call(owner, 'counterparties_save', { name: 'Client', custom_fields: { contract: 'QA' } }));
  await call(owner, 'counterparties_link', { counterparty_id: party.id, dialog_id: fixture.dialog_id });
  assert.equal(json(await call(owner, 'counterparties_dialogs', { dialog_id: fixture.dialog_id })).id, party.id);
  await call(owner, 'counterparties_settings_save', { mode: 'automatic', match_phone: false, phone_variable: '' });
  assert.equal((await get(`/cases/${fixture.case_id}/counterparties/settings`)).match_email, true);
  assertions += 4;
  const workflow = { steps: [{ id: 'work', title: 'Work' }, { id: 'done', title: 'Done', kind: 'result', result: 'Approved' }], edges: [{ from: 'work', to: 'done' }] };
  const type = json(await call(owner, 'requests_types_save', { name: 'QA type', fields: [], workflow }));
  let request = json(await call(owner, 'requests_save', { title: 'QA request', type_id: type.id,
    source_message_id: fixture.message_id, assignee_id: fixture.owner_id }));
  assert.equal(request.counterparty_id, party.id);
  assert.equal(request.dialog_id, fixture.dialog_id);
  await call(owner, 'requests_save', { request_id: request.id, revision: request.revision, description: 'Changed' });
  await call(owner, 'requests_save', { request_id: request.id, revision: request.revision, title: 'Stale' }, true);
  request = json(await call(owner, 'requests_get', { request_id: request.id }));
  assert.equal(request.title, 'QA request');
  const hidden = json(await call(viewer, 'requests_get', { request_id: request.id }));
  assert.equal(hidden.dialog_id, null);
  assert.equal(hidden.counterparty_id, null);
  await call(viewer, 'requests_save', { title: 'Denied' }, true);
  await call(readonly, 'requests_save', { title: 'Denied' }, true);
  await call(owner, 'requests_get', { case: fixture.other_case_id, request_id: request.id }, true);
  await call(owner, 'requests_comment', { request_id: request.id, text: 'QA note' });
  request = json(await call(owner, 'requests_get', { request_id: request.id }));
  request = json(await call(owner, 'requests_task_complete', { request_id: request.id,
    task_id: request.tasks.find(task => task.status === 'ready').id, revision: request.revision }));
  assert.equal(request.status, 'completed');
  assertions += 11;
  const ext = json(await call(owner, 'extensions_save', { name: 'CRM', base_url: 'https://example.invalid',
    auth: { type: 'bearer', token: 'qa-only-test-secret' }, operations: [{ name: 'Fetch', method: 'GET', path: '/items' }] }));
  assert.equal(ext.auth.token, '');
  const changed = json(await call(owner, 'extensions_save', { extension: ext.id, description: 'Edited' }));
  assert.equal(changed.operations[0].id, ext.operations[0].id);
  assert.equal(changed.auth.type, 'bearer');
  await call(owner, 'extensions_nodes');
  await call(owner, 'notifications_list');
  await call(owner, 'notifications_filters');
  const notificationSettings = await get('/notifications/settings');
  const kind = notificationSettings.kinds[0].kind;
  await call(owner, 'notifications_settings_save', { kinds: { [kind]: false } });
  assert.equal((await get('/notifications/settings')).kinds.find(item => item.kind === kind).enabled, false);
  await call(owner, 'notifications_read', { all: true });
  await call(owner, 'ai_usage', { days: 180 });
  await call(owner, 'account_appearance', { mode: 'dark', density: 'compact' });
  assert.equal((await get('/users/me')).appearance.mode, 'dark');
  assertions += 11;
  await call(owner, 'dialogs_history', { dialog: fixture.dialog_id });
  assert.equal((await get(`/cases/${fixture.case_id}/dialogs/${fixture.dialog_id}`)).unread_count, 2);
  await call(owner, 'dialogs_mark_read', { dialog: fixture.dialog_id });
  assert.equal((await get(`/cases/${fixture.case_id}/dialogs/${fixture.dialog_id}`)).unread_count, 0);
  await call(owner, 'replies_save', { title: 'HTML reply', text: '<b>Hi</b>', parse_mode: 'HTML' });
  assert.equal((await get(`/cases/${fixture.case_id}/replies`))[0].parse_mode, 'HTML');
  await call(owner, 'audit_filters');
  await call(owner, 'audit_list', { action: ['request.create', 'extension.save'], actor_id: fixture.owner_id });
  assertions += 6;
  await call(owner, 'requests_delete', { request_id: request.id, revision: request.revision, confirm_name: 'QA request' });
  await call(owner, 'requests_types_delete', { type_id: type.id, version: type.version, confirm_name: 'QA type' });
  await call(owner, 'extensions_delete', { extension: ext.id, confirm_name: 'CRM' });
  await call(owner, 'counterparties_delete', { counterparty_id: party.id, confirm_name: 'Client' });
  assertions += 4;
  process.stdout.write(`Real backend MCP checks: ${assertions} passed (isolated PostgreSQL, owner/viewer/read-only).\n`);
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  assert.equal(dirname(directory), tmpdir());
  await rm(directory, { recursive: true });
  await unlink(fixturePath);
}
