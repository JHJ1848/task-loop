#!/usr/bin/env node
/**
 * Unit test for install_zcode_plugin.js
 * Installs into a temp destination and asserts the exported plugin copy is
 * a self-sufficient ZCode-loadable snapshot.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { installPlugin, buildMarketplace, resolveDestRoot } = require('../scripts/install_zcode_plugin');

function testMarketplaceNaming() {
  const m = buildMarketplace('task-loop');
  assert.strictEqual(m.name, 'task-loop-local');
  assert.strictEqual(m.plugins[0].name, 'task-loop');
  assert.strictEqual(m.plugins[0].source, './');
}

function testInstallToTemp() {
  const destBase = fs.mkdtempSync(path.join(os.tmpdir(), 'test_install_base_js_'));
  try {
    const result = installPlugin({ destRoot: destBase });
    assert.strictEqual(result.pluginName, 'task-loop');
    assert.strictEqual(path.basename(result.dest), 'task-loop');
    assert.ok(fs.existsSync(result.dest), 'dest dir must exist');

    // 白名单齐备
    for (const d of ['.zcode-plugin', 'hooks', 'skills', 'scripts', 'templates', 'references', 'config']) {
      assert.ok(fs.existsSync(path.join(result.dest, d)), `dest/${d} must exist`);
    }
    for (const f of ['plugin.json', 'hooks.json', 'SKILL.md', 'README.md', 'marketplace.json', 'EXPORT-INFO.md']) {
      assert.ok(fs.existsSync(path.join(result.dest, f)), `dest/${f} must exist`);
    }

    // 开发态内容严禁混入
    assert.ok(!fs.existsSync(path.join(result.dest, 'tests')), 'tests/ must NOT be exported');
    assert.ok(!fs.existsSync(path.join(result.dest, 'docs')), 'docs/ must NOT be exported');
    assert.ok(!fs.existsSync(path.join(result.dest, 'AGENTS.md')), 'AGENTS.md must NOT be exported');
    assert.ok(!fs.existsSync(path.join(result.dest, '.git')), '.git must NOT be exported');

    // marketplace 内容有效
    const market = JSON.parse(fs.readFileSync(path.join(result.dest, 'marketplace.json'), 'utf8'));
    assert.strictEqual(market.name, 'task-loop-local');
    assert.strictEqual(market.plugins[0].source, './');

    // 副本自洽: manifest + hook 引用的脚本存在
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.dest, '.zcode-plugin', 'plugin.json'), 'utf8')
    );
    assert.strictEqual(manifest.name, 'task-loop');
    const zcodeHooks = JSON.parse(fs.readFileSync(path.join(result.dest, 'hooks', 'hooks.json'), 'utf8'));
    const raw = JSON.stringify(zcodeHooks);
    assert.ok(raw.includes('inject_session_context_zcode.js'));
    assert.ok(fs.existsSync(path.join(result.dest, 'scripts', 'hooks', 'inject_session_context_zcode.js')));

    // Hook 冒烟: 副本自身可独立出上下文注入
    const inject = require(path.join(result.dest, 'scripts', 'hooks', 'inject_session_context_zcode.js'));
    const out = inject.processPayload({ session_id: 'sess_itest', cwd: result.dest }, {});
    assert.ok(out.hookSpecificOutput.additionalContext.includes('[Plugin: task-loop | 会话上下文感知]'));

    console.log('Node.js install_zcode_plugin tests PASSED!');
  } finally {
    fs.rmSync(destBase, { recursive: true, force: true });
  }
}

function testOverlapGuard() {
  const sourceRoot = path.resolve(__dirname, '..');
  assert.throws(
    () => installPlugin({ sourceRoot, destRoot: path.dirname(sourceRoot) }),
    /包含关系|相同/,
    'overlapping dest must be refused'
  );
}

function testDestResolver() {
  const custom = resolveDestRoot(os.tmpdir(), 'task-loop');
  assert.strictEqual(custom.endsWith(path.join('task-loop')), true);
}

testMarketplaceNaming();
testInstallToTemp();
testOverlapGuard();
testDestResolver();
console.log('ALL Node.js Installer Tests PASSED SUCCESSFULLY!');
