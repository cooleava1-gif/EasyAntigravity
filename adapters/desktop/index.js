const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { discoverDesktop, desktopRunning } = require('./discovery');

function defaultProfileDir() {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/Antigravity')
    : path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Antigravity');
}

// `profile` is a getter so CDP and the language service always observe the
// data directory of the account selected in the launcher.
function createDesktopAdapter(testMode = false, accounts = null) {
  return {
    kind: 'desktop',
    get profile() { return accounts ? accounts.activeProfileDir() : defaultProfileDir(); },
    accounts,
    capabilities: { cdp: true, metrics: true },
    locate() {
      const target = discoverDesktop();
      return { ...target, exists: fs.existsSync(target.appExe) };
    },
    running: testMode ? async () => false : desktopRunning
  };
}

module.exports = { createDesktopAdapter, defaultProfileDir };
