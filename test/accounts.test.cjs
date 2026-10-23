const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAccounts } = require('../core/accounts');
const { buildProxyLaunch } = require('../features/proxy');
const { Session } = require('../core/session');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-accounts-'));
  const dataDir = path.join(root, 'data');
  const appData = path.join(root, 'appdata');
  const defaultProfileDir = path.join(appData, 'Antigravity');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(defaultProfileDir, { recursive: true });
  const accounts = createAccounts(dataDir, { appData, defaultProfileDir });
  return { root, dataDir, appData, defaultProfileDir, accounts };
}

test('registry starts with a default account pointing at the AG profile', () => {
  const { accounts, defaultProfileDir } = fixture();
  const snapshot = accounts.snapshot();
  assert.equal(snapshot.activeId, 'default');
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].isDefault, true);
  assert.equal(snapshot.items[0].userDataDir, null);
  assert.equal(accounts.activeProfileDir(), defaultProfileDir);
});

test('add creates an isolated profile directory and selects the new account', () => {
  const { accounts, appData } = fixture();
  const snapshot = accounts.add('小号');
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.activeId, snapshot.items[1].id);
  const added = snapshot.items[1];
  assert.notEqual(added.userDataDir, null);
  assert.ok(added.userDataDir.startsWith(path.join(appData, 'EasyAG-Accounts') + path.sep));
  assert.ok(fs.existsSync(added.userDataDir), '账户目录必须已创建');
  assert.equal(accounts.activeProfileDir(), added.userDataDir);
});

test('select switches the active profile and rejects unknown ids', () => {
  const { accounts } = fixture();
  const added = accounts.add('second').items[1];
  accounts.select('default');
  assert.equal(accounts.snapshot().activeId, 'default');
  assert.equal(accounts.activeProfileDir(), accounts.snapshot().items[0].profileDir);
  accounts.select(added.id);
  assert.equal(accounts.activeProfileDir(), added.userDataDir);
  assert.throws(() => accounts.select('missing'), /账户不存在/);
});

test('remove deletes the account directory and falls back to the default account', () => {
  const { accounts } = fixture();
  const added = accounts.add('temp').items[1];
  const dir = added.userDataDir;
  fs.writeFileSync(path.join(dir, 'marker'), 'x');
  const snapshot = accounts.remove(added.id);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.activeId, 'default');
  assert.ok(!fs.existsSync(dir), '账户目录必须被删除');
  assert.throws(() => accounts.remove('default'), /默认档案不可删除/);
});

test('email label comes from the profile app_storage.json login name', () => {
  const { accounts, defaultProfileDir } = fixture();
  fs.writeFileSync(path.join(defaultProfileDir, 'app_storage.json'), JSON.stringify({ 'jetski.onboarding.lastLoginUsername': 'cooleava1@gmail.com' }));
  const snapshot = accounts.snapshot();
  assert.equal(snapshot.items[0].email, 'cooleava1@gmail.com');
});

test('registry survives reload from disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-accounts-'));
  const dataDir = path.join(root, 'data');
  const appData = path.join(root, 'appdata');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  const first = createAccounts(dataDir, { appData, defaultProfileDir: path.join(appData, 'Antigravity') });
  const added = first.add('persisted').items[1];
  const second = createAccounts(dataDir, { appData, defaultProfileDir: path.join(appData, 'Antigravity') });
  assert.equal(second.snapshot().items.length, 2);
  assert.equal(second.activeProfileDir(), added.userDataDir);
});

test('buildProxyLaunch only adds --user-data-dir for isolated accounts', () => {
  const plain = buildProxyLaunch(7890, 9333, { PATH: 'x' });
  assert.ok(!plain.args.some(arg => arg.startsWith('--user-data-dir')));
  assert.equal(plain.env.PATH, 'x');
  const isolated = buildProxyLaunch(7890, 9333, { PATH: 'x' }, 'C:\\AG-Profiles\\acc-1');
  assert.ok(isolated.args.includes('--user-data-dir=C:\\AG-Profiles\\acc-1'));
  assert.ok(isolated.args.includes('--proxy-server=http://127.0.0.1:7890'));
});

test('Session launches AG with the active account data directory', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 123; child.exitCode = null; child.kill = () => calls.push('kill');
  const accounts = { active: () => ({ id: 'a1', name: '小号', userDataDir: 'C:\\AG-Profiles\\a1' }) };
  const session = new Session({
    settings: { get: () => ({ port: 7890, enableI18n: true, enableContextMonitor: true }) },
    desktop: { locate: () => ({ exists: true, appExe: 'test' }), running: async () => false, accounts },
    cdp: { port: 9333, start: () => calls.push('cdp'), stop: async () => calls.push('stop-cdp') },
    events: { log() {}, publish() {} }, host: { hide() {} },
    spawnProcess(_exe, args) { calls.push(args); process.nextTick(() => child.emit('spawn')); return child; }
  });
  assert.equal((await session.launch()).ok, true);
  assert.ok(calls[0].includes('--user-data-dir=C:\\AG-Profiles\\a1'));
  child.emit('exit');
  await session.finishing;
});

test('Session keeps the default profile when the adapter has no accounts registry', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 123; child.exitCode = null; child.kill = () => calls.push('kill');
  const session = new Session({
    settings: { get: () => ({ port: 7890, enableI18n: true, enableContextMonitor: true }) },
    desktop: { locate: () => ({ exists: true, appExe: 'test' }), running: async () => false },
    cdp: { port: 9333, start: () => calls.push('cdp'), stop: async () => calls.push('stop-cdp') },
    events: { log() {}, publish() {} }, host: { hide() {} },
    spawnProcess(_exe, args) { calls.push(args); process.nextTick(() => child.emit('spawn')); return child; }
  });
  assert.equal((await session.launch()).ok, true);
  assert.ok(!calls[0].some(arg => arg.startsWith('--user-data-dir')));
  child.emit('exit');
  await session.finishing;
});
