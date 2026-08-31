const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

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
    conversationId: "ee94b2c5-c0c2-473f-8f71-213250ba5295",
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

  console.log('Node.js Hooks Pipeline Tests PASSED!');
}

runHooksPipelineTests();
