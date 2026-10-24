const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccounts } = require('../core/accounts');
const { buildProxyLaunch } = require('../features/proxy');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-accounts-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const accounts = createAccounts(dataDir);
  return { root, dataDir, accounts };
}

test('registry starts with an empty pool', () => {
  const { accounts } = fixture();
  const snapshot = accounts.snapshot();
  assert.equal(snapshot.activeId, null);
  assert.deepEqual(snapshot.items, []);
  assert.equal(accounts.active(), null);
});

test('upsert adds an account, selects it and dedupes by refresh token', () => {
  const { accounts } = fixture();
  const first = accounts.upsert({ email: 'a@gmail.com', refreshToken: 'rt-a', source: 'manual' });
  assert.equal(accounts.snapshot().activeId, first.id);
  assert.equal(accounts.snapshot().items.length, 1);

  const again = accounts.upsert({ email: 'a@gmail.com', refreshToken: 'rt-a', accessToken: 'at-new' });
  assert.equal(again.id, first.id, '同一个 refresh_token 必须合并而不是重复添加');
  assert.equal(accounts.snapshot().items.length, 1);
  assert.equal(accounts.find(first.id).accessToken, 'at-new');

  const second = accounts.upsert({ email: 'b@gmail.com', refreshToken: 'rt-b', source: 'manual', select: true });
  assert.equal(accounts.snapshot().activeId, second.id);
  assert.equal(accounts.snapshot().items.length, 2);
});

test('upsert rejects entries without a refresh token', () => {
  const { accounts } = fixture();
  assert.throws(() => accounts.upsert({ email: 'a@gmail.com' }), /refresh_token/);
});

test('upsert merges by email so one Google account is one pool entry', () => {
  const { accounts } = fixture();
  const first = accounts.upsert({ email: 'a@gmail.com', refreshToken: 'rt-a', name: 'A 君', source: 'manual' });
  // 同一个邮箱但不同的 refresh_token（重新授权、或重新保存当前登录）必须合并，
  // 而不是留下一个没有邮箱的"当前 AG 登录"式重复条目。
  const again = accounts.upsert({ email: 'A@Gmail.com', refreshToken: 'rt-a2', accessToken: 'at-new', source: 'current' });
  assert.equal(again.id, first.id, '同一邮箱必须合并（忽略大小写）');
  assert.equal(accounts.snapshot().items.length, 1);
  assert.equal(accounts.find(first.id).refreshToken, 'rt-a2', '合并后应换成新令牌');
  assert.equal(accounts.find(first.id).accessToken, 'at-new');
  assert.equal(accounts.find(first.id).name, 'A 君', '已有名字的条目保留原名');
  assert.equal(accounts.find(first.id).source, 'current');

  const other = accounts.upsert({ email: 'b@gmail.com', refreshToken: 'rt-b' });
  assert.notEqual(other.id, first.id, '不同邮箱仍是不同条目');
  assert.equal(accounts.snapshot().items.length, 2);
});

test('upsert fills in a missing email when the same token comes back', () => {
  const { accounts } = fixture();
  const first = accounts.upsert({ refreshToken: 'rt-x', name: 'AG 登录账户' });
  assert.equal(accounts.snapshot().items[0].email, null);
  const again = accounts.upsert({ email: 'x@gmail.com', refreshToken: 'rt-x' });
  assert.equal(again.id, first.id);
  assert.equal(accounts.snapshot().items[0].email, 'x@gmail.com');
  assert.equal(accounts.snapshot().items[0].name, 'x@gmail.com', '补识邮箱后用邮箱做名字');
});

test('snapshot never leaks tokens and flags the live account', () => {
  const { accounts } = fixture();
  const account = accounts.upsert({ email: 'a@gmail.com', refreshToken: 'rt-a', accessToken: 'at-a' });
  const snapshot = accounts.snapshot('rt-a');
  const item = snapshot.items[0];
  assert.equal(item.isLive, true);
  assert.equal(snapshot.liveId, account.id);
  assert.equal(item.accessToken, undefined);
  assert.equal(item.refreshToken, undefined);
  assert.equal(item.email, 'a@gmail.com');
  assert.equal(accounts.snapshot('rt-other').items[0].isLive, false);
  assert.equal(accounts.snapshot().items[0].isLive, false);
});

test('select, updateTokens and remove manage the pool', () => {
  const { accounts } = fixture();
  const first = accounts.upsert({ email: 'a@gmail.com', refreshToken: 'rt-a' });
  const second = accounts.upsert({ email: 'b@gmail.com', refreshToken: 'rt-b' });
  assert.throws(() => accounts.select('missing'), /账户不存在/);

  accounts.updateTokens(first.id, { accessToken: 'at-fresh', expiryTs: 123 });
  assert.equal(accounts.find(first.id).accessToken, 'at-fresh');
  assert.equal(accounts.find(first.id).expiryTs, 123);

  accounts.select(first.id);
  assert.equal(accounts.snapshot().activeId, first.id);
  const snapshot = accounts.remove(first.id);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.activeId, second.id, '删除当前账户后回退到池中第一个');
});

test('registry state survives a reload', () => {
  const { dataDir } = fixture();
  const first = createAccounts(dataDir);
  const account = first.upsert({ email: 'a@gmail.com', refreshToken: 'rt-a', source: 'manual' });
  const second = createAccounts(dataDir);
  assert.equal(second.snapshot().items.length, 1);
  assert.equal(second.snapshot().items[0].email, 'a@gmail.com');
  assert.equal(second.snapshot().activeId, account.id);
});

test('legacy v1 profile state is replaced by a fresh pool', () => {
  const { dataDir } = fixture();
  const file = path.join(dataDir, 'accounts.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, activeId: 'default', accounts: [{ id: 'default', name: 'old-default', userDataDir: null }] }));
  const accounts = createAccounts(dataDir);
  assert.deepEqual(accounts.snapshot().items, []);
});

test('buildProxyLaunch carries the proxy flags and no profile flag', () => {
  const launch = buildProxyLaunch(7897, 9333);
  assert.ok(launch.args.includes('--proxy-server=http://127.0.0.1:7897'));
  assert.ok(launch.args.some(arg => arg.startsWith('--remote-debugging-port=')));
  assert.ok(!launch.args.some(arg => arg.startsWith('--user-data-dir')), 'profile mode removed; must not pass --user-data-dir');
  assert.equal(launch.env.HTTP_PROXY, 'http://127.0.0.1:7897');
});
