import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { aiTools } from '../dist/tools/ai.js';
import { accountTools } from '../dist/tools/account.js';
import { caseTools } from '../dist/tools/cases.js';
import { report } from '../dist/format.js';
import { Context } from '../dist/context.js';

const caseId = '11111111-1111-4111-8111-111111111111';
const extensionId = '22222222-2222-4222-8222-222222222222';
const definition = {
  id: extensionId, case_id: caseId, name: 'CRM', base_url: 'https://crm.example',
  auth: { type: 'bearer', token: '', client_id: 'client' },
  headers: [{ key: 'X-Key', value: '', secret: true }], query: [],
  operations: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Find', method: 'GET', path: '/find' }],
  webhook: { enabled: false, secret: '', events: [] },
};
function context(responses = {}) {
  const calls = [];
  const api = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, async (...args) => {
    calls.push([method, ...args]);
    return responses[`${method} ${args[0]}`] ?? {};
  }]));
  return { api, calls, resolveCase: async () => ({ id: caseId, name: 'QA' }), forgetCases() {} };
}
async function invoke(group, name, args, ctx) {
  const entry = group.find(item => item.name === name);
  assert.ok(entry, `Missing tool ${name}`);
  return entry.run(z.object(entry.input).parse(args), ctx);
}
async function load(name, exported) {
  return (await import(`../dist/tools/${name}.js`).catch(() => ({})))[exported] ?? [];
}

test('short secrets and collections are masked without hiding numeric usage', () => {
  const text = report('QA', { password: 'short', secrets: ['alpha', 'beta'], api_key: { value: 'inner' }, total_tokens: 42 });
  assert.doesNotMatch(text, /short|alpha|beta|inner/);
  assert.match(text, /total_tokens: 42/);
});

test('extension edit preserves omitted operations and blank stored secret convention', async () => {
  const tools = await load('extensions', 'extensionTools');
  const ctx = context({ [`get /cases/${caseId}/extensions/${extensionId}`]: definition });
  await invoke(tools, 'extensions_save', { extension: extensionId, name: 'Renamed', auth: { client_id: 'new-client' } }, ctx);
  const [, path, payload] = ctx.calls.find(call => call[0] === 'put');
  assert.equal(path, `/cases/${caseId}/extensions/${extensionId}`);
  assert.equal(payload.name, 'Renamed');
  assert.deepEqual(payload.operations, definition.operations);
  assert.deepEqual(payload.headers, definition.headers);
  assert.deepEqual(payload.auth, { ...definition.auth, client_id: 'new-client' });
  assert.equal(payload.id, undefined);
  assert.equal(payload.case_id, undefined);
});

test('extension delete rejects wrong confirmation without mutating', async () => {
  const tools = await load('extensions', 'extensionTools');
  const ctx = context({ [`get /cases/${caseId}/extensions/${extensionId}`]: definition });
  await assert.rejects(invoke(tools, 'extensions_delete', { extension: extensionId, confirm_name: 'Other' }, ctx), /CRM/);
  assert.equal(ctx.calls.some(call => call[0] === 'delete'), false);
});

test('extension schemas reject unknown config keys and invalid URL/operation path', async () => {
  const tools = await load('extensions', 'extensionTools');
  const ctx = context();
  for (const args of [
    { name: 'Bad', base_url: 'file:///tmp' },
    { name: 'Bad', base_url: 'https://u:p@example.org' },
    { name: 'Bad', base_url: 'https://example.org', operations: [{ name: 'Bad', path: '/%2e%2e/hidden' }] },
    { name: 'Bad', base_url: 'https://example.org', auth: { passwrod: 'typo' } },
  ]) await assert.rejects(invoke(tools, 'extensions_save', args, ctx));
  assert.equal(ctx.calls.length, 0);
});

test('global notifications do not require a selected case', async () => {
  const tools = await load('notifications', 'notificationTools');
  const ctx = context({ 'get /notifications': { items: [], total: 0, limit: 30, offset: 0 } });
  ctx.resolveCase = async () => { throw new Error('No selected case'); };
  await invoke(tools, 'notifications_list', { kind: ['bot.error', 'request.ready'], unread: true }, ctx);
  assert.deepEqual(ctx.calls[0], ['get', '/notifications', { kind: ['bot.error', 'request.ready'], unread: true }]);
});

test('notification setting edit merges the complete settings map', async () => {
  const tools = await load('notifications', 'notificationTools');
  const ctx = context({ 'get /notifications/settings': { kinds: [
    { kind: 'bot.error', enabled: true }, { kind: 'request.ready', enabled: true },
  ] } });
  await invoke(tools, 'notifications_settings_save', { kinds: { 'bot.error': false } }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['put', '/notifications/settings', { kinds: { 'bot.error': false, 'request.ready': true } }]);
});

test('notification read rejects mixed individual and entire-feed selection', async () => {
  const tools = await load('notifications', 'notificationTools');
  const ctx = context();
  await assert.rejects(invoke(tools, 'notifications_read', { ids: [extensionId], all: true }, ctx), /ids.*all|вместе/);
  assert.equal(ctx.calls.length, 0);
});

test('AI usage preserves arbitrary backend choice keys and complete report', async () => {
  const ctx = context({ [`get /cases/${caseId}/ai-usage`]: { totals: { total_tokens: 42 }, choices: { providers: [{ key: 'removed', title: 'Old' }] } } });
  const text = await invoke(aiTools, 'ai_usage', { days: 180, provider: 'removed', bot: 'none', kind: 'summary', model: 'qa/model' }, ctx);
  assert.deepEqual(ctx.calls[0], ['get', `/cases/${caseId}/ai-usage`, { days: 180, provider: 'removed', bot: 'none', kind: 'summary', model: 'qa/model' }]);
  assert.match(text, /total_tokens: 42/);
  assert.match(text, /removed/);
});

