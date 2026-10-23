const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('./storage');

const DEFAULT_ACCOUNT_ID = 'default';
const ACCOUNT_ROOT_NAME = 'EasyAG-Accounts';
const EMAIL_KEY = 'jetski.onboarding.lastLoginUsername';

function safeSlug(name) {
  const slug = String(name || '').normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'account';
}

function readLoginEmail(profileDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profileDir, 'app_storage.json'), 'utf8'));
    const email = raw[EMAIL_KEY];
    return typeof email === 'string' && email.includes('@') ? email : null;
  } catch { return null; }
}

// The default account keeps using Antigravity's own profile directory; every other
// account gets an isolated directory so switching never mixes logins or history.
function createAccounts(dataDir, { appData, defaultProfileDir }) {
  const file = path.join(dataDir, 'accounts.json');
  const accountRoot = path.join(appData, ACCOUNT_ROOT_NAME);
  let state = readJson(file, null);
  if (!state || !Array.isArray(state.accounts) || !state.accounts.some(account => account.id === DEFAULT_ACCOUNT_ID)) {
    state = { version: 1, activeId: DEFAULT_ACCOUNT_ID, accounts: [{ id: DEFAULT_ACCOUNT_ID, name: '默认档案', userDataDir: null, createdAt: Date.now() }] };
    writeJson(file, state);
  }
  if (!state.accounts.some(account => account.id === state.activeId)) state.activeId = DEFAULT_ACCOUNT_ID;
  const save = () => writeJson(file, state);
  const find = id => state.accounts.find(account => account.id === id) || null;
  const profileDirOf = account => account.userDataDir || defaultProfileDir;
  const active = () => find(state.activeId) || find(DEFAULT_ACCOUNT_ID);
  const emailCache = new Map();

  const emailOf = account => {
    const dir = profileDirOf(account);
    const stamp = path.join(dir, 'app_storage.json');
    try {
      const mtime = fs.statSync(stamp).mtimeMs;
      const cached = emailCache.get(account.id);
      if (cached && cached.mtime === mtime) return cached.email;
      const email = readLoginEmail(dir);
      emailCache.set(account.id, { mtime, email });
      return email;
    } catch { return readLoginEmail(dir); }
  };

  const snapshot = () => ({
    activeId: active().id,
    items: state.accounts.map(account => ({
      id: account.id,
      name: account.name,
      userDataDir: account.userDataDir || null,
      profileDir: profileDirOf(account),
      email: emailOf(account),
      isDefault: account.id === DEFAULT_ACCOUNT_ID
    }))
  });

  return {
    snapshot,
    active,
    activeProfileDir: () => profileDirOf(active()),
    select(id) {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      state.activeId = account.id;
      save();
      return snapshot();
    },
    add(name) {
      const trimmed = String(name || '').trim().slice(0, 40) || `账户 ${state.accounts.length + 1}`;
      const id = randomUUID();
      const userDataDir = path.join(accountRoot, `${safeSlug(trimmed)}-${id.slice(0, 8)}`);
      fs.mkdirSync(userDataDir, { recursive: true });
      state.accounts.push({ id, name: trimmed, userDataDir, createdAt: Date.now() });
      state.activeId = id;
      save();
      return snapshot();
    },
    rename(id, name) {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      account.name = String(name || '').trim().slice(0, 40) || account.name;
      save();
      return snapshot();
    },
    remove(id) {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      if (account.id === DEFAULT_ACCOUNT_ID) throw new Error('默认档案不可删除');
      const dir = profileDirOf(account);
      // Only directories this registry created may be deleted.
      if (dir.startsWith(accountRoot + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
      state.accounts = state.accounts.filter(item => item.id !== id);
      if (state.activeId === id) state.activeId = DEFAULT_ACCOUNT_ID;
      emailCache.delete(id);
      save();
      return snapshot();
    }
  };
}

module.exports = { createAccounts, DEFAULT_ACCOUNT_ID, ACCOUNT_ROOT_NAME };
