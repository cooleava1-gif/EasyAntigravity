const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createAgCred,
  buildCredentialPayload,
  parseCredentialPayload,
  parseTokenResponse,
  toRfc3339Micros,
  parseRfc3339,
  extractOauthClients,
  AG_REFRESH_CLIENT_ID
} = require('../core/agcred');

test('credential payload matches the format AG reads', () => {
  const payload = buildCredentialPayload({ accessToken: 'at', refreshToken: 'rt', expiryTs: Date.UTC(2026, 9, 23, 12, 0, 0, 0) });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.token.access_token, 'at');
  assert.equal(parsed.token.token_type, 'Bearer');
  assert.equal(parsed.token.refresh_token, 'rt');
  assert.equal(parsed.auth_method, 'consumer');
  assert.equal(parsed.token.expiry, '2026-10-23T12:00:00.000000Z');
  assert.match(parsed.token.expiry, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
});

test('payload round-trips through parseCredentialPayload', () => {
  const expiryTs = Date.UTC(2026, 9, 23, 12, 0, 0, 0);
  const parsed = parseCredentialPayload(buildCredentialPayload({ accessToken: 'at', refreshToken: 'rt', expiryTs }));
  assert.deepEqual(parsed, { accessToken: 'at', refreshToken: 'rt', expiryTs });
  assert.equal(toRfc3339Micros(expiryTs), '2026-10-23T12:00:00.000000Z');
  assert.equal(parseRfc3339('2026-10-23T12:00:00.000000Z'), expiryTs);
});

test('parseCredentialPayload rejects payloads without a refresh token', () => {
  assert.throws(() => parseCredentialPayload(JSON.stringify({ token: { access_token: 'at' } })), /refresh_token/);
  assert.throws(() => parseCredentialPayload('not-json'), undefined);
});

test('parseTokenResponse validates the refresh response', () => {
  assert.deepEqual(parseTokenResponse('{"access_token":"at","expires_in":3599,"refresh_token":"rt2"}'), {
    accessToken: 'at', refreshToken: 'rt2', expiresIn: 3599
  });
  assert.throws(() => parseTokenResponse('{"expires_in":3599}'), /access_token/);
});

function fakeSpawn({ stdout = '', closeCode = 0, sink = [] } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: chunk => sink.push(String(chunk)) };
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', closeCode);
    }, 0);
    return child;
  };
}

test('readSystemCredential decodes the helper output', async () => {
  const payload = buildCredentialPayload({ accessToken: 'at', refreshToken: 'rt', expiryTs: Date.now() + 3600_000 });
  const agcred = createAgCred({
    scriptPath: 'agcred.ps1',
    platform: 'win32',
    spawnProcess: fakeSpawn({ stdout: Buffer.from(payload, 'utf8').toString('base64') })
  });
  const credential = await agcred.readSystemCredential();
  assert.equal(credential.refreshToken, 'rt');
  assert.equal(credential.accessToken, 'at');
});

test('readSystemCredential returns null when nothing is stored', async () => {
  const agcred = createAgCred({ scriptPath: 'agcred.ps1', platform: 'win32', spawnProcess: fakeSpawn({}) });
  assert.equal(await agcred.readSystemCredential(), null);
});

test('writeSystemCredential pipes the payload to the PowerShell helper', async () => {
  const sink = [];
  const agcred = createAgCred({ scriptPath: 'agcred.ps1', platform: 'win32', spawnProcess: fakeSpawn({ sink }) });
  await agcred.writeSystemCredential({ accessToken: 'at', refreshToken: 'rt', expiryTs: Date.now() + 3600_000 });
  assert.equal(sink.length, 1);
  const decoded = JSON.parse(Buffer.from(sink[0], 'base64').toString('utf8'));
  assert.equal(decoded.token.refresh_token, 'rt');
  assert.equal(decoded.token.token_type, 'Bearer');
});

test('non-Windows platforms report the credential as absent', async () => {
  const agcred = createAgCred({ scriptPath: 'agcred.ps1', platform: 'darwin', spawnProcess: fakeSpawn({}) });
  assert.equal(await agcred.readSystemCredential(), null);
  await assert.rejects(() => agcred.writeSystemCredential({ refreshToken: 'rt' }), /不支持/);
});

