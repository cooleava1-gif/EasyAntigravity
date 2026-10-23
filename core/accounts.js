const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('./storage');

// Token-pool registry. Antigravity keeps its IDE login in a system credential, so an
// "account" here is just a set of OAuth tokens: switching means rewriting the credential
// (see core/agcred.js) and restarting AG. No per-account data directories are needed.
const STATE_VERSION = 2;

function createAccounts(dataDir) {
  const file = path.join(dataDir, 'accounts.json');
  let state = readJson(file, null);
  if (!state || state.version !== STATE_VERSION || !Array.isArray(state.accounts)) {
    // v1 stored isolated profile directories; that model cannot switch logins because the
    // credential is system-wide, so start a fresh pool instead of migrating.
    state = { version: STATE_VERSION, accounts: [], activeId: null };
    writeJson(file, state);
  }
  const save = () => writeJson(file, state);
  const find = id => state.accounts.find(account => account.id === id) || null;
  const publicView = (account, liveRefreshToken) => ({
    id: account.id,
    name: account.name,
    email: account.email || null,
    source: account.source,
    expiryTs: account.expiryTs || null,
    isLive: Boolean(liveRefreshToken) && account.refreshToken === liveRefreshToken
  });

  const snapshot = (liveRefreshToken = null) => ({
    activeId: state.activeId,
    liveId: state.accounts.find(account => account.refreshToken === liveRefreshToken)?.id || null,
    items: state.accounts.map(account => publicView(account, liveRefreshToken))
  });

  const upsert = ({ name, email, accessToken, refreshToken, expiryTs, source, select = false }) => {
    if (!refreshToken) throw new Error('缺少 refresh_token');
    let account = state.accounts.find(item => item.refreshToken === refreshToken);
    if (account) {
      account.accessToken = accessToken || account.accessToken;
      account.expiryTs = expiryTs || account.expiryTs;
      if (email && !account.email) account.email = email;
    } else {
      account = {
        id: randomUUID(),
        name: String(name || email || `账户 ${state.accounts.length + 1}`).slice(0, 40),
        email: email || null,
        accessToken: accessToken || '',
        refreshToken,
        expiryTs: expiryTs || 0,
        source: source || 'manual',
        createdAt: Date.now()
      };
      state.accounts.push(account);
    }
    if (select || !state.activeId) state.activeId = account.id;
    save();
    return account;
  };

  return {
    snapshot,
    active: () => find(state.activeId),
    find,
    select(id) {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      state.activeId = account.id;
      save();
      return snapshot();
    },
    upsert,
    updateTokens(id, { accessToken, refreshToken, expiryTs }) {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      if (accessToken) account.accessToken = accessToken;
      if (refreshToken) account.refreshToken = refreshToken;
      if (expiryTs) account.expiryTs = expiryTs;
      save();
      return account;
    },
    remove(id) {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      state.accounts = state.accounts.filter(item => item.id !== id);
      if (state.activeId === id) state.activeId = state.accounts[0]?.id || null;
      save();
      return snapshot();
    }
  };
}

module.exports = { createAccounts };
