const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createSettings, assertLaunchSettingsMutable } = require('../core/settings');
const { createAccounts } = require('../core/accounts');
const { createAgCred } = require('../core/agcred');
const { createFlowStore, buildAuthUrl, openInBrowser, CALLBACK_PATH } = require('../core/agoauth');
const { Events } = require('../core/events');
const { Session } = require('../core/session');
const { writeJson } = require('../core/storage');
const { loadDictionary } = require('../features/i18n');
const { Updater } = require('../features/updater');
const { CdpHub } = require('../adapters/desktop/cdp');
const { rendererSource } = require('../adapters/desktop/renderer');
const { createDesktopAdapter } = require('../adapters/desktop');
const { createHost } = require('./host');
const { createApi } = require('./api');
const { LanguageService } = require('../adapters/desktop/language-service');
const { ContextMonitor } = require('../features/context-monitor');

function createApplication({ rootDir, dataDir, native = false, testMode = false, fetchBytes, agCred, openUrl = openInBrowser, onClose = () => {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const events = new Events(dataDir);
  const settings = createSettings(path.join(dataDir, 'settings.json'));
  const accounts = createAccounts(dataDir);
  const agcred = agCred || createAgCred({ scriptPath: path.join(rootDir, 'tools', 'agcred.ps1') });
  const desktop = createDesktopAdapter(testMode);
  let dictionary = loadDictionary(rootDir, dataDir);
  const host = createHost({ native, testMode, events });
  const contextMonitor = new ContextMonitor(new LanguageService({ profile: () => desktop.profile }));
  let session;
  let lastStatus = '';
  const cdp = new CdpHub({
    profile: () => desktop.profile,
    source: binding => rendererSource(dictionary, settings.get(), binding),
    onMetrics: id => settings.get().enableContextMonitor && session?.phase === 'running' && !testMode
      ? contextMonitor.sample(id) : Promise.resolve({ conversationId: id, state: 'unavailable', context: null, speed: null }),
    onStop: () => contextMonitor.reset(),
    onStatus: status => {
      const key = JSON.stringify([status.cdpSockets, status.cdpTargets, status.cdpError]);
      if (key === lastStatus) return;
      lastStatus = key;
      events.publish({ status: status.cdpSockets ? '增强功能已连接' : '等待连接', ...session.snapshot(), ...status });
    }
  });
  session = new Session({ settings, desktop, cdp, events, host, testMode, onStart: () => contextMonitor.reset() });
  const updater = new Updater({
    rootDir, dataDir, settings, events,
    ...(fetchBytes ? { fetchBytes } : {}),
    onDictionaryUpdated: async () => {
      dictionary = loadDictionary(app.rootDir, dataDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count, ...updater.currentState() });
      return count;
    },
    onRuntimeUpdated: async nextRoot => {
      app.rootDir = nextRoot;
    }
  });
  let closing;
  // The credential AG actually reads lives outside our registry, so cache a short-lived
  // view of it to mark which pooled account is live in AG right now.
  const live = { at: 0, refreshToken: null };
  const LIVE_TTL_MS = 3000;
  const refreshLive = async (force = false) => {
    if (!force && Date.now() - live.at < LIVE_TTL_MS) return live.refreshToken;
    live.at = Date.now();
    try {
      const credential = await agcred.readSystemCredential();
      live.refreshToken = credential?.refreshToken || null;
    } catch { live.refreshToken = null; }
    return live.refreshToken;
  };
  const accountsSnapshot = async () => accounts.snapshot(await refreshLive());
  // Pending Google authorization flows (see core/agoauth.js): each start creates a
  // single-use state that the /oauth-callback route redeems.
  const oauthFlows = createFlowStore();
  const oauthRedirectUri = () => `http://127.0.0.1:${app.apiPort}${CALLBACK_PATH}`;
  const closeAgProcesses = async () => {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/F', '/IM', 'Antigravity.exe'], { windowsHide: true });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!await desktop.running()) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  };
  const app = {
    rootDir, dataDir, events, settings, desktop, host, cdp, session, contextMonitor, updater, accounts, agcred,
    accountsSnapshot,
    status() {
      return {
        ...settings.get(), ...session.snapshot(), ...cdp.status, ...updater.currentState(),
        dictEntries: Object.keys(dictionary).length, capabilities: desktop.capabilities,
        accounts: accounts.snapshot(live.refreshToken)
      };
    },
    assertAgClosed(action) {
      if (['running', 'preparing', 'launching'].includes(session.phase)) {
        throw Object.assign(new Error(`请先退出 AG 再${action}`), { status: 409 });
      }
    },
    selectAccount(id) {
      const snapshot = accounts.select(id);
      events.publish({ accounts: snapshot });
      return snapshot;
    },
    // One-click switch, the way Orbit and cockpit-tools do it: refresh the token, rewrite
    // the system credential AG reads, then restart AG so it logs in as that account.
    async switchAccount(id) {
      if (['preparing', 'launching'].includes(session.phase)) {
        throw Object.assign(new Error('正在启动 AG，请稍候再切换'), { status: 409 });
      }
      const account = accounts.find(id);
      if (!account) throw new Error('账户不存在');
      const proxyPort = settings.get().port;
      let fresh;
      try {
        fresh = await agcred.ensureFresh(account, proxyPort);
      } catch (error) {
        // Tokens captured from AG's own login belong to the IDE's built-in OAuth client and
        // cannot be refreshed with the public client credentials. They are still valid for AG,
        // which renews them itself, so fall back to the stored tokens instead of failing.
        events.log('SYSTEM', `令牌预刷新失败（${error.message}），将使用已保存的令牌，AG 会自行续期`, 'tag-warn');
        fresh = { accessToken: account.accessToken, refreshToken: account.refreshToken, expiryTs: account.expiryTs };
      }
      accounts.updateTokens(id, fresh);
      accounts.select(id);
      await agcred.writeSystemCredential(fresh);
      await refreshLive(true);
      let restarted = false;
      const agWasRunning = session.phase === 'running' || await desktop.running();
      if (agWasRunning) {
        await closeAgProcesses();
        if (session.phase === 'running') await session.finish('AG 已退出，正在切换到新账户');
        const result = await session.launch();
        restarted = result.ok;
        if (!result.ok) throw new Error(`账户已切换，但 AG 重启失败：${result.error}`);
      }
      events.log('SYSTEM', `已切换到账户「${account.name}」${account.email ? `（${account.email}）` : ''}，${restarted ? 'AG 已以新账户重启' : '下次启动 AG 时生效'}`, 'tag-proxy');
      events.publish({ accounts: accounts.snapshot(live.refreshToken) });
      return { accounts: accounts.snapshot(live.refreshToken), restarted };
    },
    // Save the account AG is currently logged into as a pool entry.
    async captureCurrentAccount() {
      const credential = await agcred.readSystemCredential();
      if (!credential) throw new Error('未检测到 AG 的登录凭据，请先在 AG 内登录');
      let email = null;
      try {
        const fresh = await agcred.ensureFresh(credential, settings.get().port);
        credential.accessToken = fresh.accessToken;
        credential.refreshToken = fresh.refreshToken;
        credential.expiryTs = fresh.expiryTs;
        email = await agcred.userinfoEmail(fresh.accessToken, settings.get().port);
      } catch { /* offline: keep the stored tokens as-is */ }
      const account = accounts.upsert({
        email, name: email || '当前 AG 登录',
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiryTs: credential.expiryTs,
        source: 'current', select: true
      });
      await refreshLive(true);
      events.log('SYSTEM', `已保存当前登录账户「${account.name}」`, 'tag-proxy');
      events.publish({ accounts: accounts.snapshot(live.refreshToken) });
      return accounts.snapshot(live.refreshToken);
    },
    // Import accounts from Antigravity-Orbit's account pool file.
    importOrbitAccounts() {
      const file = path.join(os.homedir(), '.gemini', 'antigravity', 'orbit_accounts.json');
      let pool;
      try {
        pool = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new Error(`未找到 Orbit 账户文件：${file}`);
      }
      const entries = Array.isArray(pool?.accounts) ? pool.accounts : [];
      let added = 0;
      for (const entry of entries) {
        const token = entry?.token || {};
        if (!token.refresh_token) continue;
        const before = accounts.snapshot().items.length;
        accounts.upsert({
          name: entry.name || entry.email,
          email: entry.email,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiryTs: token.expiry ? Date.parse(token.expiry) || 0 : 0,
          source: 'orbit'
        });
        if (accounts.snapshot().items.length > before) added += 1;
      }
      events.log('SYSTEM', added ? `已从 Orbit 导入 ${added} 个账户` : 'Orbit 中没有新账户可导入', 'tag-proxy');
      events.publish({ accounts: accounts.snapshot(live.refreshToken) });
      return { added, accounts: accounts.snapshot(live.refreshToken) };
    },
    addAccount({ email, refreshToken }) {
      if (!refreshToken) throw new Error('请填写 refresh_token');
      const account = accounts.upsert({ email, refreshToken, source: 'manual', select: true });
      events.log('SYSTEM', `已添加账户「${account.name}」`, 'tag-proxy');
      events.publish({ accounts: accounts.snapshot(live.refreshToken) });
      return accounts.snapshot(live.refreshToken);
    },
    // Add an account through Google's consent screen: open the authorize URL, wait for the
    // redirect to our own loopback API, then exchange the code for pool tokens.
    async startOAuth() {
      const clients = await agcred.oauthClients();
      if (!clients.length) throw new Error('未找到可用的 OAuth 客户端（无法读取 language_server.exe），请先安装 Antigravity');
      const state = oauthFlows.begin();
      const authUrl = buildAuthUrl({ clientId: clients[0].id, redirectUri: oauthRedirectUri(), state });
      await openUrl(authUrl);
      events.log('SYSTEM', '已生成 Google 授权链接并打开浏览器，请在页面中完成授权', 'tag-proxy');
      return { authUrl };
    },
    async completeOAuth({ code, state }) {
      if (!oauthFlows.consume(state)) throw new Error('授权会话无效或已过期，请重新点击「授权添加」');
      const proxyPort = settings.get().port;
      const token = await agcred.exchangeAuthCode({ code, redirectUri: oauthRedirectUri(), proxyPort });
      if (!token.refreshToken) throw new Error('Google 未返回 refresh_token，无法加入账户池');
      let email = null;
      try {
        email = await agcred.userinfoEmail(token.accessToken, proxyPort);
      } catch { /* the token is still usable even if the profile lookup fails */ }
      const account = accounts.upsert({
        email, name: email || 'Google 授权账户',
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiryTs: Date.now() + token.expiresIn * 1000,
        source: 'google'
      });
      await refreshLive(true);
      const snapshot = accounts.snapshot(live.refreshToken);
      events.log('SYSTEM', `已通过 Google 授权添加账户「${account.email || account.name}」`, 'tag-proxy');
      events.publish({ accounts: snapshot });
      return { account: snapshot.items.find(item => item.id === account.id) || null, accounts: snapshot };
    },
    removeAccount(id) {
      const removed = accounts.snapshot().items.find(item => item.id === id);
      const snapshot = accounts.remove(id);
      events.log('SYSTEM', `已删除账户「${removed?.name || id}」`, 'tag-warn');
      events.publish({ accounts: snapshot });
      return snapshot;
    },
    async reloadDictionary() {
      dictionary = loadDictionary(rootDir, dataDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count });
      return { ok: true, dictEntries: count };
    },
    async configure(input) {
      const previous = settings.get();
      assertLaunchSettingsMutable(input, previous, session.phase);
      const next = settings.update(input);
      if (next.enableContextMonitor !== previous.enableContextMonitor) contextMonitor.reset();
      await cdp.refresh();
      if (next.enableI18n !== previous.enableI18n) events.log('I18N', next.enableI18n ? '汉化已开启' : '汉化已关闭，原文已恢复', 'tag-i18n');
      if (next.enableContextMonitor !== previous.enableContextMonitor) events.log('SYSTEM', next.enableContextMonitor ? '上下文监控已开启（只读）' : '上下文监控已关闭，上下文圆环已移除', 'tag-proxy');
      return next;
    },
    async start() {
      const port = await api.listen(native ? 0 : 19823);
      app.apiPort = port;
      events.log('SYSTEM', `EasyAG 桌面内核就绪，已载入 ${Object.keys(dictionary).length} 条汉化词条`, 'tag-proxy');
      if (process.env.EASYAG_READY_FILE) writeJson(process.env.EASYAG_READY_FILE, { port, pid: process.pid });
      if (!native && !testMode) host.open(`http://127.0.0.1:${port}`);
      void session.attachExisting().catch(error => events.log('SYSTEM', error.message, 'tag-warn'));
      void refreshLive(true).catch(() => {});
      // Pick up manual logins/logouts done inside AG itself.
      const liveTimer = setInterval(() => { void refreshLive().catch(() => {}); }, 10000);
      liveTimer.unref();
      return port;
    },
    close(reason) {
      if (closing) return closing;
      closing = (async () => {
        events.log('SYSTEM', '正在退出: ' + reason, 'tag-warn');
        const result = await session.close(reason);
        host.dispose();
        api.close();
        onClose(result);
        return result;
      })();
      return closing;
    }
  };
  const api = createApi(app);
  app.api = api;
  return app;
}

module.exports = { createApplication };
