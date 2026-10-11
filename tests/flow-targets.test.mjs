import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { flowTools } from '../dist/tools/flows.js';
import { peopleTools } from '../dist/tools/people.js';

const id = '10000000-0000-4000-8000-000000000003';
const other = '10000000-0000-4000-8000-000000000004';
const root = '/cases/case/bots/bot/flows';
const flow = { id, name: 'Flow', scope: 'dialog', version: 4, problems: [],
  graph: { nodes: [], edges: [] } };

function context(list = [flow]) {
  const calls = [];
  const api = Object.fromEntries(['get', 'put', 'post'].map(method => [method,
    async (path, payload) => {
      calls.push([method, path, payload]);
      if (method === 'get' && path === root) return list;
      return { ...flow, ...payload };
    }]));
  return { calls, api, resolveCase: async () => ({ id: 'case' }),
    resolveBot: async () => ({ id: 'bot', name: 'Bot' }) };
}

async function invoke(name, args, ctx) {
  const entry = flowTools.find(tool => tool.name === name);
  return entry.run(z.object(entry.input).strict().parse(args), ctx);
}

for (const names of [['Support', 'Support'], ['Support site', 'Support store']]) {
  test(`ambiguous flow hint rejects ${names.join(' / ')} before mutation`, async () => {
    const ctx = context(names.map((name, i) => ({ ...flow, id: i ? other : id, name })));
    await assert.rejects(invoke('flows_save', { bot: 'Bot', flow: 'Support', name: 'Changed' }, ctx),
      error => error.code === 'ambiguous');
    assert.ok(ctx.calls.every(call => call[0] === 'get'));
  });
}

test('exact flow UUID disambiguates identical names', async () => {
  const ctx = context([{ ...flow, name: 'Same' }, { ...flow, id: other, name: 'Same' }]);
  await invoke('flows_get', { bot: 'Bot', flow: other }, ctx);
  assert.equal(ctx.calls.at(-1)[1], `${root}/${other}`);
});

test('blank flow hint does not silently choose the first flow', async () => {
  await assert.rejects(invoke('flows_get', { bot: 'Bot', flow: '  ' }, context()),
    error => error.code === 'name_required');
});

test('invitation identifiers accept UUIDs only', () => {
  const entry = peopleTools.find(tool => tool.name === 'invites_revoke');
  const schema = z.object(entry.input).strict();
  assert.equal(schema.safeParse({ invite_id: id }).success, true);
  for (const invite_id of ['invalid', 'nested/value', '']) {
    assert.equal(schema.safeParse({ invite_id }).success, false);
  }
});

test('editing an existing graph requires the caller version before HTTP', async () => {
  const ctx = context();
  await assert.rejects(invoke('flows_save', { bot: 'Bot', flow: id, nodes: [] }, ctx),
    error => error.code === 'version_required');
  assert.equal(ctx.calls.length, 0);
});

test('the caller version is forwarded without replacing it with a fresh revision', async () => {
  const ctx = context();
  await invoke('flows_save', { bot: 'Bot', flow: id, version: 2, nodes: [] }, ctx);
  assert.equal(ctx.calls.find(call => call[0] === 'put')[2].version, 2);
});

test('metadata-only writes and copied flow patches include the read revision', async () => {
  const ctx = context();
  await invoke('flows_save', { bot: 'Bot', flow: id, description: null }, ctx);
  assert.equal(ctx.calls.find(call => call[0] === 'put')[2].version, 4);
  const copy = context();
  await invoke('flows_save', { bot: 'Bot', copy_of: id, description: null }, copy);
  assert.equal(copy.calls.find(call => call[0] === 'put')[2].version, 4);
});
