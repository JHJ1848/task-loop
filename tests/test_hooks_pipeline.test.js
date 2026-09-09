const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const os = require('os');

const MOCK_MAIN_ID = '11111111-2222-3333-4444-555555555555';
const MOCK_TOPIC_ID = '83bae782-1e95-4923-a76f-2141fe8c5c61';
const MOCK_CODEX_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function createMockSandbox(rootDir) {
  const tempDir = path.join(rootDir, `.test_sandbox_pipeline_js_${Date.now()}`);
  const agentDir = path.join(tempDir, '.agents', 'task-loop');
  fs.mkdirSync(agentDir, { recursive: true });

  const sessionsData = {
    schema_version: 4,
    vendors: {
      antigravity: {
        vendor: 'antigravity',
        main_thread_id: MOCK_MAIN_ID,
        sessions: [
          {
            session_id: MOCK_MAIN_ID,
            title: '[主会话] 任务编排 & 治理中枢',
            is_main: true,
            created_at: '2026-08-21T08:54:04Z',
            last_active_at: '2026-08-25T02:02:46Z'
          },
          {
            session_id: MOCK_TOPIC_ID,
            title: '[专题] 会话控制与内省',
            summary: '跨厂商会话日志反向内省',
            memory_docs: ['docs/memory/session_control.md'],
            module_key: 'session_control',
            is_main: false,
            created_at: '2026-08-25T05:48:23Z',
            last_active_at: '2026-08-25T05:48:23Z'
          }
        ],
        modules: {
          session_control: {
            session_id: MOCK_TOPIC_ID,
            title: '[专题] 会话控制与内省',
            memory_docs: ['docs/memory/session_control.md']
          }
        }
      }
    }
  };
  fs.writeFileSync(path.join(agentDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2), 'utf8');
  return tempDir;
}

