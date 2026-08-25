#!/usr/bin/env node
/**
 * Unit test for Topic Reconcile (Node.js)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { reconcileTopics } = require('../scripts/reconcile_task_loop_topics');

function testTopicLifecycle() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_reconcile_js_'));
  try {
    const manifestPath = path.join(tempDir, 'topics.json');
    const registryPath = path.join(tempDir, 'sessions.json');

    const manifestData = {
      schema_version: 1,
      topics: [
        {
          module_key: 'auth',
          title: 'auth-AuthModule',
          title_prefix: 'auth-',
          memory_docs: ['docs/memory/auth.md'],
          enabled: true
        }
      ]
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');

    const registryData = {
      schema_version: 1,
      main_thread_id: 'test-main-id',
      modules: {}
    };
    fs.writeFileSync(registryPath, JSON.stringify(registryData, null, 2), 'utf8');

    // 1. Reconcile
    const rec = reconcileTopics(tempDir, manifestPath, registryPath);
    assert.strictEqual(rec.action, 'RECONCILED');
    assert.strictEqual(rec.provisioned.length, 1);

    // 2. Reconcile again -> NOOP
    const rec2 = reconcileTopics(tempDir, manifestPath, registryPath);
    assert.strictEqual(rec2.action, 'NOOP');

    console.log('Node.js Topic Reconcile Test PASSED!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testTopicLifecycle();
