const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { inferTopicMapping, initTaskLoop } = require('../scripts/init_task_loop');

function runInitSkillTests() {
  console.log('--- Running test_init_task_loop.test.js ---');

  // Test 1: inferTopicMapping standardization
  const mockMain = { session_id: 'ee94b2c5-c0c2-473f-8f71-213250ba5295', title: '当前项目作为开发仓库', is_main: true };
  const mappedMain = inferTopicMapping(mockMain);
  assert.strictEqual(mappedMain.module_key, 'main');
  assert.strictEqual(mappedMain.topic_name, '[主会话] 任务编排 & 治理中枢');

  const mockHook = { session_id: '22345678-0000-0000-0000-000000000000', title: 'Hook 拦截与状态防护', summary: 'hook lifecycle' };
  const mappedHook = inferTopicMapping(mockHook);
  assert.strictEqual(mappedHook.module_key, 'hook');
  assert.strictEqual(mappedHook.topic_name, '[钩子专题] 生命周期 & 安全门禁');

  const mockSubagent = { session_id: '32345678-0000-0000-0000-000000000000', title: 'Subagent 并行与模板', summary: 'subagent workers' };
  const mappedSubagent = inferTopicMapping(mockSubagent);
  assert.strictEqual(mappedSubagent.module_key, 'subagent');
  assert.strictEqual(mappedSubagent.topic_name, '[子代理专题] 动态模板 & 编排治理');

  const mockSession = { session_id: '42345678-0000-0000-0000-000000000000', title: '跨厂商会话内省', summary: 'session_control introspection' };
  const mappedSession = inferTopicMapping(mockSession);
  assert.strictEqual(mappedSession.module_key, 'session_control');
  assert.strictEqual(mappedSession.topic_name, '[会话控制专题] 跨厂商内省 & 会话管理');

  // Test 2: initTaskLoop dry-run mode
  const dryRunRes = initTaskLoop({ dryRun: true });
  assert.ok(dryRunRes.workspace_root);
  assert.ok(dryRunRes.storage_files.sessions_json);
  assert.ok(Array.isArray(dryRunRes.topic_mapping_suggestions));
  assert.ok(Array.isArray(dryRunRes.memory_alignment));

  // Test 3: initTaskLoop in isolated temporary workspace
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'task_loop_init_test_'));
  const tmpMemoryDir = path.join(tmpWs, 'docs', 'memory');
  fs.mkdirSync(tmpMemoryDir, { recursive: true });
  fs.writeFileSync(path.join(tmpMemoryDir, 'test_module.md'), '# Test Module Memory', 'utf8');

  const liveRes = initTaskLoop({ wsRoot: tmpWs, dryRun: false });
  assert.ok(fs.existsSync(liveRes.storage_files.sessions_json));
  assert.ok(fs.existsSync(liveRes.storage_files.topics_json));
  assert.ok(fs.existsSync(liveRes.storage_files.todo_json));
  assert.ok(fs.existsSync(liveRes.storage_files.policy_json));

  const savedSessions = JSON.parse(fs.readFileSync(liveRes.storage_files.sessions_json, 'utf8'));
  assert.strictEqual(savedSessions.schema_version, 2);

  // Cleanup tmpWs
  fs.rmSync(tmpWs, { recursive: true, force: true });

  console.log('✔ All /init skill Node.js tests PASSED!');
}

runInitSkillTests();
