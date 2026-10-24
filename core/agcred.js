const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// Antigravity >= 2.0 keeps its IDE login in a generic OS credential (Windows Credential
// Manager target "gemini:antigravity", macOS Keychain service "gemini", Linux secret-tool).
// Switching accounts therefore means rewriting that credential and restarting AG, which is
// how cockpit-tools and similar managers implement one-click switching. The payload is
// plain JSON - no encryption involved.
const CRED_TARGET = 'gemini:antigravity';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const REFRESH_MARGIN_SECONDS = 300;
const SCAN_CHUNK = 4 * 1024 * 1024;
const SCAN_CARRY = 1024;

function languageServerCandidates() {
  const roots = [];
  if (process.env.EASYAG_AG_EXE) roots.push(path.dirname(process.env.EASYAG_AG_EXE));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs/antigravity'));
  return roots.map(root => path.join(root, 'resources/bin/language_server.exe'));
}

// The OAuth client AG's AuthProvider refreshes tokens with - the same public client that
// Orbit-style managers authorize with. Verified end to end: a token issued to AG's other
// client (the one its login screen uses) is rejected with unauthorized_client, and once
// that token's access token expires about an hour later AG falls back to its login page,
// which is what made freshly added accounts look like they had no account at all.
// Authorizing with this client keeps every token EasyAG mints refreshable by AG itself.
// The id is public by design - it travels in every authorize URL - so it can live here,
// while the client secret is still only ever read out of language_server.exe. If AG rotates
// the client away, the extracted clients are used in binary order as a fallback.
const AG_REFRESH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

// Ids and secrets are separate strings in the binary, so every pairing is tried: a wrong
// pair fails fast with unauthorized_client or invalid_client. The client AG refreshes with
// leads the list so that startOAuth builds its authorize URL with it.
function extractOauthClients(text) {
  const ids = [...new Set([...text.matchAll(/(\d{10,}-[a-z0-9]{32}\.apps\.googleusercontent\.com)/g)].map(match => match[1]))];
  const secrets = [...new Set([...text.matchAll(/GOCSPX-[A-Za-z0-9_-]{28}/g)].map(match => match[0]))];
  const clients = [];
  for (const id of ids) {
    for (const secret of secrets) clients.push({ id, secret });
  }
  const preferred = clients.filter(client => client.id === AG_REFRESH_CLIENT_ID);
  const rest = clients.filter(client => client.id !== AG_REFRESH_CLIENT_ID);
  return [...preferred, ...rest].slice(0, 4);
}

async function scanBinaryForClients() {
  for (const exe of languageServerCandidates()) {
    let found = [];
    try {
      const stream = fs.createReadStream(exe, { highWaterMark: SCAN_CHUNK });
      let carry = '';
      for await (const chunk of stream) {
        const text = carry + chunk.toString('latin1');
        found = extractOauthClients(text);
        if (found.length) break;
        carry = text.slice(-SCAN_CARRY);
      }
    } catch { /* try the next candidate */ }
    if (found.length) return found;
  }
  return [];
}

async function loadOauthClients() {
  return scanBinaryForClients();
}

