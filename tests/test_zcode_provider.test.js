#!/usr/bin/env node
/**
 * Unit test for ZCode Session Provider (Node.js)
 * Builds a fake ~/.zcode/cli/rollout fixture and verifies reverse introspection.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { scanZcodeSessions } = require('../scripts/providers/get_zcode_project_sessions');

function testRolloutScan() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_zcode_proj_js_'));
  const rolloutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_zcode_rollout_js_'));
  try {
    const normRoot = path.resolve(projectDir).replace(/\\/g, '/').toLowerCase();
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const logFile = path.join(rolloutDir, `model-io-sess_${sessionId}.jsonl`);

    const lineReal = JSON.stringify({
      requestId: 'r1',
      request: {
        body: {
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: `work on ${normRoot}/src/app.js today` }]
            }
          ]
        }
      }
    });
    // Host-internal synthetic turn that wraps a derived title -> must be unwrapped, not dropped
    const lineWrappedTitle = JSON.stringify({
      request: {
        body: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: '{"title":"zcode branch adaptation"}' }] },
            { role: 'assistant', content: [] }
          ]
        }
      }
    });
    // Host-internal title-generation instruction -> must be fully filtered out
    const lineMetaPrompt = JSON.stringify({
      request: {
        body: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Generate a concise title for this coding session {"title":"x"}' }] }
          ]
        }
      }
    });
    // Belongs to another project -> must be excluded entirely
    const lineForeign = JSON.stringify({
      request: {
        body: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'totally unrelated elsewhere project note' }] }
          ]
        }
      }
    });

    fs.writeFileSync(logFile, [lineReal, lineWrappedTitle, lineMetaPrompt, lineForeign].join('\n'), 'utf8');

    const sessions = scanZcodeSessions(projectDir, { rolloutDir }, true);
    assert.strictEqual(sessions.length, 1, `expected exactly 1 zcode session, got ${sessions.length}`);
    const s = sessions[0];

    assert.strictEqual(s.vendor, 'zcode');
    assert.strictEqual(s.session_id, `sess_${sessionId}`);
    assert.ok(s.title.startsWith('work on'), `unexpected title: ${s.title}`);
    assert.ok(!s.title.includes('"title"'), 'synthetic title wrapper leaked into title');

    assert.ok(
      s.recent_prompts.some(p => p.startsWith('work on')),
      'real work prompt missing'
    );
    assert.ok(
      s.recent_prompts.some(p => p === 'zcode branch adaptation'),
      'wrapped inner title should surface as a usable prompt fragment'
    );
    assert.ok(
      !s.recent_prompts.some(p => /Generate a concise title/i.test(p)),
      'host-internal meta prompt leaked into recent_prompts'
    );
    assert.strictEqual(s.log_path.endsWith('.jsonl'), true);
    assert.ok(Array.isArray(s.recent_touched_files));

    console.log('Node.js ZCode Provider (rollout scan) test PASSED!');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(rolloutDir, { recursive: true, force: true });
  }
}

function testNoMatchReturnsEmpty() {
  const emptyRollout = fs.mkdtempSync(path.join(os.tmpdir(), 'test_zcode_empty_js_'));
  const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'test_zcode_none_js_'));
  try {
    const sessions = scanZcodeSessions(otherProject, { rolloutDir: emptyRollout }, false);
    assert.deepStrictEqual(sessions, []);
    console.log('Node.js ZCode Provider (empty store) test PASSED!');
  } finally {
    fs.rmSync(emptyRollout, { recursive: true, force: true });
    fs.rmSync(otherProject, { recursive: true, force: true });
  }
}

testRolloutScan();
testNoMatchReturnsEmpty();
