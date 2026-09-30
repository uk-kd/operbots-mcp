import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { flowTools } from '../dist/tools/flows.js';
import { dialogTools } from '../dist/tools/dialogs.js';
import { catalogTools } from '../dist/tools/catalog.js';
import { PERMISSIONS } from '../dist/enums.js';

const caseId = '10000000-0000-4000-8000-000000000001';
const botId = '10000000-0000-4000-8000-000000000002';
const flowId = '10000000-0000-4000-8000-000000000003';
const dialogId = '10000000-0000-4000-8000-000000000004';
const messageId = '10000000-0000-4000-8000-000000000005';
const broadcastId = '10000000-0000-4000-8000-000000000006';
const personId = '10000000-0000-4000-8000-000000000007';
const memberId = '10000000-0000-4000-8000-000000000008';
const copyId = '10000000-0000-4000-8000-000000000009';
const taskId = '10000000-0000-4000-8000-000000000010';
const flowRoot = `/cases/${caseId}/bots/${botId}/flows`;
const dialogRoot = `/cases/${caseId}/dialogs/${dialogId}`;
const broadcastRoot = `/cases/${caseId}/broadcasts`;
const when = '2026-10-01T12:00:00+03:00';
const graph = {
  nodes: [{ id: 'start', type: 'operbots', width: 230, height: 90,
    position: { x: 10, y: 20 }, data: { kind: 'trigger.text', title: 'Start',
      config: { text: 'Hello' }, color: 'sky', outputs: ['out'] } }],
  edges: [{ id: 'link', source: 'start', target: 'start', sourceHandle: 'out',
    targetHandle: 'in', label: 'Go', data: { label: 'Go', color: 'rose', style: 'step' } }],
  viewport: { x: 50, y: -20, zoom: 0.75 },
  comments: [{ id: 'note', text: 'Keep this note', color: 'sky', position: { x: 90, y: 80 } }],
};
const flow = { id: flowId, bot_id: botId, bot_name: 'Bot', name: 'Flow', description: '',
  scope: 'dialog', is_active: false, version: 2, graph, published_at: null,
  updated_at: when, problems: [] };
const dialog = { id: dialogId, bot_id: botId, bot_name: 'Bot', chat_id: 123,
  chat_type: 'private', member_status: null, flow_id: null, username: 'customer',
  contact_name: 'Customer', mode: 'bot', operator: null, assigned_operator_id: personId,
  is_ai_enabled: true, is_blocked: false, is_pinned: false, tags: ['customer'],
  variables: {}, unread_count: 3, message_count: 3, last_message_at: when,
  last_message_preview: 'Hello', external_user_id: 456, language_code: 'en',
  ai_memory: { summary: 'A remembered agreement' }, created_at: when };
const message = { id: messageId, text: 'Hello', direction: 'outgoing', author: 'bot',
  operator: null, node_id: null, error: null, payload: {}, created_at: when };
const reply = { id: messageId, title: 'Greeting', text: '<b>Hello</b>', parse_mode: 'HTML',
  uses: 0, last_used_at: null, author: null, created_at: when };
const buttons = [[{ text: 'Read', url: 'https://example.test' }],
  [{ text: 'Write', url: 'mailto:hello@example.test' }]];
const broadcast = { id: broadcastId, bot_id: botId, bot_name: 'Bot', title: 'Newsletter',
  text: 'Hello', parse_mode: '', buttons, attachment: { kind: 'document',
    file_name: 'invoice.pdf', file_size: 1234, file_id: 'stored-file' },
  audience: { tags: ['customer'], assigned_to: personId, joined_after: '2026-09-01',
    exclude_tags: [], quiet_days: null, language: null, skip_broadcast_id: null, mode: null },
  audience_text: 'Customers', status: 'draft', run_at: null, started_at: null,
  finished_at: null, total: 0, sent: 0, failed: 0, skipped: 0, error: null, created_at: when };
