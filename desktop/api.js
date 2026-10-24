const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('请求内容过大');
  }
  return body ? JSON.parse(body) : {};
}

function serveFile(response, base, relative) {
  const target = path.resolve(base, relative);
  if (!target.startsWith(path.resolve(base) + path.sep)) return json(response, { ok: false, error: '无效路径' }, 403);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(response, { ok: false, error: '文件不存在' }, 404);
  response.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const stream = fs.createReadStream(target);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function createApi(app) {
  const streams = new Map();
  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) {
        return json(response, { ok: false, error: '无效的本地请求' }, 403);
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = url.pathname;
      const method = request.method;
      const origin = request.headers.origin;
      if (method !== 'GET' && origin && origin !== `http://${host}`) {
        return json(response, { ok: false, error: '不允许跨站修改设置' }, 403);
      }
      if (method === 'GET' && route === '/') return serveFile(response, app.rootDir, 'index.html');
      if (method === 'GET' && (route.startsWith('/ui/') || route.startsWith('/assets/'))) {
        const directory = route.startsWith('/ui/') ? 'ui' : 'assets';
        return serveFile(response, path.join(app.rootDir, directory), decodeURIComponent(route.slice(directory.length + 2)));
      }
      if (method === 'GET' && route === '/api/ping') { response.end('pong'); return; }
      if (method === 'GET' && route === '/api/status') return json(response, app.status());
      if (method === 'GET' && route === '/api/logs') {
        const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
        return json(response, app.events.logs(Number.isFinite(limit) ? limit : 100));
      }
      if (method === 'GET' && route === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(': connected\n\n');
        const send = item => {
          if (response.destroyed) return;
          if (!response.write(`data: ${JSON.stringify(item)}\n\n`)) response.destroy();
        };
        app.events.on('message', send);
        streams.set(response, send);
        response.on('close', () => { app.events.off('message', send); streams.delete(response); });
        return;
      }
      if (method === 'POST' && route === '/api/config') {
        const data = await readBody(request);
        await app.configure(data);
        return json(response, { ok: true, settings: app.settings.get() });
      }
      if (method === 'POST' && route === '/api/launch') {
        const result = await app.session.launch();
        return json(response, result, result.ok ? 200 : 409);
      }
      if (method === 'GET' && route === '/api/accounts') {
        return json(response, { ok: true, accounts: await app.accountsSnapshot() });
      }
      if (method === 'POST' && route === '/api/accounts/select') {
        const data = await readBody(request);
        return json(response, { ok: true, accounts: app.selectAccount(data.id) });
      }
      if (method === 'POST' && route === '/api/accounts/switch') {
        const data = await readBody(request);
        const result = await app.switchAccount(data.id);
        return json(response, { ok: true, ...result });
      }
      if (method === 'POST' && route === '/api/accounts/capture') {
        const result = await app.captureCurrentAccount();
        return json(response, { ok: true, accounts: result });
      }
      if (method === 'POST' && route === '/api/accounts/add') {
        const data = await readBody(request);
        return json(response, { ok: true, accounts: app.addAccount(data) });
      }
      if (method === 'POST' && route === '/api/accounts/oauth/start') {
        const result = await app.startOAuth();
        return json(response, { ok: true, ...result });
      }
      if (method === 'GET' && route === '/oauth-callback') {
        // Google redirects the browser here after consent; the page is user-facing, so
        // report the outcome in Chinese and keep the tokens server-side.
        const page = (title, detail) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>` +
          `<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e6e6;` +
          `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}` +
          `.box{background:#1a1d24;border:1px solid #2a2e37;border-radius:12px;padding:32px 40px;max-width:420px;text-align:center}` +
          `h1{font-size:18px;margin:0 0 12px}p{font-size:13px;color:#9aa0aa;margin:0;line-height:1.7}</style></head>` +
          `<body><div class="box"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        const denied = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (denied) return response.end(page('授权未完成', `Google 返回：${denied}。请回到 EasyAG 重新点击「授权添加」。`));
        if (!code || !state) return response.end(page('回调参数缺失', '链接中缺少 code 或 state，请重新发起授权。'));
        try {
          const result = await app.completeOAuth({ code, state });
          const email = result.account?.email;
          return response.end(page('授权成功', `账户${email ? ` ${email} ` : ' '}已加入 EasyAG 账户池，可以关闭本页；回到 EasyAG 选中该账户点击「切换」即可使用。`));
        } catch (error) {
          return response.end(page('授权失败', `${error.message}。请回到 EasyAG 重新点击「授权添加」。`));
        }
      }
      if (method === 'POST' && route === '/api/accounts/remove') {
        const data = await readBody(request);
        return json(response, { ok: true, accounts: app.removeAccount(data.id) });
      }
      if (method === 'POST' && route === '/api/update') {
        const data = await readBody(request);
        const result = await app.updater.checkAndApply({ manifestUrl: data.manifestUrl });
        return json(response, result);
      }
      if (method === 'POST' && route === '/api/theme') {
        const data = await readBody(request);
        if (data.theme === 'light' || data.theme === 'dark') app.host.setTheme?.(data.theme);
        return json(response, { ok: true });
      }
      if (method === 'POST' && route === '/api/hide') { app.host.hide(); return json(response, { ok: true }); }
      if (method === 'POST' && route === '/api/quit') {
        json(response, { ok: true });
        void app.close('收到退出请求');
        return;
      }
      return json(response, { ok: false, error: 'not found', url: request.url }, 404);
    } catch (error) {
      app.events.log('SYSTEM', error.message, 'tag-warn');
      if (!response.headersSent) json(response, { ok: false, error: error.message }, error.status || 400);
      else response.end();
    }
  });
  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
      });
    },
    close() {
      for (const [response, send] of streams) {
        app.events.off('message', send);
        response.end();
      }
      streams.clear();
      server.close();
      server.closeIdleConnections();
    }
  };
}

module.exports = { createApi, readBody };