test('ensureFresh only refreshes when the token is near expiry, through the proxy', async () => {
  const calls = [];
  const agcred = createAgCred({
    scriptPath: 'agcred.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: 'client-a', secret: 'secret-a' }],
    execFileAsync: async (command, args) => {
      calls.push(args.join(' '));
      return { stdout: JSON.stringify({ access_token: 'fresh', expires_in: 3600 }) };
    }
  });
  const stillValid = await agcred.ensureFresh({ accessToken: 'old', refreshToken: 'rt', expiryTs: Date.now() + 3600_000 }, 7897);
  assert.equal(stillValid.accessToken, 'old');
  assert.equal(calls.length, 0, 'fresh tokens must not trigger a refresh');

  const refreshed = await agcred.ensureFresh({ accessToken: 'old', refreshToken: 'rt', expiryTs: Date.now() + 60_000 }, 7897);
  assert.equal(refreshed.accessToken, 'fresh');
  assert.equal(refreshed.refreshToken, 'rt', 'keep the original refresh_token when the response omits it');
  assert.ok(refreshed.expiryTs > Date.now());
  assert.equal(calls.length, 1);
  assert.match(calls[0], /oauth2\.googleapis\.com/);
  assert.match(calls[0], /--proxy http:\/\/127\.0\.0\.1:7897/);
});

test('refreshAccessToken retries with the IDE client when the public client rejects the token', async () => {
  const seen = [];
  const agcred = createAgCred({
    scriptPath: 'agcred.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: 'client-a', secret: 'secret-a' }, { id: 'client-b', secret: 'secret-b' }],
    execFileAsync: async (command, args) => {
      seen.push(args.join(' '));
      // The public client rejects the token, the IDE's own client accepts it.
      if (seen.length === 1) return { stdout: JSON.stringify({ error: 'unauthorized_client', error_description: 'Unauthorized' }) };
      return { stdout: JSON.stringify({ access_token: 'from-ide-client', expires_in: 3600 }) };
    }
  });
  const fresh = await agcred.refreshAccessToken('rt-from-ide', 7897);
  assert.equal(fresh.accessToken, 'from-ide-client');
  assert.equal(seen.length, 2);
  assert.match(seen[0], /client-a/);
  assert.match(seen[1], /client-b/);
});

test('refreshAccessToken reports the server error when every client fails', async () => {
  const agcred = createAgCred({
    scriptPath: 'agcred.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: 'client-a', secret: 'secret-a' }],
    execFileAsync: async () => ({ stdout: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked' }) })
  });
  await assert.rejects(() => agcred.refreshAccessToken('rt-dead', 7897), /invalid_grant.*Token has been expired or revoked/);
});

test('refreshAccessToken explains when no OAuth client is available', async () => {
  const agcred = createAgCred({
    scriptPath: 'agcred.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [],
    execFileAsync: async () => ({ stdout: '{}' })
  });
  await assert.rejects(() => agcred.refreshAccessToken('rt', 7897), /未找到可用的 OAuth 客户端/);
});

test('extractOauthClients finds every client pair in a binary dump', () => {
  const idA = ['123456789012', 'abcdefghijklmnopqrstuvwxyz012345'].join('-') + '.apps.googleusercontent.com';
  const idB = ['987654321098', 'zyxwvutsrqponmlkjihgfedcba543210'].join('-') + '.apps.googleusercontent.com';
  const secretA = 'GOCSPX-' + 'A'.repeat(28);
  const secretB = 'GOCSPX-' + 'B'.repeat(28);
  const dump = ['padding', idA, secretA + 'https', idB, secretB + 'decoding', 'more'].join('\u0000\u0000');
  const clients = extractOauthClients(dump);
  assert.equal(clients.length, 4, '两个 id 与两个 secret 应产生全部组合');
  assert.deepEqual(clients[0], { id: idA, secret: secretA });
  assert.ok(clients.some(client => client.id === idB && client.secret === secretB));
  assert.deepEqual(extractOauthClients('nothing here'), []);
});

test('extractOauthClients leads with the client AG refreshes with', () => {
  // The authorize URL must be built with AG's refresh client, so it has to come first even
  // when the binary lists the other (IDE) client earlier.
  const other = ['900000000000', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'].join('-') + '.apps.googleusercontent.com';
  const dump = [other, 'GOCSPX-' + 'A'.repeat(28), AG_REFRESH_CLIENT_ID, 'GOCSPX-' + 'B'.repeat(28)].join('\u0000\u0000');
  const clients = extractOauthClients(dump);
  assert.equal(clients[0].id, AG_REFRESH_CLIENT_ID);
  assert.equal(clients[2].id, other, '另一个客户端的 secret 组合紧随其后');
});

test('extractOauthClients keeps the binary order when AG rotates its refresh client away', () => {
  const only = ['900000000000', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'].join('-') + '.apps.googleusercontent.com';
  const dump = [only, 'GOCSPX-' + 'A'.repeat(28)].join('\u0000\u0000');
  const clients = extractOauthClients(dump);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].id, only, '认不出公开客户端时退回二进制里的原始顺序');
});
