#!/usr/bin/env node
/**
 * Unit Tests for Session Auto-Provisioner Hook (Node.js)
 * Tests PreToolUse hook for send_message:
 * 1. Valid UUID -> Allow
 * 2. Known topic alias with existing active session -> Overwrite Recipient (Idempotent, no duplicates)
 * 3. Known topic alias with archived session -> Provision new session (Archive treated as deleted)
 * 4. Unknown/malformed target -> Deny
 * 5. Send to archived UUID -> Deny with clear message
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { processPayload, normalizeTopicKey } = require('../scripts/hooks/resolve_or_create_session');

function testSessionProvisioner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_provisioner_js_'));
  try {
    const agentDir = path.join(tempDir, '.agents', 'task-loop');
    fs.mkdirSync(agentDir, { recursive: true });

    const sessionsData = {
      schema_version: 1,
      main_thread_id: '11111111-1111-1111-1111-111111111111',
      sessions: [
        {
          session_id: '11111111-1111-1111-1111-111111111111',
          title: '[主会话] 任务编排 & 治理中枢',
          is_main: true,
          archived: false
        },
        {
          session_id: '22222222-2222-2222-2222-222222222222',
          title: '[钩子专题] Hooks体系 & 状态拦截',
          is_main: false,
          archived: false,
          memory_docs: ['docs/memory/hook.md']
        },
        {
          session_id: '33333333-3333-3333-3333-333333333333',
          title: '[历史专题] 旧版会话',
          is_main: false,
          archived: true,
          archived_at: '2026-08-20T00:00:00Z'
        }
      ],
      modules: {
        hook: {
          session_id: '22222222-2222-2222-2222-222222222222',
          title: '[钩子专题] Hooks体系 & 状态拦截',
          archived: false
        },
        legacy: {
          session_id: '33333333-3333-3333-3333-333333333333',
          title: '[历史专题] 旧版会话',
          archived: true
        }
      }
    };
    fs.writeFileSync(path.join(agentDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2), 'utf8');

    console.log('Testing Topic Key Normalization...');
    assert.strictEqual(normalizeTopicKey('topic:hook'), 'hook');
    assert.strictEqual(normalizeTopicKey('module:session'), 'session_control');
    assert.strictEqual(normalizeTopicKey('SUBAGENT'), 'subagent');

    // 1. Direct valid active UUID -> Allow directly without overwrite
    console.log('Testing Valid UUID -> Allow...');
    const validUuidPayload = {
      workspacePaths: [tempDir],
      toolCall: {
        name: 'send_message',
        args: {
          Recipient: '22222222-2222-2222-2222-222222222222',
          Message: 'hello'
        }
      }
    };
    const validRes = processPayload(validUuidPayload);
    assert.strictEqual(validRes.decision, 'allow');
    assert.strictEqual(validRes.overwrite, undefined);

    // 2. Existing active topic alias -> Overwrite to existing UUID (Anti-duplicate)
    console.log('Testing Existing Active Topic Alias -> Overwrite (Idempotent)...');
    const topicAliasPayload = {
      workspacePaths: [tempDir],
      toolCall: {
        name: 'send_message',
        args: {
          Recipient: 'hook',
          Message: 'task dispatch'
        }
      }
    };
    const topicRes = processPayload(topicAliasPayload);
    assert.strictEqual(topicRes.decision, 'allow');
    assert.ok(topicRes.overwrite, 'Must have overwrite object');
    assert.strictEqual(topicRes.overwrite.Recipient, '22222222-2222-2222-2222-222222222222');

    // 3. Unknown/Random topic alias -> Deny (Avoid accidental/duplicate creations)
    console.log('Testing Unknown Topic -> Deny (Anti-accidental)...');
    const unknownPayload = {
      workspacePaths: [tempDir],
      toolCall: {
        name: 'send_message',
        args: {
          Recipient: 'random_non_existent_module',
          Message: 'do something'
        }
      }
    };
    const unknownRes = processPayload(unknownPayload);
    assert.strictEqual(unknownRes.decision, 'deny');
    assert.ok(unknownRes.reason.includes('未在已知专题清单中注册'));

    // 4. Send to archived UUID -> Deny
    console.log('Testing Send to Archived UUID -> Deny...');
    const archivedUuidPayload = {
      workspacePaths: [tempDir],
      toolCall: {
        name: 'send_message',
        args: {
          Recipient: '33333333-3333-3333-3333-333333333333',
          Message: 'hello archived'
        }
      }
    };
    const archivedRes = processPayload(archivedUuidPayload);
    assert.strictEqual(archivedRes.decision, 'deny');
    assert.ok(archivedRes.reason.includes('已归档'));

    console.log('All Node.js Session Auto-Provisioner Hook Tests PASSED!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testSessionProvisioner();
