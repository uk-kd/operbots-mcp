/** Assertions of current audit findings; no real API or file mutation. */
import assert from 'node:assert/strict';
import { flowTools } from '../../dist/tools/flows.js';
import { peopleTools } from '../../dist/tools/people.js';

const caseId = '11111111-1111-4111-8111-111111111111';
const botId = '22222222-2222-4222-8222-222222222222';
const first = { id: '33333333-3333-4333-8333-333333333333', name: 'Поддержка',
  graph: { nodes: [], edges: [] }, version: 1, scope: 'dialog', problems: [] };
const second = { ...first, id: '44444444-4444-4444-8444-444444444444' };
let selected;
const context = {
  resolveCase: async () => ({ id: caseId, name: 'QA' }),
  resolveBot: async () => ({ id: botId, name: 'QA bot' }),
  api: { get: async (path) => {
    if (path.endsWith('/flows')) return [first, second];
    selected = path.split('/').at(-1);
    return selected === first.id ? first : second;
  } },
};
await flowTools.find(tool => tool.name === 'flows_get').run(
  { bot: botId, flow: 'Поддержка' }, context);
assert.equal(selected, first.id);
console.log('CONFIRMED: duplicate flow names silently select the first flow');
first.name = 'Поддержка сайта';
second.name = 'Поддержка магазина';
await flowTools.find(tool => tool.name === 'flows_get').run(
  { bot: botId, flow: 'Поддержка' }, context);
assert.equal(selected, first.id);
console.log('CONFIRMED: ambiguous partial flow names also select the first flow');

const revoke = peopleTools.find(tool => tool.name === 'invites_revoke');
assert.equal(revoke.input.invite_id.safeParse('not-a-uuid').success, true);
assert.equal(revoke.input.invite_id.safeParse('segment/another-segment').success, true);
// Only record URL normalization in a mock; never execute a real deletion.
let requested;
context.api.delete = async (path) => { requested = new URL(path, 'http://127.0.0.1').pathname; };
const input = '../bots/' + botId;
assert.equal(revoke.input.invite_id.safeParse(input).success, true);
await revoke.run({ case: caseId, invite_id: input }, context);
assert.equal(requested, '/cases/' + caseId + '/bots/' + botId);
console.log('CONFIRMED: invite_id accepts arbitrary text and multiple path segments');
console.log('CONFIRMED in a mock: accepted invite_id can normalize to another resource route');
console.log('2 isolated MCP probes passed; these assertions describe defects, not fixes.');