const tools = [...flowTools, ...dialogTools, ...catalogTools];
function entry(name) {
  const tool = tools.find(item => item.name === name);
  assert.ok(tool, `Missing tool ${name}`);
  return tool;
}
function schema(name) { return z.object(entry(name).input).strict(); }
async function invoke(name, args, ctx) {
  return entry(name).run(schema(name).parse(args), ctx);
}
function page(items) { return { items, total: items.length, offset: 0, limit: 40 }; }
function context(responses = {}) {
  const calls = [];
  const defaults = {
    [`get ${flowRoot}`]: [flow],
    [`get ${flowRoot}/${flowId}`]: flow,
    [`get ${dialogRoot}`]: dialog,
    [`get ${dialogRoot}/messages`]: [message],
    [`get /cases/${caseId}/members`]: [{ id: memberId, user: {
      id: personId, email: 'agent@example.test', display_name: 'Agent', full_name: 'Agent',
    } }],
    [`get /cases/${caseId}/dialogs`]: page([dialog]),
    [`get /cases/${caseId}/dialogs/unread`]: { data: { unread: 3 } },
    [`get ${broadcastRoot}`]: page([broadcast]),
    [`get ${broadcastRoot}/${broadcastId}`]: broadcast,
    [`get /cases/${caseId}/replies`]: [reply],
  };
  const api = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method, async (path, payload) => {
      calls.push([method, path, payload]);
      const key = `${method} ${path}`;
      if (Object.hasOwn(responses, key)) return structuredClone(responses[key]);
      if (Object.hasOwn(defaults, key)) return structuredClone(defaults[key]);
      if (path.includes('/flows')) return { ...structuredClone(flow), ...payload };
      if (path.includes('/replies')) return { ...reply, ...payload };
      if (path.includes('/broadcasts')) return { ...structuredClone(broadcast), ...payload };
      if (path.endsWith('/messages')) return { ...message, ...payload };
      return { ...dialog, ok: true, message: 'Done', ...payload };
    },
  ]));
  api.upload = async (...args) => {
    calls.push(['upload', ...args]);
    return args[0].includes('/messages') ? message : broadcast;
  };
  api.download = async (...args) => {
    calls.push(['download', ...args]);
    return { path: args[1], bytes: 1234, content_type: 'application/pdf' };
  };
  return { api, calls, config: { readOnly: false },
    resolveCase: async () => ({ id: caseId, name: 'Case', permissions: PERMISSIONS }),
    resolveBot: async () => ({ id: botId, name: 'Bot' }) };
}
const flowArgs = { bot: 'Bot', flow: flowId };
const dialogArgs = { dialog: dialogId };
const broadcastArgs = { broadcast: broadcastId };
function mutation(ctx, method) { return ctx.calls.find(call => call[0] === method); }

test('flow save preserves comments, styles, labels, handles, sizes and viewport', async () => {
  const ctx = context();
  await invoke('flows_save', { ...flowArgs, nodes: [{ id: 'start', kind: 'trigger.text' }] }, ctx);
  const saved = mutation(ctx, 'put')[2].graph;
  assert.deepEqual(saved.comments, graph.comments);
  assert.deepEqual(saved.edges, graph.edges);
  assert.deepEqual(saved.nodes, graph.nodes);
  assert.deepEqual(saved.viewport, graph.viewport);
});

test('flow comments and viewport can be edited without replacing nodes or edges', async () => {
  const ctx = context();
  await invoke('flows_save', { ...flowArgs, comments: [{ id: 'note', text: 'Updated', x: 0 }],
    viewport: { x: 0, y: 0, zoom: 1 } }, ctx);
  const saved = mutation(ctx, 'put')[2].graph;
  assert.deepEqual(saved.comments, [{ id: 'note', text: 'Updated', color: 'sky',
    position: { x: 0, y: 80 } }]);
  assert.deepEqual(saved.nodes, graph.nodes);
  assert.deepEqual(saved.edges, graph.edges);
  assert.deepEqual(saved.viewport, { x: 0, y: 0, zoom: 1 });
});

