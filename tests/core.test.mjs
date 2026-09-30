import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { OperbotsApi, requireLocalPath } from '../dist/api.js';
import { AuthManager } from '../dist/auth.js';
import { loadConfig } from '../dist/config.js';
import * as context from '../dist/context.js';
import { ApiError, AuthRequiredError, ConnectionError } from '../dist/errors.js';

const identity = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'test@example.invalid',
  full_name: 'Test User', display_name: 'Test User', profile_completed: true,
  is_superuser: false, timezone: 'Europe/Moscow', last_case_id: null,
};

function config(baseUrl, credentialsPath, extra = {}) {
  return { baseUrl, credentialsPath, token: 'opb_TEST_ONLY', defaultCase: null,
    readOnly: false, timeoutMs: 2000, insecureTls: false, ...extra };
}

function client(settings) {
  return new OperbotsApi(new AuthManager(settings), settings);
}

function json(response, payload, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

test('local file paths reject Windows network shares and device endpoints before I/O', async () => {
  const api = client(config('http://127.0.0.1:1', 'unused'));
  for (const path of [String.raw`\\qa-invalid.example\share\file.txt`,
    String.raw`\\?\UNC\qa-invalid.example\share\file.txt`, String.raw`\\.\pipe\qa`,
    '//qa-invalid.example/share/file.txt']) {
    assert.throws(() => requireLocalPath(path), /локальный/);
    await assert.rejects(api.upload('/files', path), /локальный/);
    await assert.rejects(api.download('/files', path), /локальный/);
  }
});

test('API redirects cannot forward passwords or uploaded content to another origin', async t => {
  let forwarded = 0;
  const target = await panel(t, (_request, response) => {
    forwarded += 1;
    json(response, { ok: true });
  });
  const source = await panel(t, (request, response) => {
    request.resume();
    response.writeHead(307, { Location: `${target}/received` });
    response.end();
  });
  const api = client(config(source, 'unused'));
  const file = new FormData();
  file.append('file', new Blob(['dummy content']), 'file.txt');
  for (const body of [{ current_password: 'dummy-old', new_password: 'dummy-new' }, file]) {
    await assert.rejects(api.post('/users/me/password', body), ConnectionError);
  }
  assert.equal(forwarded, 0);
});

async function panel(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'operbots-core-'));
  t.after(async () => {
    assert.equal(dirname(path), tmpdir());
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

test('upload sends authenticated native multipart with filename, binary content and form fields', async t => {
  const directory = await temporary(t);
  const file = join(directory, 'document.bin');
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  await writeFile(file, bytes);
  const received = [];
  const base = await panel(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, url: request.url, headers: request.headers,
      body: Buffer.concat(chunks) });
    json(response, { id: 'uploaded' });
  });
  const api = client(config(base, join(directory, 'credentials.json')));
  assert.equal(typeof api.upload, 'function', 'upload API is missing');
  assert.deepEqual(await api.upload('/files', file,
    { caption: 'Тест', take_over: false, count: 2 }, 'application/octet-stream'), { id: 'uploaded' });
  assert.equal(received.length, 1);
  const request = received[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/files');
  assert.equal(request.headers.authorization, 'Bearer opb_TEST_ONLY');
  assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(request.body.includes(bytes));
  assert.match(request.body.toString(), /name="file"; filename="document.bin"/);
  assert.match(request.body.toString(), /name="caption"\r\n\r\nТест\r\n/);
  assert.match(request.body.toString(), /name="take_over"\r\n\r\nfalse\r\n/);
  assert.match(request.body.toString(), /name="count"\r\n\r\n2\r\n/);
});

test('upload rejects relative paths and files above 20 MiB before contacting the panel', async t => {
  const directory = await temporary(t);
  const file = join(directory, 'large.bin');
  await writeFile(file, '');
  await truncate(file, 20 * 1024 * 1024 + 1);
  let calls = 0;
  const base = await panel(t, (_request, response) => { calls += 1; json(response, {}); });
  const api = client(config(base, join(directory, 'credentials.json')));
  assert.equal(typeof api.upload, 'function', 'upload API is missing');
  await assert.rejects(api.upload('/files', 'relative.bin'), /абсолютн/i);
  await assert.rejects(api.upload('/files', file), /20/);
  assert.equal(calls, 0);
});

test('file upload infers media type so photos are sent as photos', async t => {
  const directory = await temporary(t);
  const file = join(directory, 'picture.PNG');
  await writeFile(file, Buffer.from([137, 80, 78, 71]));
  let content = '';
  const base = await panel(t, async (request, response) => {
    for await (const chunk of request) content += chunk;
    json(response, {});
  });
  await client(config(base, join(directory, 'credentials.json'))).upload('/upload', file);
  assert.match(content, /Content-Type: image\/png/i);
});

