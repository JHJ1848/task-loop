#!/usr/bin/env node
/**
 * Unit test for Schema v4 vendor-partitioned state store (task_loop_state.js)
 * 覆盖: 动态扩展 / 厂商隔离 / 旧格式迁移 / 点路径查询 / 兼容读。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const store = require('../scripts/task_loop_state');

function freshFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_v4_'));
  return { dir, file: path.join(dir, name) };
}

function testDynamicVendorExtension() {
  const { file } = freshFile('sessions.json');
  // 首次写 zcode 分区 -> 动态创建
  store.writePartition(file, 'zcode', { main_thread_id: 'sess_z1', modules: { hook: { session_id: 'sess_z1' } }, sessions: [] });
  // 写一个全新自定义厂商 -> 动态扩展
  store.writePartition(file, 'mistral', { main_thread_id: 'sess_m1', modules: {}, sessions: [] });

  const doc = store.readJson(file);
  assert.strictEqual(doc.schema_version, 4);
  assert.deepStrictEqual(Object.keys(doc.vendors).sort(), ['mistral', 'zcode']);
  assert.ok(!doc.main_thread_id && !doc.modules, 'v4 top-level must carry no per-vendor state');
  console.log('DynamicVendorExtension PASSED!');
}

function testVendorIsolation() {
  const { file } = freshFile('sessions.json');
  store.writePartition(file, 'zcode', { main_thread_id: 'sess_z', modules: { hook: { session_id: 'sess_z_hook' } }, sessions: [{ session_id: 'sess_z' }] });
  store.writePartition(file, 'antigravity', { main_thread_id: 'sess_a', modules: { hook: { session_id: 'sess_a_hook' } }, sessions: [{ session_id: 'sess_a' }] });

  // 各自读取互不串扰
  const z = store.getPartition(file, 'zcode');
  const a = store.getPartition(file, 'antigravity');
  assert.strictEqual(z.modules.hook.session_id, 'sess_z_hook');
  assert.strictEqual(a.modules.hook.session_id, 'sess_a_hook');

  // zcode 再写不影响 antigravity 分区
  store.writePartition(file, 'zcode', { main_thread_id: 'sess_z2', modules: { hook: { session_id: 'sess_z_hook2' } }, sessions: [] });
  const doc = store.readJson(file);
  assert.strictEqual(doc.vendors.antigravity.main_thread_id, 'sess_a', 'antigravity partition must be untouched');
  assert.strictEqual(doc.vendors.zcode.modules.hook.session_id, 'sess_z_hook2');
  console.log('VendorIsolation PASSED!');
}

function testLegacyMigration() {
  const { file } = freshFile('sessions_v3.json');
  // v3 形态: 顶层 + vendors
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 3,
    main_thread_id: 'sess_top',
    current_vendor: 'zcode',
    modules: { main: { session_id: 'sess_top' } },
    sessions: [{ session_id: 'sess_top' }],
    vendors: { antigravity: { vendor: 'antigravity', main_thread_id: 'sess_agy', modules: {}, sessions: [] } }
  }), 'utf8');

  store.writePartition(file, 'zcode', { main_thread_id: 'sess_top', modules: { main: { session_id: 'sess_top' } }, sessions: [{ session_id: 'sess_top' }] });
  const doc = store.readJson(file);
  assert.strictEqual(doc.schema_version, 4);
  assert.strictEqual(doc.vendors.antigravity.main_thread_id, 'sess_agy', 'v3 vendors must be preserved');
  assert.strictEqual(doc.vendors.zcode.main_thread_id, 'sess_top');

  // v2 纯顶层 -> 迁移进 defaultVendor
  const { file: f2 } = freshFile('sessions_v2.json');
  fs.writeFileSync(f2, JSON.stringify({ schema_version: 2, main_thread_id: 'sess_v2', modules: { main: { session_id: 'sess_v2' } }, sessions: [] }), 'utf8');
  store.writePartition(f2, 'claude', { main_thread_id: 'sess_v2', modules: { main: { session_id: 'sess_v2' } }, sessions: [] });
  const doc2 = store.readJson(f2);
  assert.strictEqual(doc2.schema_version, 4);
  assert.strictEqual(doc2.vendors.claude.main_thread_id, 'sess_v2');
  console.log('LegacyMigration PASSED!');
}

function testTopicsAndQuery() {
  const { file } = freshFile('topics.json');
  store.writePartition(file, 'zcode', { topics: [{ topic_key: 'hook', name: '[钩子专题]', session_id: 'sess_z', vendor: 'zcode', resumable: true, tags: ['hook'], memory_doc: 'docs/memory/hook.md' }] }, { kind: 'topics' });
  const part = store.getPartition(file, 'zcode');
  assert.strictEqual(part.topics[0].topic_key, 'hook');

  // dot-path 查询
  assert.strictEqual(store.getDotPath(part, 'topics.0.session_id'), 'sess_z');
  assert.strictEqual(store.getDotPath(part, 'nope.nada'), undefined);

  // 别名归一
  assert.strictEqual(store.normalizeVendor('agy'), 'antigravity');
  assert.strictEqual(store.normalizeVendor('Claude-Code'), 'claude');
  console.log('TopicsAndQuery PASSED!');
}

function testCompatReadV4File() {
  const { file } = freshFile('sessions_compat.json');
  store.writePartition(file, 'zcode', { main_thread_id: 'sess_z', modules: {}, sessions: [] });
  // getPartition 兼容读 v4 文件
  assert.strictEqual(store.getPartition(file, 'zcode').main_thread_id, 'sess_z');
  assert.strictEqual(store.getPartition(file, 'codex'), null);
  // env 驱动
  const env = { ZCODE_SESSION_ID: 'sess_x' };
  assert.strictEqual(store.detectVendor(env), 'zcode');
  console.log('CompatRead PASSED!');
}

testDynamicVendorExtension();
testVendorIsolation();
testLegacyMigration();
testTopicsAndQuery();
testCompatReadV4File();
console.log('ALL State-Partition Node.js Tests PASSED SUCCESSFULLY!');