test('AI save forwards memory options and explicitly clears base_url', async () => {
  const ctx = context({ [`get /cases/${caseId}/ai-providers`]: [{ id: extensionId, name: 'Model' }] });
  await invoke(aiTools, 'ai_save', { provider: 'Model', base_url: null, options: { memory: 'summary', summary_every: 8, cache_context: false } }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['patch', `/cases/${caseId}/ai-providers/${extensionId}`, { base_url: null, options: { memory: 'summary', summary_every: 8, cache_context: false } }]);
});

test('appearance edit preserves other settings', async () => {
  const appearance = { locale: 'en', mode: 'dark', density: 'compact', motion: 'reduced', accent: 'sky', glass_intensity: 0.5 };
  const ctx = context({ 'get /users/me': { appearance }, 'put /users/me/appearance': { appearance: { ...appearance, accent: 'emerald' } } });
  await invoke(accountTools, 'account_appearance', { accent: 'emerald' }, ctx);
  assert.deepEqual(ctx.calls.at(-1), ['put', '/users/me/appearance', { ...appearance, accent: 'emerald' }]);
});

test('password changes use a local file, never form elicitation or echo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'operbots-password-'));
  const passwordFile = join(dir, 'password.json');
  await writeFile(passwordFile, JSON.stringify({ current_password: 'private-old', new_password: 'private-new' }));
  const ctx = context({ 'post /users/me/password': { message: 'Changed' } });
  ctx.prompter = { available: () => true, form: async () => { throw new Error('Do not ask for secrets in form mode'); } };
  try {
    const text = await invoke(accountTools, 'account_password', { password_file: passwordFile }, ctx);
    assert.equal(text, 'Changed');
    assert.deepEqual(ctx.calls[0], ['post', '/users/me/password', { current_password: 'private-old', new_password: 'private-new' }]);
    assert.doesNotMatch(text, /private-/);
  } finally { await rm(dir, { recursive: true }); }
});

test('case edit forwards settings and clearing description', async () => {
  const ctx = context();
  await invoke(caseTools, 'cases_save', { case: 'QA', description: null, settings: { requests: { enabled: true } } }, ctx);
  assert.deepEqual(ctx.calls[0], ['patch', `/cases/${caseId}`, { description: null, settings: { requests: { enabled: true } } }]);
});

test('case creation applies update-only settings after creating', async () => {
  const ctx = context({ 'post /cases': { id: caseId, name: 'QA' } });
  await invoke(caseTools, 'cases_save', { name: 'QA', settings: { custom: false } }, ctx);
  assert.deepEqual(ctx.calls[0], ['post', '/cases', { name: 'QA' }]);
  assert.deepEqual(ctx.calls[1], ['patch', `/cases/${caseId}`, { settings: { custom: false } }]);
});

test('case card fetches full presentation and settings from current backend', async () => {
  const ctx = context({ [`get /cases/${caseId}`]: { id: caseId, name: 'QA', settings: { custom: 'retained' }, accent: 'violet', owner_id: extensionId }, [`get /cases/${caseId}/overview`]: { days: [] } });
  const text = await invoke(caseTools, 'cases_get', {}, ctx);
  assert.ok(ctx.calls.some(call => call[1] === `/cases/${caseId}`));
  assert.match(text, /retained/);
  assert.match(text, /violet/);
});

test('audit list forwards multiple actions and actor filter and exposes target IDs', async () => {
  const ctx = context({ [`get /cases/${caseId}/audit`]: { items: [{ id: extensionId, action: 'request.update', target_id: extensionId, actor: null }], total: 1, offset: 0 } });
  const text = await invoke(caseTools, 'audit_list', { action: ['request.update', 'request.cancel'], actor_id: extensionId }, ctx);
  assert.deepEqual(ctx.calls[0], ['get', `/cases/${caseId}/audit`, { action: ['request.update', 'request.cancel'], actor_id: extensionId }]);
  assert.match(text, /target_id/);
});

test('login never asks for tokens through form elicitation', async () => {
  const ctx = context();
  ctx.auth = { signedIn: async () => false, knownBaseUrl: async () => null, forget() {} };
  ctx.prompter = { available: () => true, form: async () => { throw new Error('Form must not collect secrets'); } };
  assert.match(await invoke(accountTools, 'operbots_login', {}, ctx), /login/);
});

test('CLI account changes clear the case cache even when login verifies existing access', async () => {
  let account = 'old';
  const api = { get: async () => [{ id: caseId, name: account }] };
  const auth = { forget: () => { account = 'new'; }, signedIn: async () => true,
    whoami: async () => ({ display_name: 'New account', email: 'new@example.com' }),
    baseUrl: async () => 'http://localhost' };
  const ctx = new Context(api, auth, {});
  assert.equal((await ctx.caseList())[0].name, 'old');
  await invoke(accountTools, 'operbots_login', {}, ctx);
  assert.equal((await ctx.caseList())[0].name, 'new');
});

test('secret hints and display names remain readable', () => {
  assert.match(report('QA', { token_name: 'Automation', token_hint: '···1234', token_url: 'https://example.org/oauth', token: 'short' }), /Automation/);
});