function toRfc3339Micros(timestampMs) {
  const date = new Date(timestampMs);
  const pad = (value, size) => String(value).padStart(size, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` +
    `.${pad(date.getUTCMilliseconds(), 3)}000Z`;
}

function parseRfc3339(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function buildCredentialPayload({ accessToken, refreshToken, expiryTs }) {
  return JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: toRfc3339Micros(expiryTs || Date.now() + 3600 * 1000)
    },
    auth_method: 'consumer'
  });
}

function parseCredentialPayload(json) {
  const payload = JSON.parse(String(json || ''));
  const token = payload?.token || {};
  if (!token.refresh_token) throw new Error('AG 系统凭据缺少 refresh_token');
  return {
    accessToken: token.access_token || '',
    refreshToken: token.refresh_token,
    expiryTs: parseRfc3339(token.expiry)
  };
}

function parseTokenResponse(json) {
  const data = JSON.parse(String(json || ''));
  if (!data.access_token) throw new Error('令牌刷新响应缺少 access_token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number(data.expires_in) || 3600
  };
}

function describeTokenError(stdout) {
  try {
    const data = JSON.parse(String(stdout || ''));
    if (data.error) return `${data.error}${data.error_description ? `: ${data.error_description}` : ''}`;
  } catch { /* not a JSON error body */ }
  return null;
}

function createAgCred({ scriptPath, spawnProcess = spawn, execFileAsync = run, platform = process.platform, oauthClientLoader = loadOauthClients }) {
  const powershell = () => (platform === 'win32' ? 'powershell.exe' : 'pwsh');
  // A refresh token only works with the client it was issued to, so try every known client
  // (loaded once per process) until one accepts it.
  const oauthClients = async () => {
    try {
      return await oauthClientLoader();
    } catch { return []; }
  };

  async function runScript(mode, stdinB64 = '') {
    return new Promise((resolve, reject) => {
      const child = spawnProcess(powershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', mode], {
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error((stderr || `agcred.ps1 exited with ${code}`).trim()));
      });
      if (child.stdin) {
        child.stdin.end(stdinB64);
      } else if (mode === 'write') {
        reject(new Error('无法向 agcred.ps1 写入输入'));
      }
    });
  }

  async function readSystemCredential() {
    if (platform !== 'win32') return null; // macOS/Linux read paths are not implemented yet
    const encoded = await runScript('read');
    if (!encoded) return null;
    return parseCredentialPayload(Buffer.from(encoded, 'base64').toString('utf8'));
  }

  async function writeSystemCredential({ accessToken, refreshToken, expiryTs }) {
    if (platform !== 'win32') throw new Error('当前平台不支持写入 AG 系统凭据');
    const payload = buildCredentialPayload({ accessToken, refreshToken, expiryTs });
    await runScript('write', Buffer.from(payload, 'utf8').toString('base64'));
  }

  async function http(request) {
    const { url, method = 'GET', form, headers = {}, proxyPort } = request;
    const args = ['-s', '--max-time', '25', '-X', method];
    if (proxyPort) args.push('--proxy', `http://127.0.0.1:${proxyPort}`);
    for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
    if (form) {
      for (const [key, value] of Object.entries(form)) args.push('--data-urlencode', `${key}=${value}`);
    }
    args.push(url);
    try {
      const { stdout } = await execFileAsync('curl.exe', args, { windowsHide: true, timeout: 30000 });
      return stdout;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // No curl.exe: fall back to a direct request (may fail without a proxy).
        const response = await fetch(url, {
          method,
          headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } : headers,
          body: form ? new URLSearchParams(form).toString() : undefined
        });
        return response.text();
      }
      throw error;
    }
  }

  async function refreshAccessToken(refreshToken, proxyPort) {
    const problems = [];
    const clients = await oauthClients();
    if (!clients.length) throw new Error('未找到可用的 OAuth 客户端（无法读取 language_server.exe）');
    for (const client of clients) {
      const stdout = await http({
        url: TOKEN_URL,
        method: 'POST',
        proxyPort,
        form: {
          client_id: client.id,
          client_secret: client.secret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }
      });
      try {
        return parseTokenResponse(stdout);
      } catch (error) {
        problems.push(error.message);
        const detail = describeTokenError(stdout);
        if (detail) problems.push(detail);
      }
    }
    throw new Error(`令牌刷新失败（${problems.join('; ')}）`);
  }

  // The authorization code is bound to the client that issued the auth URL, so try the
  // extracted clients in order - the right one accepts it, the others fail fast.
  async function exchangeAuthCode({ code, redirectUri, proxyPort }) {
    const clients = await oauthClients();
    if (!clients.length) throw new Error('未找到可用的 OAuth 客户端（无法读取 language_server.exe）');
    const problems = [];
    for (const client of clients) {
      const stdout = await http({
        url: TOKEN_URL,
        method: 'POST',
        proxyPort,
        form: {
          client_id: client.id,
          client_secret: client.secret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        }
      });
      try {
        return parseTokenResponse(stdout);
      } catch (error) {
        problems.push(error.message);
        const detail = describeTokenError(stdout);
        if (detail) problems.push(detail);
      }
    }
    throw new Error(`授权码兑换令牌失败（${problems.join('; ')}）`);
  }

  async function userinfoEmail(accessToken, proxyPort) {
    const stdout = await http({
      url: USERINFO_URL,
      proxyPort,
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = JSON.parse(stdout);
    return data.email || null;
  }

  async function ensureFresh(account, proxyPort) {
    const expiryTs = Number(account.expiryTs) || 0;
    if (expiryTs > Date.now() + REFRESH_MARGIN_SECONDS * 1000) {
      return { accessToken: account.accessToken, refreshToken: account.refreshToken, expiryTs };
    }
    const fresh = await refreshAccessToken(account.refreshToken, proxyPort);
    return {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken || account.refreshToken,
      expiryTs: Date.now() + fresh.expiresIn * 1000
    };
  }

  return {
    CRED_TARGET,
    readSystemCredential,
    writeSystemCredential,
    refreshAccessToken,
    exchangeAuthCode,
    oauthClients,
    userinfoEmail,
    ensureFresh
  };
}

module.exports = {
  createAgCred,
  buildCredentialPayload,
  parseCredentialPayload,
  parseTokenResponse,
  toRfc3339Micros,
  parseRfc3339,
  extractOauthClients,
  AG_REFRESH_CLIENT_ID,
  CRED_TARGET
};
