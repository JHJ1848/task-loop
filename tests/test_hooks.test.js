#!/usr/bin/env node
/**
 * Unit Tests for Antigravity Hooks (Node.js)
 * Covers:
 * 1. PreInvocation: inject_session_context.js (session_id, is_main, title, module_key, timestamps, memory_docs, todo)
 * 2. PreToolUse: enforce_allowlist.js (read-only tools, allowed write, directory write, denied write)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { processPayload: processInjectPayload, getSessionDetails } = require('../scripts/hooks/inject_session_context');
const { processPayload: processAllowlistPayload } = require('../scripts/hooks/enforce_allowlist');

function testHooks() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_hooks_js_'));
  try {
    const agentDir = path.join(tempDir, '.agents', 'task-loop');
    fs.mkdirSync(agentDir, { recursive: true });

    const sessionsData = {
      schema_version: 1,
      main_thread_id: 'main-thread-uuid-1234',
      sessions: [
        {
          session_id: 'main-thread-uuid-1234',
          title: '[主会话] 任务编排 & 治理中枢',
          is_main: true,
          created_at: '2026-08-21T08:54:04Z',
          last_active_at: '2026-08-25T02:02:46Z'
        },
        {
          session_id: 'hook-topic-uuid-5678',
          title: '[钩子专题] Hooks体系 & 状态拦截',
          summary: 'Google Antigravity 钩子体系与事件拦截',
          memory_docs: ['docs/memory/hook.md'],
          is_main: false,
          created_at: '2026-08-25T05:48:23Z',
          last_active_at: '2026-08-25T05:48:23Z'
        }
      ],
      modules: {
        hook: {
          session_id: 'hook-topic-uuid-5678',
          title: '[钩子专题] Hooks体系 & 状态拦截',
          memory_docs: ['docs/memory/hook.md']
        }
      }
    };
    fs.writeFileSync(path.join(agentDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2), 'utf8');

    const todoData = {
      items: [
        {
          id: 'TASK-HOOK-01',
          title: '开发并验证 Hooks 体系',
          assignee_thread_id: 'hook-topic-uuid-5678',
          status: 'in_progress',
          allowlist: ['docs/memory/hook.md', 'scripts/hooks/']
        }
      ]
    };
    fs.writeFileSync(path.join(agentDir, 'todo.json'), JSON.stringify(todoData, null, 2), 'utf8');

    // ==========================================
    // 1. Test PreInvocation Context Injection & Metadata Matching
    // ==========================================
    console.log('Testing PreInvocation context injection and metadata matching...');

    // 1.1 Main session test
    const mainDetails = getSessionDetails('main-thread-uuid-1234', sessionsData);
    assert.strictEqual(mainDetails.is_main, true);
    assert.strictEqual(mainDetails.session_id, 'main-thread-uuid-1234');
    assert.strictEqual(mainDetails.title, '[主会话] 任务编排 & 治理中枢');

    const mainPayload = {
      conversationId: 'main-thread-uuid-1234',
      workspacePaths: [tempDir],
      invocationNum: 1
    };
    const mainRes = processInjectPayload(mainPayload);
    assert.ok(Array.isArray(mainRes.injectSteps), 'injectSteps must be an array');
    assert.strictEqual(mainRes.injectSteps.length, 1);
    const mainMsg = mainRes.injectSteps[0].ephemeralMessage;
    assert.ok(mainMsg.includes('是否主会话: 是 (Main Thread)'));
    assert.ok(mainMsg.includes('[主会话] 任务编排 & 治理中枢'));

    // 1.2 Topic session test (with active task and memory docs)
    const topicDetails = getSessionDetails('hook-topic-uuid-5678', sessionsData);
    assert.strictEqual(topicDetails.is_main, false);
    assert.strictEqual(topicDetails.module_key, 'hook');
    assert.deepStrictEqual(topicDetails.memory_docs, ['docs/memory/hook.md']);
    assert.strictEqual(topicDetails.created_at, '2026-08-25T05:48:23Z');

    const topicPayload = {
      conversationId: 'hook-topic-uuid-5678',
      workspacePaths: [tempDir],
      invocationNum: 2
    };
    const topicRes = processInjectPayload(topicPayload);
    assert.strictEqual(topicRes.injectSteps.length, 1);
    const msg = topicRes.injectSteps[0].ephemeralMessage;
    assert.ok(msg.includes('会话 ID: hook-topic-uuid-5678'));
    assert.ok(msg.includes('是否主会话: 否 (Topic Session)'));
    assert.ok(msg.includes('专题主题: [钩子专题] Hooks体系 & 状态拦截'));
    assert.ok(msg.includes('所属模块: hook'));
    assert.ok(msg.includes('创建时间: 2026-08-25T05:48:23Z'));
    assert.ok(msg.includes('关联记忆文档: docs/memory/hook.md'));
    assert.ok(msg.includes('TASK-HOOK-01'));
    assert.ok(msg.includes('Allowlist'));

    // 1.3 Unregistered session fallback
    const unknownDetails = getSessionDetails('unknown-uuid-9999', sessionsData);
    assert.strictEqual(unknownDetails.is_unregistered, true);
    assert.strictEqual(unknownDetails.title, '未注册会话 (Unregistered Session)');

    const unknownPayload = {
      conversationId: 'unknown-uuid-9999',
      workspacePaths: [tempDir],
      invocationNum: 1
    };
    const unknownRes = processInjectPayload(unknownPayload);
    assert.strictEqual(unknownRes.injectSteps.length, 1);
    const unknownMsg = unknownRes.injectSteps[0].ephemeralMessage;
    assert.ok(unknownMsg.includes('unknown-uuid-9999'));
    assert.ok(unknownMsg.includes('是否主会话: 待定 (Unregistered)'));
    assert.ok(unknownMsg.includes('未注册会话 (Unregistered Session)'));
    assert.ok(unknownMsg.includes('角色定位: [待定 / 初始会话]'));
    assert.ok(unknownMsg.includes('当前会话未在 task-loop 状态机中注册。若需作为主治理中枢，可运行 /init 进行初始化。'));
    assert.strictEqual(unknownMsg.includes('[Plugin: task-loop | 专题会话约束规则]'), false);

    // ==========================================
    // 2. Test PreToolUse Allowlist Enforcement
    // ==========================================
    console.log('Testing PreToolUse Allowlist enforcement...');

    // 2.1 Read tool (view_file) -> Always allowed
    const readToolPayload = {
      conversationId: 'hook-topic-uuid-5678',
      workspacePaths: [tempDir],
      toolCall: {
        name: 'view_file',
        args: {
          AbsolutePath: path.join(tempDir, 'secret.env')
        }
      }
    };
    const readRes = processAllowlistPayload(readToolPayload);
    assert.strictEqual(readRes.decision, 'allow');

    // 2.2 Write tool within allowlist (docs/memory/hook.md) -> Allowed
    const writeAllowedPayload = {
      conversationId: 'hook-topic-uuid-5678',
      workspacePaths: [tempDir],
      toolCall: {
        name: 'replace_file_content',
        args: {
          TargetFile: path.join(tempDir, 'docs', 'memory', 'hook.md'),
          Instruction: 'update'
        }
      }
    };
    const writeAllowedRes = processAllowlistPayload(writeAllowedPayload);
    assert.strictEqual(writeAllowedRes.decision, 'allow');

    // 2.3 Write tool within directory allowlist (scripts/hooks/test.js) -> Allowed
    const writeDirAllowedPayload = {
      conversationId: 'hook-topic-uuid-5678',
      workspacePaths: [tempDir],
      toolCall: {
        name: 'write_to_file',
        args: {
          TargetFile: path.join(tempDir, 'scripts', 'hooks', 'test.js'),
          CodeContent: '// test'
        }
      }
    };
    const writeDirAllowedRes = processAllowlistPayload(writeDirAllowedPayload);
    assert.strictEqual(writeDirAllowedRes.decision, 'allow');

    // 2.4 Write tool OUTSIDE allowlist (src/auth/dangerous.js) -> Denied
    const writeDeniedPayload = {
      conversationId: 'hook-topic-uuid-5678',
      workspacePaths: [tempDir],
      toolCall: {
        name: 'write_to_file',
        args: {
          TargetFile: path.join(tempDir, 'src', 'auth', 'dangerous.js'),
          CodeContent: '// dangerous'
        }
      }
    };
    const writeDeniedRes = processAllowlistPayload(writeDeniedPayload);
    assert.strictEqual(writeDeniedRes.decision, 'deny');
    assert.ok(writeDeniedRes.reason.includes('不在当前任务白名单'));

    console.log('All Node.js Hook Unit Tests PASSED!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testHooks();
