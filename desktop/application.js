const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSettings, assertLaunchSettingsMutable } = require('../core/settings');
const { createAccounts } = require('../core/accounts');
const { Events } = require('../core/events');
const { Session } = require('../core/session');
const { writeJson } = require('../core/storage');
const { loadDictionary } = require('../features/i18n');
const { Updater } = require('../features/updater');
const { CdpHub } = require('../adapters/desktop/cdp');
const { rendererSource } = require('../adapters/desktop/renderer');
const { createDesktopAdapter, defaultProfileDir } = require('../adapters/desktop');
const { createHost } = require('./host');
const { createApi } = require('./api');
const { LanguageService } = require('../adapters/desktop/language-service');
const { ContextMonitor } = require('../features/context-monitor');

function createApplication({ rootDir, dataDir, native = false, testMode = false, fetchBytes, onClose = () => {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const events = new Events(dataDir);
  const settings = createSettings(path.join(dataDir, 'settings.json'));
  const accounts = createAccounts(dataDir, {
    appData: process.env.APPDATA || path.join(os.homedir(), '.config'),
    defaultProfileDir: defaultProfileDir()
  });
  const desktop = createDesktopAdapter(testMode, accounts);
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
  const app = {
    rootDir, dataDir, events, settings, desktop, host, cdp, session, contextMonitor, updater, accounts,
    status() {
      return {
        ...settings.get(), ...session.snapshot(), ...cdp.status, ...updater.currentState(),
        dictEntries: Object.keys(dictionary).length, capabilities: desktop.capabilities,
        accounts: accounts.snapshot()
      };
    },
    assertAgClosed(action) {
      if (['running', 'preparing', 'launching'].includes(session.phase)) {
        throw Object.assign(new Error(`请先退出 AG 再${action}`), { status: 409 });
      }
    },
    selectAccount(id) {
      this.assertAgClosed('切换账户');
      const snapshot = accounts.select(id);
      contextMonitor.reset();
      const active = snapshot.items.find(item => item.id === snapshot.activeId);
      events.log('SYSTEM', `已切换到账户「${active?.name || id}」，下次启动 AG 时生效`, 'tag-proxy');
      events.publish({ accounts: snapshot });
      return snapshot;
    },
    addAccount(name) {
      this.assertAgClosed('新增账户');
      const snapshot = accounts.add(name);
      const active = snapshot.items.find(item => item.id === snapshot.activeId);
      events.log('SYSTEM', `已新增账户「${active?.name}」并切换，点击启动后在 AG 内完成 Google 登录即可`, 'tag-proxy');
      events.publish({ accounts: snapshot });
      return snapshot;
    },
    removeAccount(id) {
      this.assertAgClosed('删除账户');
      const removed = accounts.snapshot().items.find(item => item.id === id);
      const snapshot = accounts.remove(id);
      events.log('SYSTEM', `已删除账户「${removed?.name || id}」及其数据目录`, 'tag-warn');
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
      events.log('SYSTEM', `EasyAG 桌面内核就绪，已载入 ${Object.keys(dictionary).length} 条汉化词条`, 'tag-proxy');
      if (process.env.EASYAG_READY_FILE) writeJson(process.env.EASYAG_READY_FILE, { port, pid: process.pid });
      if (!native && !testMode) host.open(`http://127.0.0.1:${port}`);
      void session.attachExisting().catch(error => events.log('SYSTEM', error.message, 'tag-warn'));
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
