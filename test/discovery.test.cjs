const test = require('node:test');
const assert = require('node:assert/strict');
const { isSidecarCommandLine, hasIdeProcess } = require('../adapters/desktop/discovery');

const SIDECAR = '"C:\\Users\\u\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --import=file:///C:/Users/u/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js dist/server.cjs';
const IDE = '"C:\\Users\\u\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe"';
const IDE_WITH_PROFILE = `${IDE} --user-data-dir=C:\\Users\\u\\AppData\\Roaming\\EasyAG-Accounts\\acct-1`;

test('sidecar 命令行被识别', () => {
  assert.equal(isSidecarCommandLine(SIDECAR), true);
});

test('IDE 命令行（含档案参数）不被误判为 sidecar', () => {
  assert.equal(isSidecarCommandLine(IDE), false);
  assert.equal(isSidecarCommandLine(IDE_WITH_PROFILE), false);
  assert.equal(isSidecarCommandLine(''), false);
  assert.equal(isSidecarCommandLine(undefined), false);
});

test('只有 sidecar 驻留时判定 AG 未运行', () => {
  assert.equal(hasIdeProcess([]), false);
  assert.equal(hasIdeProcess([SIDECAR]), false);
  assert.equal(hasIdeProcess([SIDECAR, SIDECAR]), false);
});

test('列表中存在 IDE 进程即判定运行', () => {
  assert.equal(hasIdeProcess([SIDECAR, IDE]), true);
  assert.equal(hasIdeProcess([IDE_WITH_PROFILE]), true);
});
