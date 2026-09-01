#!/usr/bin/env node
/**
 * Unit test for spawn_zcode_session.js (ZCode headless CLI session provider)
 * 全部基于 fixture/env 注入，不依赖真实 ZCode 安装与登录态。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const provider = require('../scripts/providers/spawn_zcode_session');

function makeFakeCliRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `test_zcli_${t}_`));
  fs.mkdirSync(path.join(root, 'resources', 'glm'), { recursive: true });
  const exeName = process.platform === 'win32' ? 'ZCode.exe' : 'zcode';
  fs.writeFileSync(path.join(root, exeName), '#!/bin/sh\nexit 0\n', 'utf8');
  fs.writeFileSync(path.join(root, 'resources', 'glm', 'zcode.cjs'), '// stub\n', 'utf8');
  return root;
}

function withCreds(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_zcred_'));
  const p = path.join(dir, 'credentials.json');
  fs.writeFileSync(p, content, 'utf8');
  try {
    return fn(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDiscovery() {
  const root = makeFakeCliRoot('disc');
  const env = { ZCODE_CLI_BIN: path.join(root, process.platform === 'win32' ? 'ZCode.exe' : 'zcode') };
  const cli = provider.discoverZcodeCli(env);
  assert.ok(cli, 'cli must be discovered via env override');
  assert.strictEqual(cli.cjs, path.join(root, 'resources', 'glm', 'zcode.cjs'));
  assert.ok(provider.discoverZcodeCli({}) === null || typeof provider.discoverZcodeCli({}) === 'object');

  // 显式 bin 但无 cjs 且未提供 ZCODE_CJS_PATH -> null
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test_zcli_empty_'));
  const bad = provider.discoverZcodeCli({ ZCODE_CLI_BIN: path.join(emptyRoot, 'ZCode.exe') });
  if (process.platform === 'win32') {
    assert.strictEqual(bad, null, 'explicit bin without cjs must fail');
  }
  console.log('Discovery tests PASSED!');
}

function testAuthState() {
  const isolated = { ZCODE_CLI_CONFIG: path.join(os.tmpdir(), `no_cfg_${Date.now()}.json`) };
  withCreds('{"accessToken":"x"}', p => {
    const a = provider.authState(Object.assign({ ZCODE_CREDENTIALS_PATH: p }, isolated));
    assert.strictEqual(a.logged_in, true);
  });
  withCreds('{}', p => {
    const a = provider.authState(Object.assign({ ZCODE_CREDENTIALS_PATH: p }, isolated));
    assert.strictEqual(a.logged_in, false);
    assert.ok(/empty/.test(a.reason));
  });
  const missing = path.join(os.tmpdir(), `no_such_creds_${Date.now()}.json`);
  const a2 = provider.authState(Object.assign({ ZCODE_CREDENTIALS_PATH: missing }, isolated));
  assert.strictEqual(a2.logged_in, false);
  assert.ok(/missing/.test(a2.reason));
  console.log('AuthState tests PASSED!');
}

function testBuildArgs() {
  assert.deepStrictEqual(
    provider.buildArgs('spawn', { cwd: 'D:/x', prompt: 'hi' }),
    ['--cwd', 'D:/x', '-p', 'hi']
  );
  assert.deepStrictEqual(
    provider.buildArgs('send', { session: 'sess_11111111-2222-3333-4444-555555555555', prompt: 'hi' }),
    ['--resume', 'sess_11111111-2222-3333-4444-555555555555', '-p', 'hi']
  );
  assert.throws(() => provider.buildArgs('nope', {}));
  console.log('BuildArgs tests PASSED!');
}

function testProcessCommandGates() {
  // 非法 session
  let r = provider.processCommand(['send', '--session', 'garbage', '--prompt', 'x'], {});
  assert.strictEqual(r.code, 1);
  // spawn 缺 prompt
  r = provider.processCommand(['spawn', '--cwd', '.'], {});
  assert.strictEqual(r.code, 1);
  // 未知动作
  r = provider.processCommand(['frobnicate'], {});
  assert.strictEqual(r.code, 1);
  console.log('Gate tests PASSED!');
}

function testDryRunAndExtract() {
  const root = makeFakeCliRoot('dry');
  const env = {
    ZCODE_CLI_BIN: path.join(root, process.platform === 'win32' ? 'ZCode.exe' : 'zcode'),
    ZCODE_CREDENTIALS_PATH: path.join(os.tmpdir(), `no_such_${Date.now()}.json`),
    ZCODE_CLI_CONFIG: path.join(os.tmpdir(), `no_cfg_${Date.now()}.json`)
  };
  // dry-run 不受登录门禁限制（只预览命令）
  const r = provider.processCommand(['spawn', '--cwd', 'D:/proj', '--prompt', '任务A', '--dry-run'], env);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.payload.dry_run, true);
  assert.ok(r.payload.command.includes('--cwd'));
  assert.ok(r.payload.command.includes('D:/proj'));

  // 未登录真实执行 -> exit 2 + 指引
  const r2 = provider.processCommand(['spawn', '--cwd', 'D:/proj', '--prompt', '任务A'], env);
  assert.strictEqual(r2.code, 2);
  assert.ok(/zcode login/.test(r2.payload.error));

  // sess_id 提取
  assert.strictEqual(
    provider.extractSessionId('blah sess_11111111-2222-3333-4444-555555555555 end'),
    'sess_11111111-2222-3333-4444-555555555555'
  );
  assert.strictEqual(provider.extractSessionId('no id here'), null);
  console.log('DryRun & Extract tests PASSED!');
}

function testCapabilityReportShape() {
  const root = makeFakeCliRoot('cap');
  const env = {
    ZCODE_CLI_BIN: path.join(root, process.platform === 'win32' ? 'ZCode.exe' : 'zcode'),
    ZCODE_CREDENTIALS_PATH: path.join(os.tmpdir(), `no_such_${Date.now()}.json`),
    ZCODE_CLI_CONFIG: path.join(os.tmpdir(), `no_cfg_${Date.now()}.json`)
  };
  const report = provider.capabilityReport(env);
  assert.strictEqual(report.cli.found, true);
  assert.strictEqual(report.auth.logged_in, false);
  assert.strictEqual(report.spawn_send_ready, false);
  assert.ok(Array.isArray(report.in_process_alternatives) && report.in_process_alternatives.length >= 3);
  console.log('CapabilityReport tests PASSED!');
}

function testApiKeyMode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_zkey_'));
  const cfgPath = path.join(dir, 'config.json');
  try {
    // 1. 空配置 -> 未登录
    let a = provider.authState({ ZCODE_CLI_CONFIG: cfgPath });
    assert.strictEqual(a.logged_in, false);

    // 2. login-api-key 写入 -> 登录态 true (api-key method)
    const r = provider.loginApiKey({
      key: 'test-key-123', providerId: 'bigmodel', env: { ZCODE_CLI_CONFIG: cfgPath }
    });
    assert.strictEqual(r.ok, true, 'loginApiKey must succeed: ' + JSON.stringify(r));
    assert.strictEqual(r.model_ref, 'bigmodel/GLM-5.3-Flash');
    assert.ok(!r.backup_path, 'first-time install has no pre-existing config to back up');

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(cfg.provider.bigmodel.options.apiKey, 'test-key-123');
    assert.strictEqual(cfg.provider.bigmodel.options.baseURL, 'https://open.bigmodel.cn/api/anthropic');
    assert.strictEqual(cfg.model.main, 'bigmodel/GLM-5.3-Flash');

    a = provider.authState({ ZCODE_CLI_CONFIG: cfgPath });
    assert.strictEqual(a.logged_in, true);
    assert.strictEqual(a.method, 'api-key');
    assert.strictEqual(a.provider_id, 'bigmodel');

    // 3. 已有 plugins 键必须保留（安全合并），且覆盖已有文件时产生备份
    fs.writeFileSync(cfgPath, JSON.stringify({ plugins: { enabledPlugins: { 'x@y': true } } }), 'utf8');
    const r2 = provider.loginApiKey({ key: 'k2', env: { ZCODE_CLI_CONFIG: cfgPath } });
    assert.ok(fs.existsSync(r2.backup_path), 'overwriting an existing config must back it up');
    const merged = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.deepStrictEqual(merged.plugins.enabledPlugins, { 'x@y': true }, 'plugins must survive merge');

    // 4. 空 key 拒绝
    const bad = provider.loginApiKey({ key: '  ', env: { ZCODE_CLI_CONFIG: cfgPath } });
    assert.strictEqual(bad.ok, false);
    // 5. 非法 kind 拒绝
    const badKind = provider.loginApiKey({ key: 'k', kind: 'grpc', env: { ZCODE_CLI_CONFIG: cfgPath } });
    assert.strictEqual(badKind.ok, false);
    console.log('ApiKeyMode tests PASSED!');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDesktopSyncNotice() {
  // 体检报告必含强制提示; dry-run 不携带 (未真实创建)
  const root = makeFakeCliRoot('notice');
  const env = {
    ZCODE_CLI_BIN: path.join(root, process.platform === 'win32' ? 'ZCode.exe' : 'zcode'),
    ZCODE_CLI_CONFIG: path.join(os.tmpdir(), `no_cfg_${Date.now()}.json`)
  };
  const report = provider.capabilityReport(env);
  assert.ok(/必须转达给用户/.test(report.desktop_sync_notice), 'capability report must carry the sync notice');

  const dry = provider.processCommand(['spawn', '--cwd', 'D:/x', '--prompt', 'p', '--dry-run'], env);
  assert.ok(!('user_notice_must_relay' in dry.payload), 'dry-run must not carry the notice');
  console.log('DesktopSyncNotice tests PASSED!');
}

testDiscovery();
testAuthState();
testBuildArgs();
testProcessCommandGates();
testDryRunAndExtract();
testCapabilityReportShape();
testApiKeyMode();
testDesktopSyncNotice();
console.log('ALL ZCode Spawn Provider Node.js Tests PASSED SUCCESSFULLY!');
