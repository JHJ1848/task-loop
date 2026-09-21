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

  // Setup isolated fixture directory for 100% reproducible tests in any CI/clean environment
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_contract_parity_ws_'));

  try {
    const taskLoopDir = path.join(fixtureDir, '.agents', 'task-loop');
    fs.mkdirSync(taskLoopDir, { recursive: true });

    const sessionsData = {
      schema_version: 4,
      updated_at: '2026-09-20T00:00:00.000Z',
      vendors: {
        antigravity: {
          schema_version: 3,
          vendor: 'antigravity',
          main_thread_id: 'main-thread-uuid-1234',
          updated_at: '2026-09-20T00:00:00.000Z',
          modules: {
            main: {
              session_id: 'main-thread-uuid-1234',
              title: '[主会话] 任务编排 & 治理中枢',
              tags: ['main', 'orchestrator'],
              memory_doc: 'docs/MEMORY.md',
              vendor: 'antigravity',
              resumable: true,
              is_main: true
            },
            hook: {
              session_id: 'hook-topic-uuid-5678',
              title: '[钩子专题] 生命周期 & 安全门禁',
              tags: ['hook', 'topic'],
              memory_doc: 'docs/memory/hook.md',
              vendor: 'antigravity',
              resumable: true,
              is_main: false
            }
          },
          sessions: [
            {
              session_id: 'main-thread-uuid-1234',
              vendor: 'antigravity',
              title: '[主会话] 任务编排 & 治理中枢',
              is_main: true,
              module_key: 'main',
              resumable: true,
              memory_docs: ['docs/MEMORY.md']
            },
            {
              session_id: 'hook-topic-uuid-5678',
              vendor: 'antigravity',
              title: '[钩子专题] 生命周期 & 安全门禁',
              is_main: false,
              module_key: 'hook',
              resumable: true,
              memory_docs: ['docs/memory/hook.md']
            }
          ]
        },
        zcode: {
          schema_version: 3,
          vendor: 'zcode',
          main_thread_id: 'zcode-main-uuid-9999',
          updated_at: '2026-09-20T00:00:00.000Z',
          modules: {
            main: {
              session_id: 'zcode-main-uuid-9999',
              title: '[主会话] 任务编排',
              vendor: 'zcode',
              is_main: true
            }
          },
          sessions: [
            {
              session_id: 'zcode-main-uuid-9999',
              vendor: 'zcode',
              title: '[主会话] 任务编排',
              is_main: true,
              module_key: 'main'
            }
          ]
        }
      }
    };
    fs.writeFileSync(path.join(taskLoopDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2), 'utf8');

    const todoData = {
      items: [
        {
          id: 'TASK-HOOK-01',
          title: '开发并验证 Hooks 体系',
          assignee_thread_id: 'hook-topic-uuid-5678',
          status: 'in_progress',
          allowlist: ['docs/memory/hook.md', 'scripts/hooks/test.js']
        }
      ]
    };
    fs.writeFileSync(path.join(taskLoopDir, 'todo.json'), JSON.stringify(todoData, null, 2), 'utf8');

    // Create fixture mock files
    fs.writeFileSync(path.join(fixtureDir, 'AGENTS.md'), '# Governance Rules\n', 'utf8');
    fs.mkdirSync(path.join(fixtureDir, 'docs', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'docs', 'memory', 'hook.md'), '# Hook Memory\n', 'utf8');
    fs.mkdirSync(path.join(fixtureDir, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'scripts', 'hooks', 'test.js'), '// Hook script\n', 'utf8');
    fs.mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'src', 'forbidden.js'), '// Forbidden script\n', 'utf8');

    // 1. Parity Check: query_task_loop_state (vendors, key query)
    console.log('  Testing query_task_loop_state parity...');
    const nodeVendors = runNode('scripts/query_task_loop_state.js', ['vendors', '--workspace', fixtureDir]);
    const pyVendors = runPython('scripts/query_task_loop_state.py', ['vendors', '--workspace', fixtureDir]);
    assert.strictEqual(nodeVendors.code, 0, 'Node query vendors should succeed');
    assert.strictEqual(pyVendors.code, 0, 'Python query vendors should succeed');

    const nodeVendorsJson = JSON.parse(nodeVendors.stdout);
    const pyVendorsJson = JSON.parse(pyVendors.stdout);
    assert.deepStrictEqual(
      nodeVendorsJson.sort(),
      pyVendorsJson.sort(),
      'Vendors list must be 100% equivalent across Node.js and Python'
    );

    const nodeMain = runNode('scripts/query_task_loop_state.js', ['--workspace', fixtureDir, '--vendor', 'antigravity', '--key', 'main_thread_id']);
    const pyMain = runPython('scripts/query_task_loop_state.py', ['--workspace', fixtureDir, '--vendor', 'antigravity', '--key', 'main_thread_id']);
    assert.strictEqual(nodeMain.code, 0, 'Node main query should succeed');
    assert.strictEqual(pyMain.code, 0, 'Python main query should succeed');
    assert.strictEqual(nodeMain.stdout, pyMain.stdout, 'main_thread_id query output must be identical');
    assert.strictEqual(JSON.parse(nodeMain.stdout), 'main-thread-uuid-1234');

    // 2. Parity Check: enforce_allowlist Hook Decisions
    console.log('  Testing enforce_allowlist Hook parity...');
    const cleanEnv = { TASK_LOOP_ALLOWLIST: '' };

    function runAllowlistCheck(label, payloadObj, expectedDecision, expectedReasonSubstr = null) {
      const payloadStr = JSON.stringify(payloadObj);
      const nodeRes = runNode('scripts/hooks/enforce_allowlist.js', [], payloadStr, cleanEnv);
      const pyRes = runPython('scripts/hooks/enforce_allowlist.py', [], payloadStr, cleanEnv);
      assert.strictEqual(nodeRes.code, 0, `${label}: Node should exit code 0`);
      assert.strictEqual(pyRes.code, 0, `${label}: Python should exit code 0`);

      const nodeJson = JSON.parse(nodeRes.stdout);
      const pyJson = JSON.parse(pyRes.stdout);

      assert.strictEqual(nodeJson.decision, expectedDecision, `${label}: Node decision should be ${expectedDecision}`);
      assert.strictEqual(pyJson.decision, expectedDecision, `${label}: Python decision should be ${expectedDecision}`);
      assert.strictEqual(nodeJson.decision, pyJson.decision, `${label}: Decision parity mismatch`);

      if (expectedReasonSubstr) {
        assert.ok(
          nodeJson.reason && nodeJson.reason.includes(expectedReasonSubstr),
          `${label}: Node reason should include "${expectedReasonSubstr}", got: ${nodeJson.reason}`
        );
        assert.ok(
          pyJson.reason && pyJson.reason.includes(expectedReasonSubstr),
          `${label}: Python reason should include "${expectedReasonSubstr}", got: ${pyJson.reason}`
        );
      }
    }

    // 2.1 registered main (allow)
    runAllowlistCheck(
      'registered main (allow)',
      {
        vendor: 'antigravity',
        conversationId: 'main-thread-uuid-1234',
        workspacePaths: [fixtureDir],
        toolCall: {
          name: 'replace_file_content',
          args: { TargetFile: path.join(fixtureDir, 'AGENTS.md') }
        }
      },
      'allow'
    );

    // 2.2 registered topic + allowlist (allow)
    runAllowlistCheck(
      'registered topic + allowlist (allow)',
      {
        vendor: 'antigravity',
        conversationId: 'hook-topic-uuid-5678',
        workspacePaths: [fixtureDir],
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: path.join(fixtureDir, 'scripts', 'hooks', 'test.js') }
        }
      },
      'allow'
    );

    // 2.3 registered topic + non-allowlist (deny)
    runAllowlistCheck(
      'registered topic + non-allowlist (deny)',
      {
        vendor: 'antigravity',
        conversationId: 'hook-topic-uuid-5678',
        workspacePaths: [fixtureDir],
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: path.join(fixtureDir, 'src', 'forbidden.js') }
        }
      },
      'deny',
      '不在当前任务白名单'
    );

    // 2.4 unregistered session (deny)
    runAllowlistCheck(
      'unregistered (deny)',
      {
        vendor: 'antigravity',
        conversationId: 'unregistered-uuid-0000',
        workspacePaths: [fixtureDir],
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: path.join(fixtureDir, 'scripts', 'hooks', 'test.js') }
        }
      },
      'deny',
      'is missing, unregistered, or mismatched'
    );

    // 2.5 vendor mismatch (deny)
    runAllowlistCheck(
      'vendor mismatch (deny)',
      {
        vendor: 'zcode',
        conversationId: 'hook-topic-uuid-5678',
        workspacePaths: [fixtureDir],
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: path.join(fixtureDir, 'scripts', 'hooks', 'test.js') }
        }
      },
      'deny',
      'is missing, unregistered, or mismatched'
    );

    // 2.6 missing session id (deny)
    runAllowlistCheck(
      'missing session id (deny)',
      {
        vendor: 'antigravity',
        workspacePaths: [fixtureDir],
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: path.join(fixtureDir, 'scripts', 'hooks', 'test.js') }
        }
      },
      'deny',
      'file writes require a registered session'
    );

    // 3. Parity Check: inject_session_context Hook Output Shape
    console.log('  Testing inject_session_context Hook parity...');
    const injectPayload = JSON.stringify({
      vendor: 'antigravity',
      conversationId: 'hook-topic-uuid-5678',
      workspacePaths: [fixtureDir],
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
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

runParityTests();