test('flow style replacement is explicit and null clears handles and sizes', async () => {
  const ctx = context();
  await invoke('flows_save', { ...flowArgs,
    nodes: [{ id: 'start', kind: 'trigger.text', data: { color: 'amber' }, width: null }],
    edges: [{ id: 'link', from: 'start', to: 'start', in: null, out: null,
      label: '', data: { color: 'emerald' } }], comments: [] }, ctx);
  const saved = mutation(ctx, 'put')[2].graph;
  assert.equal(saved.nodes[0].width, null);
  assert.equal(saved.nodes[0].data.color, 'amber');
  assert.equal(saved.nodes[0].data.outputs, undefined);
  assert.deepEqual(saved.edges[0].data, { color: 'emerald', label: '' });
  assert.equal(saved.edges[0].sourceHandle, null);
  assert.equal(saved.edges[0].targetHandle, null);
  assert.deepEqual(saved.comments, []);
});

test('flow read and export expose comments and canvas state', async () => {
  const document = { format: 'operbots.flow', version: 1, name: 'Flow', graph };
  const ctx = context({ [`get ${flowRoot}/${flowId}/export`]: document });
  const opened = await invoke('flows_get', flowArgs, ctx);
  assert.match(opened, /Keep this note/);
  assert.match(opened, /viewport|полотно/);
  assert.match(opened, /230/);
  const exported = await invoke('flows_export', flowArgs, ctx);
  assert.match(exported, /"comments"/);
  assert.match(exported, /Keep this note/);
});

test('flow kind schema accepts request actions and strict extension UUID kinds', () => {
  for (const kind of ['action.request_create', 'action.request_update', 'action.request_task',
    `extension.${personId}`, `extension_trigger.${personId}`]) {
    assert.equal(schema('flows_save').safeParse({ bot: 'Bot', nodes: [{ id: 'n', kind }] }).success,
      true, kind);
  }
  for (const kind of ['extension.anything', 'extension_trigger.bad', 'extension..' + personId,
    `extension.${personId}/path`, 'action.unknown']) {
    assert.equal(schema('flows_save').safeParse({ bot: 'Bot', nodes: [{ id: 'n', kind }] }).success,
      false, kind);
  }
});

test('flow comment boundaries reject duplicate IDs, unknown colors and infinite positions', () => {
  for (const comments of [
    [{ id: 'same' }, { id: 'same' }], [{ id: 'note', color: 'unknown' }],
    [{ id: 'note', x: Infinity }], [{ id: 'note', text: 'x'.repeat(10001) }],
  ]) assert.equal(schema('flows_save').safeParse({ bot: 'Bot', comments }).success, false);
});

test('flow copy applies supplied scope, graph, comment and empty description', async () => {
  const ctx = context({ [`post ${flowRoot}/${flowId}/duplicate`]: { ...flow, id: copyId } });
  await invoke('flows_save', { bot: 'Bot', copy_of: flowId, description: '', scope: 'community',
    nodes: [{ id: 'new', kind: 'trigger.post' }], edges: [], comments: [],
    comment: 'Copied and adapted' }, ctx);
  const [, path, payload] = mutation(ctx, 'put');
  assert.equal(path, `${flowRoot}/${copyId}`);
  assert.equal(payload.description, '');
  assert.equal(payload.scope, 'community');
  assert.equal(payload.comment, 'Copied and adapted');
  assert.equal(payload.graph.nodes[0].data.kind, 'trigger.post');
  assert.deepEqual(payload.graph.comments, []);
});

test('flow rejects incompatible create/copy/update fields before any mutation', async () => {
  for (const args of [{ ...flowArgs, copy_of: flowId },
    { ...flowArgs, provider_id: personId }]) {
    const ctx = context();
    await assert.rejects(invoke('flows_save', args, ctx), /copy_of|provider_id|создани/i);
    assert.equal(ctx.calls.some(call => ['post', 'put'].includes(call[0])), false);
  }
});

