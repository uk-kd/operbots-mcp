import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

const { requestTools } = await import('../dist/tools/requests.js').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return { requestTools: [] };
});
const caseId = '10000000-0000-4000-8000-000000000001';
const requestId = '10000000-0000-4000-8000-000000000002';
const typeId = '10000000-0000-4000-8000-000000000003';
const taskId = '10000000-0000-4000-8000-000000000004';
const personId = '10000000-0000-4000-8000-000000000005';
const root = `/cases/${caseId}/requests`;
const workflow = {
  steps: [{ id: 'review', title: 'Проверить', kind: 'decision', outcomes: ['yes', 'no'],
    condition_field: 'approved', condition_value: false, position: { x: 0, y: 12 } }],
  edges: [{ from: 'review', to: 'review', outcome: 'no' }],
};

function harness(name, response = { id: requestId, title: 'Заявка', revision: 7 }) {
  const tool = requestTools.find((item) => item.name === name);
  assert.ok(tool, `Missing tool ${name}`);
  const calls = [];
  const ctx = {
    resolveCase: async () => ({ id: caseId, name: 'Дело' }),
    api: Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((method) => [method,
      async (...args) => { calls.push([method, ...args]); return response; }])),
  };
  return { tool, calls, run: (args) => tool.run(z.object(tool.input).parse(args), ctx) };
}

test('request list forwards every server filter, including false flags', async () => {
  const h = harness('requests_list', []);
  await h.run({ search: 'Счёт', status: 'waiting', mine: false, overdue: true,
    counterparty_id: personId, dialog_id: taskId });
  assert.deepEqual(h.calls, [['get', root, { search: 'Счёт', status: 'waiting', mine: false,
    overdue: true, counterparty_id: personId, dialog_id: taskId }]]);
});

test('request creation sends links, due date and data without a revision', async () => {
  const h = harness('requests_save');
  await h.run({ title: 'Заявка', type_id: typeId, counterparty_id: personId,
    dialog_id: taskId, source_message_id: requestId, assignee_id: personId,
    due_at: '2026-10-01T12:00:00+03:00', data: { approved: false } });
  assert.deepEqual(h.calls, [['post', root, { title: 'Заявка', type_id: typeId,
    counterparty_id: personId, dialog_id: taskId, source_message_id: requestId,
    assignee_id: personId, due_at: '2026-10-01T12:00:00+03:00', data: { approved: false } }]]);
});

test('request update keeps caller revision and explicit nulls without rereading', async () => {
  const h = harness('requests_save');
  await h.run({ request_id: requestId, revision: 3, description: '', assignee_id: null,
    due_at: null, data: {} });
  assert.deepEqual(h.calls, [['patch', `${root}/${requestId}`, { revision: 3,
    description: '', assignee_id: null, due_at: null, data: {} }]]);
});

test('request update without revision and create-only update fields cannot mutate', async () => {
  const h = harness('requests_save');
  await assert.rejects(h.run({ request_id: requestId, title: 'Правка' }), /revision/);
  await assert.rejects(h.run({ request_id: requestId, revision: 2, type_id: typeId }), /type_id/);
  assert.equal(h.calls.length, 0);
});

test('request read keeps workflow, events, nullable fields and revision in output', async () => {
  const h = harness('requests_get', { id: requestId, title: 'Заявка', revision: 7,
    assignee_id: null, workflow, events: [{ id: taskId, text: 'Создана' }], data: { approved: false } });
  const output = await h.run({ request_id: requestId });
  assert.deepEqual(h.calls, [['get', `${root}/${requestId}`]]);
  assert.match(output, /"revision": 7/);
  assert.match(output, /"condition_value": false/);
  assert.match(output, /"assignee_id": null/);
  assert.match(output, /Создана/);
});

test('request task completion forwards caller revision, outcome and data', async () => {
  const h = harness('requests_task_complete');
  await h.run({ request_id: requestId, task_id: taskId, revision: 3, outcome: 'yes', data: { qty: 0 } });
  assert.deepEqual(h.calls, [['post', `${root}/${requestId}/tasks/${taskId}/complete`,
    { revision: 3, outcome: 'yes', data: { qty: 0 } }]]);
});

