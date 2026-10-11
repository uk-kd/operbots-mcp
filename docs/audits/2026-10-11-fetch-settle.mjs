/** Diagnostic preload: allows HTTP transactions to settle before the next call.
 * This is NOT a production workaround or a passing baseline integration test.
 * Use only with the guarded tests/backend-fixture.py disposable database.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

assert.equal(process.env.OPERBOTS_AUDIT_SETTLE, '1');
const fixture = JSON.parse(await readFile(process.env.OPERBOTS_QA_FIXTURE, 'utf8'));
assert.equal(fixture.database, 'operbots_mcp_qa');
assert.equal(new URL(fixture.url).hostname, '127.0.0.1');
const fetchBeforeAudit = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await fetchBeforeAudit(...args);
  const method = (args[1]?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && new URL(response.url).origin === fixture.url) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return response;
};