test('download preserves binary bytes and refuses to overwrite an existing file', async t => {
  const directory = await temporary(t);
  const destination = join(directory, 'export.bin');
  const bytes = Buffer.from([0, 255, 1, 128, 13, 10]);
  const received = [];
  const base = await panel(t, (request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(bytes);
  });
  const api = client(config(base, join(directory, 'credentials.json')));
  assert.equal(typeof api.download, 'function', 'download API is missing');
  assert.deepEqual(await api.download('/export', destination, { format: 'binary' }),
    { path: destination, bytes: 6, content_type: 'application/octet-stream' });
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal(received[0].url, '/api/v1/export?format=binary');
  assert.equal(received[0].authorization, 'Bearer opb_TEST_ONLY');
  await assert.rejects(api.download('/export', destination), { code: 'EEXIST' });
  assert.deepEqual(await readFile(destination), bytes);
  await assert.rejects(api.download('/export', 'relative.bin'), /абсолютн/i);
});

test('failed download preserves API permission details and creates no local file', async t => {
  const directory = await temporary(t);
  const destination = join(directory, 'denied.bin');
  const base = await panel(t, (_request, response) => json(response,
    { code: 'permission_denied', message: 'Нет прав', details: { required: ['dialogs.export'] } }, 403));
  const api = client(config(base, join(directory, 'credentials.json')));
  assert.equal(typeof api.download, 'function', 'download API is missing');
  await assert.rejects(api.download('/export', destination), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 403);
    assert.deepEqual(error.details.required, ['dialogs.export']);
    return true;
  });
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});

test('timeout during the response body returns the shared readable connection error', async t => {
  const directory = await temporary(t);
  const base = await panel(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  const api = client(config(base, join(directory, 'credentials.json'), { timeoutMs: 80 }));
  await assert.rejects(api.get('/slow'), error => {
    assert.ok(error instanceof ConnectionError);
    assert.match(error.message, /OPERBOTS_TIMEOUT_MS/);
    return true;
  });
});

test('whoami verifies live identity and rejects a token revoked after an earlier call', async t => {
  const directory = await temporary(t);
  let revoked = false;
  const base = await panel(t, (_request, response) => {
    if (revoked) json(response, { code: 'invalid_token', message: 'Отозван' }, 401);
    else json(response, identity);
  });
  const auth = new AuthManager(config(base, join(directory, 'credentials.json')));
  assert.equal((await auth.whoami()).id, identity.id);
  revoked = true;
  await assert.rejects(auth.whoami(), error => error instanceof ApiError && error.status === 401);
});

test('explicit signIn switches API calls from environment credentials to the validated profile', async t => {
  const directory = await temporary(t);
  const oldBase = await panel(t, (_request, response) => json(response, { source: 'old' }));
  const newBase = await panel(t, (request, response) => {
    if (request.headers.authorization !== 'Bearer opb_NEW_ONLY') {
      json(response, { code: 'invalid_token', message: 'Wrong token' }, 401);
    } else json(response, request.url === '/api/v1/users/me' ? identity : { source: 'new' });
  });
  const settings = config(oldBase, join(directory, 'credentials.json'));
  const auth = new AuthManager(settings);
  const api = new OperbotsApi(auth, settings);
  await auth.signIn(newBase, 'opb_NEW_ONLY');
  assert.deepEqual(await api.get('/origin'), { source: 'new' });
});

test('invalid header characters in a token are rejected without exposing the token', async t => {
  const directory = await temporary(t);
  let calls = 0;
  const base = await panel(t, (_request, response) => { calls += 1; json(response, identity); });
  const token = 'opb_DO_NOT_EXPOSE\ninvalid';
  const auth = new AuthManager(config(base, join(directory, 'credentials.json'), { token }));
  await assert.rejects(auth.whoami(), error => {
    assert.ok(error instanceof AuthRequiredError);
    assert.ok(!error.message.includes('DO_NOT_EXPOSE'));
    return true;
  });
  assert.equal(calls, 0);
});

test('empty or ambiguous names cannot select a resource for a mutation', () => {
  const { pickByName } = context;
  assert.equal(typeof pickByName, 'function', 'shared name resolver is missing');
  const rows = [{ id: '1', name: 'North' }, { id: '2', name: 'North support' }];
  assert.throws(() => pickByName([rows[0]], '   '), error => error instanceof ApiError && error.status === 400);
  assert.equal(pickByName(rows, ' North ').id, '1');
  assert.throws(() => pickByName(rows, 'ort'), error => error instanceof ApiError && error.code === 'ambiguous');
});

test('PUT sends repeated query keys and preserves false and zero', async t => {
  const directory = await temporary(t);
  const base = await panel(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    json(response, { method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks)) });
  });
  const api = client(config(base, join(directory, 'credentials.json')));
  assert.deepEqual(await api.put('/contacts/1', { active: false },
    { replace_counterparty_id: '2', kind: ['a', 'b'], zero: 0, flag: false }),
  { method: 'PUT', url: '/api/v1/contacts/1?replace_counterparty_id=2&kind=a&kind=b&zero=0&flag=false',
    body: { active: false } });
});

test('invalid timer sizes fall back to a usable request timeout', () => {
  const previous = process.env.OPERBOTS_TIMEOUT_MS;
  try {
    for (const value of ['0.5', '2147483648', 'Infinity', '-1']) {
      process.env.OPERBOTS_TIMEOUT_MS = value;
      assert.equal(loadConfig().timeoutMs, 30000);
    }
  } finally {
    if (previous === undefined) delete process.env.OPERBOTS_TIMEOUT_MS;
    else process.env.OPERBOTS_TIMEOUT_MS = previous;
  }
});