test('flow refuses masked copy config before creating the duplicate', async () => {
  const ctx = context();
  await assert.rejects(invoke('flows_save', {
    bot: 'Bot', copy_of: flowId,
    nodes: [{ id: 'start', kind: 'trigger.text', config: { api_key: '···1234' } }],
  }, ctx), /замаскирован/);
  assert.equal(ctx.calls.some(call => ['post', 'put'].includes(call[0])), false);
});

test('flow create forwards valid legacy schema fields', async () => {
  const ctx = context();
  await invoke('flows_save', { bot: 'Bot', name: 'New', template: 'blank',
    provider_id: personId, knowledge_base_id: memberId }, ctx);
  const payload = mutation(ctx, 'post')[2];
  assert.equal(payload.template, 'blank');
  assert.equal(payload.provider_id, personId);
  assert.equal(payload.knowledge_base_id, memberId);
});

test('flow simulation keeps structured step detail', async () => {
  const ctx = context({ [`post ${flowRoot}/${flowId}/simulate`]: { matched: true,
    steps: [{ node_id: 'start', kind: 'trigger.text', title: 'Start', output: 'out',
      detail: { decision: 'matched' } }], messages: [], variables: { count: 0 }, error: null } });
  const result = await invoke('flows_simulate', { ...flowArgs, text: 'Hello' }, ctx);
  assert.match(result, /matched/);
});

test('catalog adds case extension operations and triggers to native node kinds', async () => {
  const node = { group: 'CRM', title: 'Lookup', description: '', inputs: 1,
    outputs: ['ok', 'error'], config_schema: [], scopes: ['dialog', 'community'] };
  const ctx = context({ 'get /flow-nodes': [{ ...node, kind: 'action.message' }],
    [`get /cases/${caseId}/extensions/nodes`]: [
      { ...node, kind: `extension.${personId}` },
      { ...node, kind: `extension_trigger.${memberId}`, inputs: 0, outputs: ['out'] },
    ] });
  const result = await invoke('operbots_catalog', { what: 'node_kinds', case: 'Case' }, ctx);
  assert.match(result, new RegExp(`extension\\.${personId}`));
  assert.match(result, new RegExp(`extension_trigger\\.${memberId}`));
});

test('catalog reports inaccessible extensions without claiming the node is missing', async () => {
  const ctx = context({ 'get /flow-nodes': [] });
  const get = ctx.api.get;
  ctx.api.get = async (path, query) => {
    if (path.endsWith('/extensions/nodes')) throw new Error('permission denied');
    return get(path, query);
  };
  const result = await invoke('operbots_catalog', {
    what: 'node_kinds', case: 'Case', kind: `extension.${personId}`,
  }, ctx);
  assert.match(result, /permission denied/);
  assert.doesNotMatch(result, /Узла .* нет/);
});

test('permission enum contains all request, counterparty and extension rights', () => {
  for (const permission of ['request.view', 'request.create', 'request.edit', 'request.manage',
    'counterparty.view', 'counterparty.manage', 'extension.view', 'extension.manage']) {
    assert.ok(PERMISSIONS.includes(permission), permission);
  }
});

test('dialog filters resolve assigned user ID and forward single tag', async () => {
  const ctx = context();
  await invoke('dialogs_list', { assigned_to: 'Agent', tag: 'customer' }, ctx);
  const call = ctx.calls.find(call => call[1] === `/cases/${caseId}/dialogs`);
  assert.equal(call[2].assigned_to, personId);
  assert.equal(call[2].tag, 'customer');
});

test('dialog update supports explicit assignment and removing it with null', async () => {
  for (const assigned_operator_id of [personId, null]) {
    const ctx = context();
    await invoke('dialogs_update', { ...dialogArgs, assigned_operator_id }, ctx);
    assert.equal(mutation(ctx, 'patch')[2].assigned_operator_id, assigned_operator_id);
  }
});

