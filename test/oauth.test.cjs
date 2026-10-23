const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { buildAuthUrl, createFlowStore, openInBrowser } = require('../core/agoauth');
const { createApplication } = require('../desktop/application');

const root = path.resolve(__dirname, '..');

test('buildAuthUrl carries the OAuth parameters Google needs', () => {
  const authUrl = buildAuthUrl({ clientId: 'client-x', redirectUri: 'http://127.0.0.1:19823/oauth-callback', state: 'st-1' });
  const url = new URL(authUrl);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-x');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:19823/oauth-callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'st-1');
  const scopes = url.searchParams.get('scope').split(' ');
  for (const scope of ['openid', 'https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/cclog']) {
    assert.ok(scopes.includes(scope), `scope 缺失: ${scope}`);
  }
  assert.ok(!scopes.includes('https://www.googleapis.com/auth/aicode'), 'aicode 未在登录客户端注册，请求即 403');
});

test('flow store issues single-use states that expire', () => {
  let now = 1_000_000;
  const store = createFlowStore({ ttlMs: 5000, now: () => now });
  const first = store.begin();
  const second = store.begin();
  assert.notEqual(first, second);
  assert.equal(store.consume(first), true);
  assert.equal(store.consume(first), false, 'state 只能兑换一次');
  assert.equal(store.consume('never-issued'), false);
  now += 5001;
  assert.equal(store.consume(second), false, '过期的 state 必须失效');
  assert.equal(store.size, 0);
});

test('openInBrowser opens the address through the platform opener', async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  };
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2';
  await openInBrowser(url, 'win32', spawnProcess);
  await openInBrowser(url, 'darwin', spawnProcess);
  await openInBrowser(url, 'linux', spawnProcess);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.ok(calls[0].args.join(' ').includes(`Start-Process '${url}'`), '& 不能被 cmd 吞掉，必须走 PowerShell');
  assert.equal(calls[1].command, 'open');
  assert.deepEqual(calls[1].args, [url]);
  assert.equal(calls[2].command, 'xdg-open');
  assert.deepEqual(calls[2].args, [url]);
});

test('Google authorization adds the account to the pool through the API', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-oauth-'));
  const openedUrls = [];
  const exchangeCalls = [];
  const agCred = {
    async readSystemCredential() { return null; },
    async writeSystemCredential() {},
    async refreshAccessToken() { throw new Error('unused'); },
    async oauthClients() { return [{ id: 'client-x', secret: 'secret-x' }]; },
    async exchangeAuthCode(params) {
      exchangeCalls.push(params);
      return { accessToken: 'at-google', refreshToken: 'rt-google', expiresIn: 3599 };
    },
    async userinfoEmail() { return 'edge-user@gmail.com'; },
    async ensureFresh(account) { return account; }
  };
  const app = createApplication({
    rootDir: root, dataDir, native: true, testMode: true, agCred,
    openUrl: async url => { openedUrls.push(url); }
  });
  let port;
  try {
    port = await app.start();
    const base = `http://127.0.0.1:${port}`;

    const started = await (await fetch(`${base}/api/accounts/oauth/start`, { method: 'POST' })).json();
    assert.equal(started.ok, true);
    assert.equal(openedUrls.length, 1, '必须打开浏览器');
    const authUrl = new URL(started.authUrl);
    assert.equal(authUrl.searchParams.get('client_id'), 'client-x');
    assert.equal(authUrl.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/oauth-callback`);
    const state = authUrl.searchParams.get('state');
    assert.ok(state, '必须携带一次性 state');

    const badState = await fetch(`${base}/oauth-callback?code=c&state=forged`);
    assert.match(await badState.text(), /授权失败/, '伪造的 state 必须被拒绝');

    const denied = await fetch(`${base}/oauth-callback?error=access_denied&state=${state}`);
    assert.match(await denied.text(), /授权未完成/);

    const callback = await fetch(`${base}/oauth-callback?code=auth-code-1&state=${state}`);
    const html = await callback.text();
    assert.match(html, /授权成功/);
    assert.match(html, /edge-user@gmail\.com/);
    assert.deepEqual(exchangeCalls, [{ code: 'auth-code-1', redirectUri: `http://127.0.0.1:${port}/oauth-callback`, proxyPort: 7890 }]);

    const replay = await fetch(`${base}/oauth-callback?code=auth-code-1&state=${state}`);
    assert.match(await replay.text(), /授权失败/, 'state 用一次即失效');

    const accounts = await (await fetch(`${base}/api/accounts`)).json();
    assert.equal(accounts.accounts.items.length, 1);
    assert.equal(accounts.accounts.items[0].email, 'edge-user@gmail.com');
    assert.equal(accounts.accounts.items[0].source, 'google');
    assert.equal(accounts.accounts.items[0].refreshToken, undefined, 'API 不得向外泄露令牌');
  } finally {
    try { await app.close('test done'); } catch { /* already closed */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
