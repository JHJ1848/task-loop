const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const fs = require('fs');

function currentMainId() {
  const file = path.join(__dirname, '..', '.agents', 'task-loop', 'sessions.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const part of Object.values(data.vendors || {})) {
      if (part && part.main_thread_id) return part.main_thread_id;
    }
    return data.main_thread_id || null;
  } catch (e) { return null; }
}

function runHooksPipelineTests() {
  const rootDir = path.resolve(__dirname, '..');
  const injectScript = path.join(rootDir, 'scripts', 'hooks', 'inject_session_context.js');
  const allowlistScript = path.join(rootDir, 'scripts', 'hooks', 'enforce_allowlist.js');

  // 1. Test inject_session_context.js with known session
  const mockPreInvocation = JSON.stringify({
    conversationId: "83bae782-1e95-4923-a76f-2141fe8c5c61",
    workspacePaths: [rootDir],
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
    conversationId: dedupId,
    workspacePaths: [rootDir]
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

  // 1.3 Test vendor auto-detection by session ID shape
  const mainId = currentMainId();
  if (mainId) {
    const mainPayload = JSON.stringify({
      conversationId: mainId,
      workspacePaths: [rootDir],
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
  }

  // 1.4 Test ZCode adapter ignores AGY UUID sessions
  const zcodeScript = path.join(rootDir, 'scripts', 'hooks', 'inject_session_context_zcode.js');
  const zcodePayload = JSON.stringify({
    sessionId: "83bae782-1e95-4923-a76f-2141fe8c5c61",
    workspacePaths: [rootDir],
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
    conversationId: "83bae782-1e95-4923-a76f-2141fe8c5c61",
    workspacePaths: [rootDir],
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
    toolCall: {
      name: "replace_file_content",
      args: {
        TargetFile: "SKILL.md"
      }
    },
    workspacePaths: [rootDir]
  });

  const allowlistOutput1 = execSync(`node "${allowlistScript}"`, {
    input: mockAllowedToolUse,
    encoding: 'utf8'
  });
  const allowResult1 = JSON.parse(allowlistOutput1);
  assert.strictEqual(allowResult1.decision, 'allow', 'Allowed file should pass gate');

  // 3. Test enforce_allowlist.js with disallowed file (Main Thread Explore-Only Gate)
  const mockDisallowedToolUse = JSON.stringify({
    conversationId: currentMainId(),
    toolCall: {
      name: "replace_file_content",
      args: {
        TargetFile: "src/unauthorized_file.js"
      }
    },
    workspacePaths: [rootDir]
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
    conversationId: "83bae782-1e95-4923-a76f-2141fe8c5c61",
    toolCall: {
      name: "replace_file_content",
      args: {
        TargetFile: "src/forbidden_module.js"
      }
    },
    workspacePaths: [rootDir]
  });
  process.env.TASK_LOOP_ALLOWLIST = "skills/subagent/SKILL.md";
  const topicDenyOutput = execSync(`node "${allowlistScript}"`, {
    input: mockTopicDisallowed,
    encoding: 'utf8'
  });
  delete process.env.TASK_LOOP_ALLOWLIST;
  const topicDenyResult = JSON.parse(topicDenyOutput);
  assert.strictEqual(topicDenyResult.decision, 'deny');
  assert.ok(topicDenyResult.reason.includes('ALLOWLIST_EXPANSION_REQUEST'), 'Deny reason should contain ALLOWLIST_EXPANSION_REQUEST template');
  assert.ok(topicDenyResult.reason.includes('send_message'), 'Deny reason should guide send_message to main session');

  console.log('Node.js Hooks Pipeline Tests PASSED!');
}

runHooksPipelineTests();