test('history always reads without mutations and forwards timestamp plus ID cursor', async () => {
  const ctx = context();
  ctx.config.readOnly = true;
  await invoke('dialogs_history', { ...dialogArgs, before: when, before_id: messageId }, ctx);
  const call = ctx.calls.find(call => call[1] === `${dialogRoot}/messages`);
  assert.equal(call[2].mark_read, false);
  assert.equal(call[2].before_id, messageId);
  assert.equal(call[2].before, when);
  await assert.rejects(invoke('dialogs_history', { ...dialogArgs, mark_read: true }, ctx));
  assert.equal(ctx.calls.some(call => call[2]?.mark_read === true), false);
});

test('mark read is a separate write tool', async () => {
  const ctx = context();
  await invoke('dialogs_mark_read', dialogArgs, ctx);
  assert.equal(entry('dialogs_mark_read').kind, 'write');
  assert.deepEqual(ctx.calls.at(-1), ['get', `${dialogRoot}/messages`,
    { limit: 1, mark_read: true }]);
});

test('chat numbers shared by different bots cannot resolve a mutation', async () => {
  const duplicate = { ...dialog, id: copyId, bot_id: copyId, bot_name: 'Other bot' };
  for (const separatePages of [false, true]) {
    const ctx = context();
    ctx.api.get = async (path, query) => {
      ctx.calls.push(['get', path, query]);
      if (!separatePages) return page([dialog, duplicate]);
      return { items: [query.offset === 0 ? dialog : duplicate], total: 201 };
    };
    await assert.rejects(invoke('dialogs_release', { dialog: '123' }, ctx), /несколько|идентификатор/i);
    assert.equal(ctx.calls.some(call => call[0] === 'post'), false);
  }
});

test('truncated dialog scans and name pages require an exact ID before mutation', async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => ({ ...dialog,
    id: String(index), chat_id: index === 0 || index === 1000 ? 123 : 999 }));
  for (const hint of ['123', 'Customer']) {
    const ctx = context();
    ctx.api.get = async (path, query) => {
      ctx.calls.push(['get', path, query]);
      const offset = query.offset ?? 0;
      return { items: rows.slice(offset, offset + query.limit), total: rows.length };
    };
    await assert.rejects(invoke('dialogs_release', { dialog: hint }, ctx), /идентификатор|UUID/i);
    assert.equal(ctx.calls.some(call => call[0] === 'post'), false);
  }
});

test('community card never refreshes mutable platform state, in either access mode', async () => {
  for (const readOnly of [false, true]) {
    const ctx = context({ [`get ${dialogRoot}`]: { ...dialog, chat_type: 'supergroup' },
      [`get ${dialogRoot}/journey`]: { flow_name: null, flow_id: null, nodes_total: 0,
        stage: null, awaiting: null, next_steps: [], trail: [], scheduled: [], variables: {} },
      [`get ${dialogRoot}/chat`]: { available: true, title: 'Updated title' } });
    ctx.config.readOnly = readOnly;
    await invoke('dialogs_get', dialogArgs, ctx);
    assert.equal(ctx.calls.some(call => call[1].endsWith('/chat')), false);
  }
});

test('platform community refresh is an explicit write tool', async () => {
  const ctx = context({ [`get ${dialogRoot}/chat`]: { available: true, title: 'Community', members: 42 } });
  const output = await invoke('dialogs_chat_info', dialogArgs, ctx);
  assert.equal(entry('dialogs_chat_info').kind, 'write');
  assert.equal(ctx.calls.at(-1)[1], `${dialogRoot}/chat`);
  assert.match(output, /Community|42/);
});

test('reply deletion rejects blank, duplicate titles and ambiguous text prefixes', async () => {
  const duplicate = { ...reply, id: copyId };
  for (const hint of ['', '   ', 'Greeting', '<b>Hello']) {
    const ctx = context({ [`get /cases/${caseId}/replies`]: [reply, duplicate] });
    await assert.rejects(invoke('replies_delete', { reply: hint }, ctx), /название|несколько|идентификатор|Укажите/i);
    assert.equal(ctx.calls.some(call => call[0] === 'delete'), false);
  }
});

