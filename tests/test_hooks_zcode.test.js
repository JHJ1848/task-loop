#!/usr/bin/env node
/**
 * Unit test for ZCode Hook Protocol Adapters (Node.js)
 * Covers inject_session_context_zcode.js and enforce_allowlist_zcode.js.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const injectAdapter = require('../scripts/hooks/inject_session_context_zcode');
const gateAdapter = require('../scripts/hooks/enforce_allowlist_zcode');

function withTempWorkspace(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'test_zcode_hooks_js_'));
  try {
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function writeZcodeRegistry(ws, sessionIds) {
  const agentDir = path.join(ws, '.agents', 'task-loop');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'sessions.json'), JSON.stringify({
    schema_version: 4,
    vendors: {
      zcode: {
        vendor: 'zcode',
        main_thread_id: null,
        modules: {},
        sessions: sessionIds.map(session_id => ({ session_id, vendor: 'zcode', is_main: false }))
      }
    }
  }, null, 2), 'utf8');
}

function testInjectContract() {
  withTempWorkspace(ws => {
    const env = {};
    const payload = {
      session_id: 'sess_abc123_js',
      hook_event_name: 'UserPromptSubmit',
      cwd: ws,
      isTest: true
    };
    const out = injectAdapter.processPayload(payload, env);
    assert.ok(out.hookSpecificOutput, 'missing hookSpecificOutput');
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(
      out.hookSpecificOutput.additionalContext.includes('[Plugin: task-loop | 会话上下文感知]'),
      'injected context must carry the plugin namespace header'
    );
    assert.ok(out.suppressOutput === true);
  });
}

function testInjectSessionStartAndEnvFallback() {
  withTempWorkspace(ws => {
    const payloadCamel = { sessionId: undefined, hookEventName: undefined, cwd: ws };
    const env = { CLAUDE_SESSION_ID: 'sess_env_fallback', ZCODE_PROJECT_DIR: ws };
    const out = injectAdapter.processPayload(payloadCamel, env);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(out.hookSpecificOutput.additionalContext.includes('sess_env_fallback'));

    // SessionStart event passthrough
    const payloadStart = { session_id: 'sess_start1', hook_event_name: 'SessionStart', cwd: ws };
    const outStart = injectAdapter.processPayload(payloadStart, {});
    assert.strictEqual(outStart.hookSpecificOutput.hookEventName, 'SessionStart');

    // No session id anywhere -> strict-schema no-op
    const noId = injectAdapter.processPayload({ cwd: ws }, {});
    assert.deepStrictEqual(noId, {});
  });
}

function testGateDenyShape() {
  const prevAllowlist = process.env.TASK_LOOP_ALLOWLIST;
  const prevZcodeSession = process.env.ZCODE_SESSION_ID;
  process.env.TASK_LOOP_ALLOWLIST = JSON.stringify(['src/**']);
  process.env.ZCODE_SESSION_ID = 'sess_gate1';
  try {
    withTempWorkspace(ws => {
      writeZcodeRegistry(ws, ['sess_gate1']);
      const denyPayload = {
        session_id: 'sess_gate1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(ws, 'README.md') },
        cwd: ws
      };
      const out = gateAdapter.processPayload(denyPayload, {});
      assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        typeof out.hookSpecificOutput.permissionDecisionReason === 'string' &&
          out.hookSpecificOutput.permissionDecisionReason.length > 0,
        'deny must carry a reason'
      );

      // In-allowlist write -> silent pass
      const allowPayload = Object.assign({}, denyPayload, {
        tool_input: { file_path: path.join(ws, 'src/app.js') }
      });
      const allowOut = gateAdapter.processPayload(allowPayload, {});
      assert.deepStrictEqual(allowOut, {});

      const unregisteredOut = gateAdapter.processPayload({
        ...allowPayload,
        session_id: 'sess_unregistered',
      }, {});
      assert.strictEqual(unregisteredOut.hookSpecificOutput.permissionDecision, 'deny');

      // Non-write tools pass silently regardless of path
      const readPayload = Object.assign({}, denyPayload, {
        tool_name: 'Read',
        tool_input: { file_path: path.join(ws, 'README.md') }
      });
      assert.deepStrictEqual(gateAdapter.processPayload(readPayload, {}), {});
    });
  } finally {
    if (prevAllowlist === undefined) delete process.env.TASK_LOOP_ALLOWLIST;
    else process.env.TASK_LOOP_ALLOWLIST = prevAllowlist;
    if (prevZcodeSession === undefined) delete process.env.ZCODE_SESSION_ID;
    else process.env.ZCODE_SESSION_ID = prevZcodeSession;
  }
}

function testGateLegacyAgyToolsStillGuarded() {
  const prevAllowlist = process.env.TASK_LOOP_ALLOWLIST;
  process.env.TASK_LOOP_ALLOWLIST = JSON.stringify(['src/**']);
  try {
    withTempWorkspace(ws => {
      // AGY-style toolCall shape must keep working through the core
      const { processPayload } = require('../scripts/hooks/enforce_allowlist');
      const agyDeny = processPayload({
        toolCall: { name: 'write_to_file', args: { TargetFile: path.join(ws, 'evil.md') } },
        conversationId: 'sess_agy',
        workspacePaths: [ws]
      });
      assert.strictEqual(agyDeny.decision, 'deny');
    });
  } finally {
    if (prevAllowlist === undefined) delete process.env.TASK_LOOP_ALLOWLIST;
    else process.env.TASK_LOOP_ALLOWLIST = prevAllowlist;
  }
}

testInjectContract();
testInjectSessionStartAndEnvFallback();
testGateDenyShape();
testGateLegacyAgyToolsStillGuarded();
console.log('Node.js ZCode Hook Adapter tests PASSED!');
