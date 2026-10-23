const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { discoverDesktop, desktopRunning } = require('./discovery');

function defaultProfileDir() {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/Antigravity')
    : path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Antigravity');
}

// Antigravity keeps a single login in the system credential, so every account shares the
// same profile directory; account switching rewrites the credential instead (core/agcred.js).
function createDesktopAdapter(testMode = false) {
  return {
    kind: 'desktop',
    profile: defaultProfileDir(),
    capabilities: { cdp: true, metrics: true },
    locate() {
      const target = discoverDesktop();
      return { ...target, exists: fs.existsSync(target.appExe) };
    },
    running: testMode ? async () => false : desktopRunning
  };
}

module.exports = { createDesktopAdapter, defaultProfileDir };
