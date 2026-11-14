import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { aiTools } from '../dist/tools/ai.js';
import { catalogTools } from '../dist/tools/catalog.js';
import { flowTools } from '../dist/tools/flows.js';
import { selectTools } from '../dist/server.js';
import { pickByName } from '../dist/context.js';

const C = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';
const root = `/cases/${C}`;
function harness(responses = {}) {
  const calls = [];
  const api = Object.fromEntries(['get', 'post', 'postText', 'patch', 'delete', 'upload', 'download'].map(method => [method, async (...args) => {
    calls.push([method, ...args]);
    return responses[`${method} ${args[0]}`] ?? (args[0].endsWith('/ai-providers') ? [{ id: P, name: 'Timeweb' }] : {});
  }]));
  return { calls, api, resolveCase: async () => ({ id: C, name: 'QA' }) };
}
async function invoke(name, args, ctx) {
  const entry = [...aiTools, ...catalogTools].find(tool => tool.name === name);
  assert.ok(entry, `Missing ${name}`);
  return entry.run(z.object(entry.input).parse(args), ctx);
}

test('current panel supports Timeweb and all five AI flow node kinds', async () => {
  const ctx = harness();
  await invoke('ai_save', { name: 'Timeweb', kind: 'timeweb', options: { service_type: 'agent', access_id: 'agent' } }, ctx);
  assert.equal(ctx.calls[0][2].kind, 'timeweb');
  assert.equal(ctx.calls[0][2].options.service_type, 'agent');
  const flow = flowTools.find(tool => tool.name === 'flows_save');
  for (const kind of ['trigger.ai_job', 'action.ai_transcribe', 'action.ai_speech', 'action.ai_video', 'action.ai_batch']) {
    z.object(flow.input).parse({ bot: 'QA', nodes: [{ id: 'node', kind }] });
  }
});

test('AI catalog keeps capabilities, modes and options needed to configure providers', async () => {
  const ctx = harness({ 'get /ai-providers/catalog': [{ kind: 'timeweb', title: 'Timeweb', credential_fields: [],
    capabilities: ['batch'], options_schema: { service_type: { type: 'select' } }, modes: [{ value: 'agent' }] }] });
  const result = await invoke('operbots_catalog', { what: 'ai_kinds' }, ctx);
  for (const value of ['batch', 'service_type', 'agent']) assert.match(result, new RegExp(value));
});

test('case template catalog exposes the current panel composition', async () => {
  const ctx = harness({ 'get /cases/templates': [{ key: 'support', counts: { bots: 1 }, dialogs: ['Example'] }] });
  const result = await invoke('operbots_catalog', { what: 'case_templates' }, ctx);
  assert.deepEqual(ctx.calls[0], ['get', '/cases/templates']);
  assert.match(result, /support/);
  assert.match(result, /Example/);
});

test('UUID selection never falls through to another resource with that name', () => {
  assert.throws(() => pickByName([{ id: F, name: P }], P), error => error.code === 'not_found');
});

test('AI file tools cover metadata, uploads, refresh, content and deletion', async () => {
  const ctx = harness();
  await invoke('ai_files_list', {}, ctx);
  await invoke('ai_files_get', { file: F }, ctx);
  await invoke('ai_files_upload', { provider: 'Timeweb', path: 'C:/qa/input.jsonl', purpose: 'batch' }, ctx);
  await invoke('ai_files_refresh', { file: F }, ctx);
  await invoke('ai_files_download', { file: F, destination: 'C:/qa/output.jsonl' }, ctx);
  await invoke('ai_files_delete', { file: F }, ctx);
  assert.ok(ctx.calls.some(call => call[0] === 'get' && call[1] === `${root}/ai-files`));
  assert.ok(ctx.calls.some(call => call[0] === 'get' && call[1] === `${root}/ai-files/${F}`));
  assert.deepEqual(ctx.calls.find(call => call[0] === 'upload'), ['upload', `${root}/ai-files`, 'C:/qa/input.jsonl',
    { provider_id: P, purpose: 'batch', target_models: '' }, undefined, 50 * 1024 * 1024]);
  assert.ok(ctx.calls.some(call => call[0] === 'post' && call[1] === `${root}/ai-files/${F}/refresh`));
  assert.deepEqual(ctx.calls.find(call => call[0] === 'download'), ['download', `${root}/ai-files/${F}/content`, 'C:/qa/output.jsonl']);
  assert.equal(ctx.calls.at(-1)[1], `${root}/ai-files/${F}`);
});

