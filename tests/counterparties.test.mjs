import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

const { counterpartyTools } = await import('../dist/tools/counterparties.js').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return { counterpartyTools: [] };
});
const caseId = '20000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000002';
const dialogId = '20000000-0000-4000-8000-000000000003';
const previousId = '20000000-0000-4000-8000-000000000004';
const root = `/cases/${caseId}/counterparties`;

function harness(name, response = { id: partyId, name: 'Клиент', dialogs: [] }) {
  const tool = counterpartyTools.find((item) => item.name === name);
  assert.ok(tool, `Missing tool ${name}`);
  const calls = [];
  const ctx = {
    resolveCase: async () => ({ id: caseId, name: 'Дело' }),
    api: Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((method) => [method,
      async (...args) => { calls.push([method, ...args]); return response; }])),
  };
  return { tool, calls, run: (args) => tool.run(z.object(tool.input).parse(args), ctx) };
}

test('counterparty list and exact-ID card keep scoped paths and full fields', async () => {
  const list = harness('counterparties_list', []);
  await list.run({ search: 'Клиент' });
  assert.deepEqual(list.calls, [['get', root, { search: 'Клиент' }]]);
  const h = harness('counterparties_get', { id: partyId, name: 'Клиент', phone: null,
    custom_fields: { note: '' }, dialogs: [{ id: dialogId, contact_name: 'Олег' }] });
  const output = await h.run({ counterparty_id: partyId });
  assert.deepEqual(h.calls, [['get', `${root}/${partyId}`]]);
  assert.match(output, /"phone": null/);
  assert.match(output, /"note": ""/);
  assert.match(output, /Олег/);
});

test('counterparty creation links only explicitly selected dialog IDs', async () => {
  const h = harness('counterparties_save');
  await h.run({ name: 'Клиент', phone: '123', email: 'client@example.test', company: 'ООО',
    notes: 'Записать', custom_fields: { segment: 'retail' }, dialog_ids: [dialogId] });
  assert.deepEqual(h.calls, [['post', root, { name: 'Клиент', phone: '123', email: 'client@example.test',
    company: 'ООО', notes: 'Записать', custom_fields: { segment: 'retail' }, dialog_ids: [dialogId] }]]);
});

test('counterparty partial update sends explicit clears and does not default absent fields', async () => {
  const h = harness('counterparties_save');
  await h.run({ counterparty_id: partyId, phone: null, email: '', notes: '', custom_fields: {} });
  assert.deepEqual(h.calls, [['patch', `${root}/${partyId}`, { phone: null, email: '', notes: '', custom_fields: {} }]]);
  h.calls.length = 0;
  await assert.rejects(h.run({ counterparty_id: partyId, dialog_ids: [dialogId] }), /dialog_ids|связ/i);
  assert.equal(h.calls.length, 0);
});

test('counterparty settings partial PATCH preserves other matching criteria', async () => {
  const h = harness('counterparties_settings_save');
  await h.run({ match_phone: false, create_unmatched: false });
  assert.deepEqual(h.calls, [['patch', `${root}/settings`, { match_phone: false, create_unmatched: false }]]);
  const read = harness('counterparties_settings');
  await read.run({});
  assert.deepEqual(read.calls, [['get', `${root}/settings`]]);
});

test('counterparty dialog choices and associated-card lookup have separate routes', async () => {
  const list = harness('counterparties_dialogs', []);
  await list.run({ search: 'Олег' });
  assert.deepEqual(list.calls, [['get', `${root}/dialogs`, { search: 'Олег' }]]);
  const lookup = harness('counterparties_dialogs', null);
  const output = await lookup.run({ dialog_id: dialogId });
  assert.deepEqual(lookup.calls, [['get', `${root}/dialogs/${dialogId}`]]);
  assert.match(output, /не связан|нет|отсутств/i);
});

test('counterparty replacement link forwards expected previous party as query, never body', async () => {
  const h = harness('counterparties_link');
  await h.run({ counterparty_id: partyId, dialog_id: dialogId, replace_counterparty_id: previousId });
  assert.deepEqual(h.calls, [['put', `${root}/${partyId}/dialogs/${dialogId}`, undefined,
    { replace_counterparty_id: previousId }]]);
  const unlink = harness('counterparties_unlink');
  await unlink.run({ counterparty_id: partyId, dialog_id: dialogId });
  assert.deepEqual(unlink.calls, [['delete', `${root}/${partyId}/dialogs/${dialogId}`]]);
});

test('counterparty reconcile is a write and reports the server result without local relinking', async () => {
  const h = harness('counterparties_reconcile', { linked: 2, created: 1, skipped: 3 });
  const output = await h.run({});
  assert.deepEqual(h.calls, [['post', `${root}/reconcile`]]);
  assert.equal(h.tool.kind, 'write');
  assert.match(output, /"linked": 2/);
});

test('counterparty deletion fetches exact name and cannot delete on a mismatched confirmation', async () => {
  const h = harness('counterparties_delete');
  await assert.rejects(h.run({ counterparty_id: partyId, confirm_name: 'Кли' }), /подтверждение|назван/i);
  assert.deepEqual(h.calls, [['get', `${root}/${partyId}`]]);
  h.calls.length = 0;
  await h.run({ counterparty_id: partyId, confirm_name: 'Клиент' });
  assert.deepEqual(h.calls, [['get', `${root}/${partyId}`], ['delete', `${root}/${partyId}`]]);
  assert.equal(h.tool.kind, 'danger');
});

test('counterparty input rejects guessed names, blank custom keys and invalid settings limits', async () => {
  const h = harness('counterparties_save');
  assert.throws(() => z.object(h.tool.input).parse({ counterparty_id: 'Клиент', phone: '123' }));
  assert.throws(() => z.object(h.tool.input).parse({ name: 'Клиент', custom_fields: { ' ': 'bad' } }));
  assert.throws(() => z.object(h.tool.input).parse({ name: 'Клиент', dialog_ids: Array(201).fill(dialogId) }));
  const settings = harness('counterparties_settings_save');
  assert.throws(() => z.object(settings.tool.input).parse({ phone_variable: 'x'.repeat(65) }));
});

test('counterparty permissions and association conflicts propagate without fallback mutation', async () => {
  const h = harness('counterparties_link');
  const denied = new Error('permission denied');
  const ctx = { resolveCase: async () => ({ id: caseId }), api: {
    put: async (...args) => { h.calls.push(['put', ...args]); throw denied; },
  } };
  await assert.rejects(h.tool.run({ counterparty_id: partyId, dialog_id: dialogId }, ctx), (error) => error === denied);
  assert.equal(h.calls.length, 1);
});