function runHooksPipelineTests() {
  const rootDir = path.resolve(__dirname, '..');
  const injectScript = path.join(rootDir, 'scripts', 'hooks', 'inject_session_context.js');
  const allowlistScript = path.join(rootDir, 'scripts', 'hooks', 'enforce_allowlist.js');
  const sandboxDir = createMockSandbox(rootDir);

  try {
    // 1. Test inject_session_context.js with known session
    const mockPreInvocation = JSON.stringify({
      vendor: 'antigravity',
      conversationId: MOCK_TOPIC_ID,
      workspacePaths: [sandboxDir],
      invocationNum: 0,
      initialNumSteps: 2,
      isTest: true
    });

    const injectOutput = execSync(`node "${injectScript}"`, {
      input: mockPreInvocation,
      encoding: 'utf8'
    });

    const injectResult = JSON.parse(injectOutput);
    assert.ok(Array.isArray(injectResult.injectSteps), 'injectSteps must be array');
    assert.ok(injectResult.injectSteps.length > 0, 'injectSteps should contain injected step for known session');
    assert.ok(injectResult.injectSteps[0].ephemeralMessage.includes('83bae782'), 'ephemeralMessage should include session ID');

    // Codex is explicitly unsupported, even when its thread ID looks like an AGY UUID.
    const codexInjectResult = JSON.parse(execSync(`node "${injectScript}"`, {
      input: JSON.stringify({ vendor: 'codex', conversationId: MOCK_CODEX_ID, workspacePaths: [sandboxDir], isTest: true }),
      encoding: 'utf8'
    }));
    assert.ok(['hook', 'reason', 'reasonCode', 'status', 'supported', 'vendor'].every(key => Object.prototype.hasOwnProperty.call(codexInjectResult, key)));
    assert.strictEqual(codexInjectResult.supported, false);
    assert.strictEqual(codexInjectResult.vendor, 'codex');
    assert.strictEqual(codexInjectResult.status, 'unsupported');
    assert.strictEqual(codexInjectResult.reasonCode, 'CODEX_AUTOMATIC_HOOK_UNSUPPORTED');
    assert.strictEqual(codexInjectResult.hook, 'PreInvocation');
    assert.match(codexInjectResult.reason, /unsupported/i);
    assert.strictEqual(codexInjectResult.injectSteps, undefined);

    // 1.1 Test consecutive invocation (should not be blocked in test environment)
    const injectOutput2 = execSync(`node "${injectScript}"`, {
      input: mockPreInvocation,
      encoding: 'utf8'
    });
    const injectResult2 = JSON.parse(injectOutput2);
    assert.ok(injectResult2.injectSteps && injectResult2.injectSteps.length > 0, 'Consecutive invocation in test mode should return injectSteps');

    // 1.2 Test deduplication within 2000ms window (non-test mode)
    const dedupId = "dedupe-test-" + Date.now();
    const mockDedupePayload = JSON.stringify({
      vendor: 'antigravity',
      conversationId: dedupId,
      workspacePaths: [sandboxDir]
    });
    const dedupeOutput1 = execSync(`node "${injectScript}"`, {
      input: mockDedupePayload,
      encoding: 'utf8'
    });
    const dedupeResult1 = JSON.parse(dedupeOutput1);
    assert.ok(dedupeResult1.injectSteps && dedupeResult1.injectSteps.length > 0, 'First call should inject');

    const dedupeOutput2 = execSync(`node "${injectScript}"`, {
      input: mockDedupePayload,
      encoding: 'utf8'
    });
    const dedupeResult2 = JSON.parse(dedupeOutput2);
    assert.strictEqual(dedupeResult2.injectSteps.length, 0, 'Second call within 2000ms should be dropped');

    // 1.3 Test vendor auto-detection by session ID shape (Main Session)
    const mainPayload = JSON.stringify({
      vendor: 'antigravity',
      conversationId: MOCK_MAIN_ID,
      workspacePaths: [sandboxDir],
      isTest: true
    });
    const mainOutput = execSync(`node "${injectScript}"`, {
      input: mainPayload,
      encoding: 'utf8'
    });
    const mainResult = JSON.parse(mainOutput);
    assert.ok(mainResult.injectSteps && mainResult.injectSteps.length > 0, 'Main session should inject');
    assert.ok(mainResult.injectSteps[0].ephemeralMessage.includes('主会话'), 'Main session should be recognized as main');
    assert.strictEqual(
      mainResult.injectSteps[0].ephemeralMessage.includes('专题强制收尾与反向汇报契约'),
      false,
      'Main session must NEVER inject wrapup contract (prevent self-send infinite loop)'
    );

    // 1.4 Test ZCode adapter ignores AGY UUID sessions
    const zcodeScript = path.join(rootDir, 'scripts', 'hooks', 'inject_session_context_zcode.js');
    const zcodePayload = JSON.stringify({
      sessionId: MOCK_TOPIC_ID,
      workspacePaths: [sandboxDir],
      isTest: true
    });
    const zcodeOutput = execSync(`node "${zcodeScript}"`, {
      input: zcodePayload,
      encoding: 'utf8'
    });
    const zcodeResult = JSON.parse(zcodeOutput || '{}');
    assert.strictEqual(Object.keys(zcodeResult).length, 0, 'ZCode adapter should ignore AGY UUID sessions');

    // 1.5 Test Topic Session receives mandatory wrapup reverse reporting rule
    const topicPayload = JSON.stringify({
      vendor: 'antigravity',
      conversationId: MOCK_TOPIC_ID,
      workspacePaths: [sandboxDir],
      isTest: true
    });
    const topicOutput = execSync(`node "${injectScript}"`, {
      input: topicPayload,
      encoding: 'utf8'
    });
    const topicResult = JSON.parse(topicOutput);
    assert.ok(topicResult.injectSteps && topicResult.injectSteps.length > 0, 'Topic session should inject');
    assert.ok(topicResult.injectSteps[0].ephemeralMessage.includes('专题强制收尾与反向汇报契约'), 'Topic session should receive wrapup contract');
    assert.ok(topicResult.injectSteps[0].ephemeralMessage.includes('send_message(recipient='), 'Topic session wrapup contract should include send_message instruction');

    // 2. Test enforce_allowlist.js with allowed file
    const mockAllowedToolUse = JSON.stringify({
      vendor: 'antigravity',
      conversationId: MOCK_TOPIC_ID,
      toolCall: {
        name: "replace_file_content",
        args: {
          TargetFile: "SKILL.md"
        }
      },
      workspacePaths: [sandboxDir]
    });

    process.env.TASK_LOOP_ALLOWLIST = 'SKILL.md';
    const allowlistOutput1 = execSync(`node "${allowlistScript}"`, {
      input: mockAllowedToolUse,
      encoding: 'utf8'
    });
    const allowResult1 = JSON.parse(allowlistOutput1);
    delete process.env.TASK_LOOP_ALLOWLIST;
    assert.strictEqual(allowResult1.decision, 'allow', 'Allowed file should pass gate');

    for (const vendorCase of [
      { vendor: 'codex', conversationId: MOCK_CODEX_ID },
      { vendor: 'unknown-vendor', conversationId: MOCK_TOPIC_ID },
      { vendor: 'zcode', conversationId: MOCK_TOPIC_ID },
      { vendor: 'antigravity', conversationId: '99999999-8888-7777-6666-555555555555' }
    ]) {
      const denied = JSON.parse(execSync(`node "${allowlistScript}"`, {
        input: JSON.stringify({ ...vendorCase, toolCall: { name: 'replace_file_content', args: { TargetFile: 'SKILL.md' } }, workspacePaths: [sandboxDir] }),
        encoding: 'utf8'
      }));
      assert.strictEqual(denied.decision, 'deny', `${vendorCase.vendor} file write should be denied`);
    }

    // 3. Test enforce_allowlist.js with disallowed file (Main Thread Explore-Only Gate)
    const mockDisallowedToolUse = JSON.stringify({
      vendor: 'antigravity',
      conversationId: MOCK_MAIN_ID,
      toolCall: {
        name: "replace_file_content",
        args: {
          TargetFile: "src/unauthorized_file.js"
        }
      },
      workspacePaths: [sandboxDir]
    });

    const allowlistOutput2 = execSync(`node "${allowlistScript}"`, {
      input: mockDisallowedToolUse,
      encoding: 'utf8'
    });
    const allowResult2 = JSON.parse(allowlistOutput2);
    assert.strictEqual(allowResult2.decision, 'deny', 'Unauthorized file should be denied');
    assert.ok(
      allowResult2.reason.includes('Allowlist') ||
      allowResult2.reason.includes('白名单') ||
      allowResult2.reason.includes('主会话') ||
      allowResult2.reason.includes('Explore Only'),
      'Deny reason should explain violation'
    );

    // 4. Test enforce_allowlist.js with topic session disallowed file returns ALLOWLIST_EXPANSION_REQUEST
    const mockTopicDisallowed = JSON.stringify({
      vendor: 'antigravity',
      conversationId: MOCK_TOPIC_ID,
      toolCall: {
        name: "replace_file_content",
        args: {
          TargetFile: "src/forbidden_module.js"
        }
      },
      workspacePaths: [sandboxDir]
    });
    process.env.TASK_LOOP_ALLOWLIST = "skills/subagent/SKILL.md";
    const topicDenyOutput = execSync(`node "${allowlistScript}"`, {
      input: mockTopicDisallowed,
      encoding: 'utf8'
    });
    const topicDenyResult = JSON.parse(topicDenyOutput);
    assert.strictEqual(topicDenyResult.decision, 'deny');
    assert.ok(topicDenyResult.reason.includes('ALLOWLIST_EXPANSION_REQUEST'));

    // 5. Test enforce_allowlist.js with exempt paths (docs, Desktop, scratch)
    const mockExemptToolUse = JSON.stringify({
      vendor: 'antigravity',
      conversationId: MOCK_TOPIC_ID,
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: "docs/memory/session_control.md"
        }
      },
      workspacePaths: [sandboxDir]
    });
    process.env.TASK_LOOP_ALLOWLIST = "src/only_allowed.js";
    const exemptOutput = execSync(`node "${allowlistScript}"`, {
      input: mockExemptToolUse,
      encoding: 'utf8'
    });
    delete process.env.TASK_LOOP_ALLOWLIST;
    const exemptResult = JSON.parse(exemptOutput);
    assert.strictEqual(exemptResult.decision, 'allow', 'Exempt doc path should be allowed even if not in task allowlist');

    console.log('Node.js Hooks Pipeline Tests PASSED!');
  } finally {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
}

runHooksPipelineTests();

