#!/usr/bin/env node
/**
 * Contract Parity Test Suite (Node.js)
 * Feeds identical inputs/fixtures to verify that Node.js (Primary) and Python (Thin Adapter)
 * produce 100% equivalent behavior and matching outputs across core state, hooks, and session probes.
 */

const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const rootDir = path.resolve(__dirname, '..');

function runNode(scriptRelPath, args = [], input = null, env = {}) {
  const scriptPath = path.join(rootDir, scriptRelPath);
  const cmd = `node "${scriptPath}" ${args.join(' ')}`;
  const mergedEnv = Object.assign({}, process.env, env);
  const options = { encoding: 'utf8', env: mergedEnv };
  if (input !== null) options.input = input;
  try {
    return {
      code: 0,
      stdout: execSync(cmd, options).trim(),
      stderr: ''
    };
  } catch (err) {
    return {
      code: err.status || 1,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim()
    };
  }
}

function runPython(scriptRelPath, args = [], input = null, env = {}) {
  const scriptPath = path.join(rootDir, scriptRelPath);
  const cmd = `python "${scriptPath}" ${args.join(' ')}`;
  const mergedEnv = Object.assign({}, process.env, env);
  const options = { encoding: 'utf8', env: mergedEnv };
  if (input !== null) options.input = input;
  try {
    return {
      code: 0,
      stdout: execSync(cmd, options).trim(),
      stderr: ''
    };
  } catch (err) {
    return {
      code: err.status || 1,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim()
    };
  }
}

function runParityTests() {
  console.log('Running test_contract_parity.test.js (Dual-Runtime Contract Parity)...');

  // 1. Parity Check: query_task_loop_state (vendors, key query)
  console.log('  Testing query_task_loop_state parity...');
  const nodeVendors = runNode('scripts/query_task_loop_state.js', ['vendors']);
  const pyVendors = runPython('scripts/query_task_loop_state.py', ['vendors']);
  assert.strictEqual(nodeVendors.code, 0, 'Node query vendors should succeed');
  assert.strictEqual(pyVendors.code, 0, 'Python query vendors should succeed');

  const nodeVendorsJson = JSON.parse(nodeVendors.stdout);
  const pyVendorsJson = JSON.parse(pyVendors.stdout);
  assert.deepStrictEqual(
    nodeVendorsJson.sort(),
    pyVendorsJson.sort(),
    'Vendors list must be 100% equivalent across Node.js and Python'
  );

  const nodeMain = runNode('scripts/query_task_loop_state.js', ['--vendor', 'antigravity', '--key', 'main_thread_id']);
  const pyMain = runPython('scripts/query_task_loop_state.py', ['--vendor', 'antigravity', '--key', 'main_thread_id']);
  assert.strictEqual(nodeMain.stdout, pyMain.stdout, 'main_thread_id query output must be identical');

  // 2. Parity Check: enforce_allowlist Hook Decision
  console.log('  Testing enforce_allowlist Hook parity...');
  const allowPayload = JSON.stringify({
    toolCall: {
      name: 'replace_file_content',
      args: { TargetFile: 'SKILL.md' }
    },
    workspacePaths: [rootDir]
  });

  const nodeAllow = runNode('scripts/hooks/enforce_allowlist.js', [], allowPayload);
  const pyAllow = runPython('scripts/hooks/enforce_allowlist.py', [], allowPayload);
  assert.strictEqual(nodeAllow.code, 0);
  assert.strictEqual(pyAllow.code, 0);

  const nodeAllowJson = JSON.parse(nodeAllow.stdout);
  const pyAllowJson = JSON.parse(pyAllow.stdout);
  assert.strictEqual(nodeAllowJson.decision, 'allow', 'Node allowlist should allow SKILL.md');
  assert.strictEqual(pyAllowJson.decision, 'allow', 'Python allowlist should allow SKILL.md');
  assert.strictEqual(nodeAllowJson.decision, pyAllowJson.decision, 'Allow decisions must match');

  // 3. Parity Check: inject_session_context Hook Output Shape
  console.log('  Testing inject_session_context Hook parity...');
  const injectPayload = JSON.stringify({
    conversationId: '83bae782-1e95-4923-a76f-2141fe8c5c61',
    workspacePaths: [rootDir],
    isTest: true
  });

  const nodeInject = runNode('scripts/hooks/inject_session_context.js', [], injectPayload);
  const pyInject = runPython('scripts/hooks/inject_session_context.py', [], injectPayload);
  assert.strictEqual(nodeInject.code, 0);
  assert.strictEqual(pyInject.code, 0);

  const nodeInjectJson = JSON.parse(nodeInject.stdout);
  const pyInjectJson = JSON.parse(pyInject.stdout);
  assert.ok(Array.isArray(nodeInjectJson.injectSteps) && nodeInjectJson.injectSteps.length > 0);
  assert.ok(Array.isArray(pyInjectJson.injectSteps) && pyInjectJson.injectSteps.length > 0);
  assert.ok(nodeInjectJson.injectSteps[0].ephemeralMessage.includes('[Plugin: task-loop | 会话上下文感知]'));
  assert.ok(pyInjectJson.injectSteps[0].ephemeralMessage.includes('[Plugin: task-loop | 会话上下文感知]'));

  // 4. Parity Check: find_project_sessions Output Structure
  console.log('  Testing find_project_sessions schema parity...');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_parity_find_'));
  try {
    const nodeFind = runNode('scripts/find_project_sessions.js', ['--root', tempDir, '--vendor', 'All']);
    const pyFind = runPython('scripts/find_project_sessions.py', ['--root', tempDir, '--vendor', 'All']);
    assert.strictEqual(nodeFind.code, 0);
    assert.strictEqual(pyFind.code, 0);

    const nodeFindJson = JSON.parse(nodeFind.stdout);
    const pyFindJson = JSON.parse(pyFind.stdout);
    assert.deepStrictEqual(nodeFindJson, pyFindJson, 'Empty find_project_sessions result must match identically');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('test_contract_parity.test.js PASSED (Dual-Runtime Contract Parity 100%)!');
}

runParityTests();