test('broadcast mutations reject apparent uniqueness in an incomplete catalogue', async () => {
  for (const name of ['broadcasts_start', 'broadcasts_delete', 'broadcasts_retry', 'broadcasts_test']) {
    const ctx = context({ [`get ${broadcastRoot}`]: { items: [broadcast], total: 101 } });
    const args = { broadcast: 'Newsletter',
      ...(name === 'broadcasts_start' ? { confirm_title: 'Newsletter' } : { confirm_name: 'Newsletter' }),
      ...(name === 'broadcasts_test' ? { dialog: dialogId } : {}) };
    await assert.rejects(invoke(name, args, ctx), /идентификатор|UUID/i);
    assert.equal(ctx.calls.some(call => ['post', 'delete'].includes(call[0])), false);
  }
});

test('community flow assignment rejects duplicate eligible names and ignores other scopes', async () => {
  const community = { ...flow, scope: 'community', name: 'Shared' };
  const ctx = context({ [`get ${dialogRoot}`]: { ...dialog, chat_type: 'supergroup' },
    [`get ${flowRoot}`]: [{ ...flow, name: 'Shared' }, community, { ...community, id: copyId }] });
  await assert.rejects(invoke('dialogs_update', { ...dialogArgs, flow: 'Shared' }, ctx), /несколько|идентификатор/i);
  assert.equal(ctx.calls.some(call => call[0] === 'patch'), false);
  const unique = context({ [`get ${dialogRoot}`]: { ...dialog, chat_type: 'supergroup' },
    [`get ${flowRoot}`]: [{ ...flow, name: 'Shared' }, community] });
  await invoke('dialogs_update', { ...dialogArgs, flow: 'Shared' }, unique);
  assert.equal(mutation(unique, 'patch')[2].flow_id, flowId);
});

test('history pagination includes ID alongside equal timestamp continuation', async () => {
  const ctx = context();
  const output = await invoke('dialogs_history', { ...dialogArgs, limit: 1 }, ctx);
  assert.match(output, new RegExp(`before_id=${messageId}`));
});

test('dialog details expose memory, identity, stage time and scheduled cancellation IDs', async () => {
  const ctx = context({ [`get ${dialogRoot}/journey`]: { flow_id: flowId, flow_name: 'Flow',
    nodes_total: 1, stage: { node_id: 'start', title: 'Wait', kind: 'action.wait', at: when },
    awaiting: 'answer', next_steps: [], trail: [], variables: {}, scheduled: [{ id: taskId,
      node_id: 'start', title: 'Follow up', run_at: when, cancel_on_reply: true, seconds_left: 1 }] } });
  const result = await invoke('dialogs_get', dialogArgs, ctx);
  for (const value of ['A remembered agreement', '456', 'en', 'start', taskId, when]) {
    assert.ok(result.includes(value), value);
  }
});

test('reply, message edits and template saves forward parse mode', async () => {
  for (const [name, args, method] of [
    ['dialogs_reply', { ...dialogArgs, text: '<b>Hello</b>', parse_mode: 'HTML' }, 'post'],
    ['dialogs_edit_message', { ...dialogArgs, message: messageId,
      text: '<b>New</b>', parse_mode: 'HTML' }, 'patch'],
    ['replies_save', { text: '<b>Hello</b>', parse_mode: 'HTML' }, 'post'],
    ['replies_save', { reply: messageId, parse_mode: '' }, 'patch'],
  ]) {
    const ctx = context();
    await invoke(name, args, ctx);
    assert.equal(mutation(ctx, method)[2].parse_mode, args.parse_mode);
  }
});

test('sending a saved template retains its own parse mode', async () => {
  const ctx = context();
  await invoke('dialogs_reply', { ...dialogArgs, reply: 'Greeting' }, ctx);
  assert.equal(mutation(ctx, 'post')[2].parse_mode, 'HTML');
});

