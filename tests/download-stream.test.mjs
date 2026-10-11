import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OperbotsApi } from '../dist/api.js';
import { AuthManager } from '../dist/auth.js';

async function fixture(t, response) {
  const directory = await mkdtemp(join(tmpdir(), 'operbots-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async () => response);
  const config = { baseUrl: 'http://127.0.0.1:1', token: 'opb_TEST_ONLY',
    credentialsPath: join(directory, 'credentials.json'), timeoutMs: 2000 };
  return { destination: join(directory, 'file.bin'),
    api: new OperbotsApi(new AuthManager(config), config) };
}

test('download writes the first chunk while the rest of the response is pending', async t => {
  let complete;
  const release = new Promise(resolve => { complete = resolve; });
  let started;
  const first = new Promise(resolve => { started = resolve; });
  const response = new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      started();
      await release;
      controller.close();
    },
  }));
  const { api, destination } = await fixture(t, response);
  const downloading = api.download('/file', destination);
  await first;
  try {
    const deadline = Date.now() + 1000;
    let bytes = 0;
    while (Date.now() < deadline && bytes < 3) {
      bytes = await stat(destination).then(info => info.size, () => 0);
      if (bytes < 3) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(bytes, 3, 'The first chunk must be on disk before the response ends');
  } finally {
    complete();
    await downloading;
  }
});

test('oversized chunked download stops at the limit and removes its partial file', async t => {
  let chunks = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      chunks += 1;
      if (chunks <= 103) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }));
  const { api, destination } = await fixture(t, response);
  await assert.rejects(api.download('/file', destination), /100 МиБ/);
  assert.equal(cancelled, true);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('body failure removes the new partial file', async t => {
  let reads = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
      else controller.error(new Error('disconnected'));
    },
  }));
  const { api, destination } = await fixture(t, response);
  await assert.rejects(api.download('/file', destination), /disconnected/);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});
