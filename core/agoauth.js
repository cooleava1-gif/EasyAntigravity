const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// Adding an account through Google's own consent screen, the way cockpit-tools does it:
// open the authorize URL in the browser, Google redirects back to our loopback API with a
// single-use code, and the code is exchanged for tokens that join the pool. The client
// credentials are extracted from language_server.exe at runtime (see core/agcred.js), so
// nothing client-specific lives in this repository.
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALLBACK_PATH = '/oauth-callback';
const FLOW_TTL_MS = 10 * 60 * 1000;
// Exactly the scopes of a live AG access token issued by AG's public OAuth client (verified
// with the tokeninfo endpoint: openid, aicode, cloud-platform, userinfo.email,
// userinfo.profile, cclog, experimentsandconfigs). The aicode scope is registered for that
// client - it only 403s on AG's other client, the one its login screen uses.
// access_type=offline with prompt=consent guarantees a refresh_token.
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode'
];

function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Single-use CSRF tokens: a state is valid for exactly one callback within the TTL.
function createFlowStore({ ttlMs = FLOW_TTL_MS, now = () => Date.now() } = {}) {
  const flows = new Map();
  const sweep = () => {
    for (const [state, expiresAt] of flows) if (expiresAt <= now()) flows.delete(state);
  };
  return {
    begin() {
      sweep();
      const state = randomUUID();
      flows.set(state, now() + ttlMs);
      return state;
    },
    consume(state) {
      sweep();
      if (!flows.has(state)) return false;
      flows.delete(state);
      return true;
    },
    get size() { sweep(); return flows.size; }
  };
}

// The URL contains '&', which cmd /c start treats as a command separator (it truncates the
// query), and explorer.exe does not open it at all - PowerShell Start-Process passes the
// address through untouched.
function openInBrowser(url, platform = process.platform, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    if (platform === 'win32') {
      child = spawnProcess('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true });
    } else if (platform === 'darwin') {
      child = spawnProcess('open', [url]);
    } else {
      child = spawnProcess('xdg-open', [url]);
    }
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolve() : reject(new Error(`打开浏览器失败（退出码 ${code}）`))));
  });
}

module.exports = { buildAuthUrl, createFlowStore, openInBrowser, AUTH_URL, CALLBACK_PATH, FLOW_TTL_MS, SCOPES };