test('dialog release, forgetting memory and scheduled cancellation use their exact routes', async () => {
  for (const [name, method, suffix, args] of [
    ['dialogs_release', 'post', '/release', {}],
    ['dialogs_forget_memory', 'post', '/forget-memory', {}],
    ['dialogs_cancel_scheduled', 'delete', `/scheduled/${taskId}`, { task_id: taskId }],
  ]) {
    const ctx = context();
    await invoke(name, { ...dialogArgs, ...args }, ctx);
    assert.equal(mutation(ctx, method)[1], dialogRoot + suffix);
    assert.notEqual(entry(name).kind, 'read');
  }
});

test('dialog file reply and attachment download use the native API methods', async () => {
  const ctx = context();
  await invoke('dialogs_reply_file', { ...dialogArgs, file_path: 'invoice.pdf',
    caption: '<b>Invoice</b>', parse_mode: 'HTML', take_over: false }, ctx);
  assert.deepEqual(mutation(ctx, 'upload'), ['upload', `${dialogRoot}/messages/file`,
    'invoice.pdf', { caption: '<b>Invoice</b>', parse_mode: 'HTML', take_over: false }, undefined]);
  await invoke('dialogs_download_attachment', { ...dialogArgs, message: messageId,
    index: 1, destination: 'download.pdf' }, ctx);
  assert.deepEqual(mutation(ctx, 'download'), ['download',
    `${dialogRoot}/messages/${messageId}/file`, 'download.pdf', { index: 1 }]);
});

test('broadcast list forwards supported status group, bot and text filters', async () => {
  const ctx = context();
  await invoke('broadcasts_list', { status: 'live', bot: 'Bot', q: 'Hello' }, ctx);
  const query = ctx.calls.find(call => call[1] === broadcastRoot)[2];
  assert.equal(query.status, 'live');
  assert.equal(query.bot_id, botId);
  assert.equal(query.q, 'Hello');
});

test('broadcast details preserve audience, button rows and attachment size', async () => {
  const result = await invoke('broadcasts_get', broadcastArgs, context());
  assert.match(result, /"joined_after": "2026-09-01"/);
  assert.match(result, /"assigned_to"/);
  assert.match(result, /"buttons"|кнопки/);
  assert.match(result, /1234/);
});

test('broadcast preview includes buttons and now-supported joined date', async () => {
  const ctx = context({ [`post ${broadcastRoot}/preview`]: { total: 0, blocked: 0,
    excluded: 0, warnings: [], recipients: [] } });
  await invoke('broadcasts_preview', { bot: 'Bot', text: 'Hello', buttons,
    joined_after: '2026-09-01' }, ctx);
  const payload = mutation(ctx, 'post')[2];
  assert.deepEqual(payload.buttons, buttons);
  assert.equal(payload.audience.joined_after, '2026-09-01');
});

test('broadcast save roundtrips structured audience, supports reset and changes bot', async () => {
  for (const audience of [broadcast.audience, {}]) {
    const ctx = context({ [`get ${broadcastRoot}/${broadcastId}`]: {
      ...broadcast, attachment: null,
    } });
    await invoke('broadcasts_save', { ...broadcastArgs, bot: 'Bot', audience }, ctx);
    assert.deepEqual(mutation(ctx, 'patch')[2], { bot_id: botId, audience });
  }
});

test('broadcast save keeps omitted audience and never starts a new draft implicitly', async () => {
  const edit = context();
  await invoke('broadcasts_save', { ...broadcastArgs, title: 'New title' }, edit);
  assert.deepEqual(mutation(edit, 'patch')[2], { title: 'New title' });
  const create = context();
  await invoke('broadcasts_save', { bot: 'Bot', text: 'Hello' }, create);
  assert.equal(mutation(create, 'post')[2].start, false);
});

test('broadcast rejects mixed structured and flat audience instead of dropping either', async () => {
  const ctx = context();
  await assert.rejects(invoke('broadcasts_save', { ...broadcastArgs, audience: {},
    tags: ['customer'] }, ctx), /audience|отбор/i);
  assert.equal(ctx.calls.some(call => call[0] === 'patch'), false);
});