test('request comments, workflow replacement, cancellation and my tasks use separate routes', async () => {
  for (const [name, args, want] of [
    ['requests_comment', { request_id: requestId, text: 'Позвонили' },
      ['post', `${root}/${requestId}/comments`, { text: 'Позвонили' }]],
    ['requests_workflow', { request_id: requestId, revision: 3, workflow },
      ['put', `${root}/${requestId}/workflow`, { revision: 3, workflow }]],
    ['requests_cancel', { request_id: requestId, revision: 3, reason: 'Клиент отказался' },
      ['post', `${root}/${requestId}/cancel`, { revision: 3, reason: 'Клиент отказался' }]],
    ['requests_tasks_list', {}, ['get', `${root}/tasks`]],
  ]) {
    const h = harness(name);
    await h.run(args);
    assert.deepEqual(h.calls, [want]);
  }
});

test('request deletion checks exact title and sends original revision as query', async () => {
  const h = harness('requests_delete');
  await assert.rejects(h.run({ request_id: requestId, revision: 2, confirm_name: 'Другая' }), /подтверждение|назван/i);
  assert.deepEqual(h.calls, [['get', `${root}/${requestId}`]]);
  h.calls.length = 0;
  await h.run({ request_id: requestId, revision: 2, confirm_name: 'Заявка' });
  assert.deepEqual(h.calls, [['get', `${root}/${requestId}`],
    ['delete', `${root}/${requestId}`, { revision: 2 }]]);
  assert.equal(h.tool.kind, 'danger');
});

test('request type update is full definition and sends caller version', async () => {
  const h = harness('requests_types_save');
  const definition = { name: 'Согласование', description: '', fields: [
    { key: 'approved', label: 'Решение', type: 'select', options: ['yes', 'no'], required: true },
  ], workflow };
  await h.run({ type_id: typeId, version: 2, ...definition });
  assert.deepEqual(h.calls, [['patch', `${root}/types/${typeId}`, { ...definition, version: 2 }]]);
  h.calls.length = 0;
  await h.run(definition);
  assert.deepEqual(h.calls, [['post', `${root}/types`, definition]]);
});

test('request type list and deletion use list GET for name confirmation and version query', async () => {
  const h = harness('requests_types_delete', [{ id: typeId, name: 'Согласование', version: 9 }]);
  await assert.rejects(h.run({ type_id: typeId, version: 2, confirm_name: 'Другая' }), /подтверждение|назван/i);
  h.calls.length = 0;
  await h.run({ type_id: typeId, version: 2, confirm_name: 'Согласование' });
  assert.deepEqual(h.calls, [['get', `${root}/types`], ['delete', `${root}/types/${typeId}`, { version: 2 }]]);
  const list = harness('requests_types_list', []);
  await list.run({});
  assert.deepEqual(list.calls, [['get', `${root}/types`]]);
});

test('request boundaries reject missing revisions, naive dates and unsupported workflow fields', async () => {
  const h = harness('requests_types_save');
  await assert.rejects(h.run({ type_id: typeId, name: 'Тип', workflow }), /version/);
  assert.throws(() => z.object(h.tool.input).parse({ name: 'Тип', workflow: {
    ...workflow, steps: [{ ...workflow.steps[0], unknown: 1 }],
  } }));
  const save = harness('requests_save');
  assert.throws(() => z.object(save.tool.input).parse({ title: 'Заявка', due_at: '2026-10-01T12:00:00' }));
  assert.throws(() => z.object(save.tool.input).parse({ request_id: '../other', revision: 1 }));
  const cancel = harness('requests_cancel');
  assert.throws(() => z.object(cancel.tool.input).parse({ request_id: requestId, revision: 1, reason: ' ' }));
});

test('request conflicts and permissions are returned without retrying or replacing revision', async () => {
  const h = harness('requests_save');
  const conflict = new Error('revision conflict');
  const ctx = { resolveCase: async () => ({ id: caseId }), api: {
    patch: async (...args) => { h.calls.push(['patch', ...args]); throw conflict; },
  } };
  await assert.rejects(h.tool.run({ request_id: requestId, revision: 2, title: 'Правка' }, ctx), (error) => error === conflict);
  assert.deepEqual(h.calls, [['patch', `${root}/${requestId}`, { revision: 2, title: 'Правка' }]]);
});