test('AI jobs keep explicit idempotency and reconcile choices; no implicit polling or retries', async () => {
  const ctx = harness();
  await invoke('ai_jobs_list', {}, ctx);
  await invoke('ai_jobs_get', { job: F }, ctx);
  await invoke('ai_jobs_create', { provider: 'Timeweb', kind: 'batch', input_file: F,
    idempotency_key: 'retry-same-key', payload: { endpoint: '/v1/chat/completions' } }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['post', `${root}/ai-jobs`, { provider_id: P, kind: 'batch', input_file_id: F,
    idempotency_key: 'retry-same-key', payload: { endpoint: '/v1/chat/completions' } }]);
  await invoke('ai_jobs_cancel', { job: F }, ctx);
  await invoke('ai_jobs_candidates', { job: F }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['get', `${root}/ai-jobs/${F}/reconcile`]);
  await invoke('ai_jobs_reconcile', { job: F, remote_id: 'batch-remote' }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['post', `${root}/ai-jobs/${F}/reconcile`, { remote_id: 'batch-remote' }]);
  const count = ctx.calls.length;
  await assert.rejects(invoke('ai_jobs_create', { provider: P, kind: 'batch' }, ctx));
  await assert.rejects(invoke('ai_jobs_get', { job: '../other' }, ctx));
  assert.equal(ctx.calls.length, count);
});

test('non-batch AI uploads require nonblank target models before reading or HTTP', async () => {
  const ctx = harness();
  for (const purpose of ['user_data', 'messages']) {
    for (const target_models of [undefined, [], ['  ']]) {
      await assert.rejects(invoke('ai_files_upload', { provider: P, path: 'C:/qa/audio.wav', purpose, target_models }, ctx));
    }
  }
  assert.equal(ctx.calls.length, 0);
  await invoke('ai_files_upload', { provider: P, path: 'C:/qa/audio.wav', purpose: 'user_data', target_models: [' openai/whisper-1 '] }, ctx);
  assert.equal(ctx.calls.at(-1)[3].target_models, 'openai/whisper-1');
});

test('AI audio and model tools forward current request shapes', async () => {
  const ctx = harness();
  await invoke('ai_models', { provider: 'Timeweb' }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['post', `${root}/ai-providers/${P}/models`]);
  await invoke('ai_speech', { provider: 'Timeweb', text: 'Hello', speed: 0.25, options: { extra: true } }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['post', `${root}/ai-providers/${P}/speech`, { text: 'Hello', speed: 0.25, options: { extra: true } }]);
  await invoke('ai_transcribe', { provider: 'Timeweb', file: F, language: 'ru' }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['post', `${root}/ai-providers/${P}/transcribe`, { file_id: F, language: 'ru' }]);
});

test('AI stream gathers deltas and rejects corrupt, incomplete or failed streams', async () => {
  const path = `${root}/ai-providers/${P}/stream`;
  const event = payload => `data: ${JSON.stringify(payload)}\r\n\r\n`;
  const ctx = harness({ [`postText ${path}`]: event({ text_delta: 'Привет' }) + event({ done: true, response_id: 'resp-1', usage: { total_tokens: 9 } }) });
  const output = await invoke('ai_stream', { provider: 'Timeweb', prompt: 'Привет', mode: 'responses' }, ctx);
  for (const text of ['Привет', 'resp-1', '9']) assert.ok(output.includes(text));
  for (const stream of [event({ text_delta: 'partial' }), 'data: {broken}\n\n', event({ error: 'upstream failed' }), event({ done: 'true' }), event({ done: true }) + event({ error: 'late failure' })]) {
    await assert.rejects(invoke('ai_stream', { provider: P, prompt: 'test' }, harness({ [`postText ${path}`]: stream })));
  }
});

test('read-only includes AI metadata and downloads but no external or mutating AI operations', () => {
  const names = selectTools({ readOnly: true }).map(tool => tool.name);
  for (const name of ['ai_files_list', 'ai_files_get', 'ai_files_download', 'ai_jobs_list', 'ai_jobs_get']) assert.ok(names.includes(name), name);
  for (const name of ['ai_models', 'ai_stream', 'ai_speech', 'ai_transcribe', 'ai_files_upload', 'ai_files_refresh', 'ai_files_delete',
    'ai_jobs_create', 'ai_jobs_cancel', 'ai_jobs_candidates', 'ai_jobs_reconcile']) assert.ok(!names.includes(name), name);
});