test('broadcast attach/detach and recipient reports use exact routes and pagination', async () => {
  const ctx = context({ [`get ${broadcastRoot}/${broadcastId}/targets`]: page([{ id: taskId,
    dialog_id: dialogId, name: 'Customer', username: 'customer', status: 'failed',
    error: 'Blocked', sent_at: when }]) });
  await invoke('broadcasts_attach', { ...broadcastArgs, file_path: 'invoice.pdf' }, ctx);
  assert.deepEqual(mutation(ctx, 'upload'), ['upload',
    `${broadcastRoot}/${broadcastId}/attachment`, 'invoice.pdf']);
  await invoke('broadcasts_detach', broadcastArgs, ctx);
  assert.equal(mutation(ctx, 'delete')[1], `${broadcastRoot}/${broadcastId}/attachment`);
  const output = await invoke('broadcasts_targets', { ...broadcastArgs, status: 'failed',
    q: 'Customer', limit: 7, offset: 2 }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['get', `${broadcastRoot}/${broadcastId}/targets`,
    { status: 'failed', q: 'Customer', limit: 7, offset: 2 }]);
  assert.match(output, /Blocked/);
  assert.match(output, new RegExp(dialogId));
});

test('broadcast duplicate only creates a draft and forwards only_missed', async () => {
  const ctx = context();
  await invoke('broadcasts_duplicate', { ...broadcastArgs, only_missed: true }, ctx);
  assert.deepEqual(mutation(ctx, 'post'), ['post', `${broadcastRoot}/${broadcastId}/duplicate`,
    { only_missed: true }]);
  assert.equal(entry('broadcasts_duplicate').kind, 'write');
});

test('broadcast retry, test send and deletion require exact name and danger classification', async () => {
  for (const [name, method, suffix, extra] of [
    ['broadcasts_retry', 'post', '/retry', {}],
    ['broadcasts_test', 'post', '/test', { dialog: dialogId }],
    ['broadcasts_delete', 'delete', '', {}],
  ]) {
    const ctx = context();
    assert.equal(entry(name).kind, 'danger');
    await assert.rejects(invoke(name, { ...broadcastArgs, ...extra,
      confirm_name: 'Newsletter ' }, ctx), /подтверж|назван/i);
    assert.equal(ctx.calls.some(call => call[0] === method), false);
    await invoke(name, { ...broadcastArgs, ...extra, confirm_name: 'Newsletter' }, ctx);
    assert.equal(mutation(ctx, method)[1], `${broadcastRoot}/${broadcastId}${suffix}`);
    if (name === 'broadcasts_test') {
      assert.deepEqual(mutation(ctx, method)[2], { dialog_id: dialogId });
    }
  }
});

test('dialog and broadcast schemas reject malformed IDs, dates and unknown audience fields', () => {
  for (const [name, args] of [
    ['dialogs_history', { ...dialogArgs, before_id: '../other' }],
    ['dialogs_reply', { ...dialogArgs, text: 'Hello', reply_to: '../other' }],
    ['dialogs_edit_message', { ...dialogArgs, message: '../other', text: 'Hello' }],
    ['dialogs_delete_message', { ...dialogArgs, message: '../other' }],
    ['dialogs_cancel_scheduled', { ...dialogArgs, task_id: '../other' }],
    ['tasks_cancel', { task_id: '../other' }],
    ['dialogs_download_attachment', { ...dialogArgs, message: messageId,
      destination: 'file', index: -1 }],
    ['broadcasts_preview', { bot: 'Bot', text: 'Hello', joined_after: '2026-02-30' }],
    ['broadcasts_save', { ...broadcastArgs, audience: { assigned_to: '../other' } }],
    ['broadcasts_save', { ...broadcastArgs, audience: { misspelled: true } }],
    ['broadcasts_targets', { ...broadcastArgs, status: 'unknown' }],
  ]) assert.equal(schema(name).safeParse(args).success, false, name);
});
