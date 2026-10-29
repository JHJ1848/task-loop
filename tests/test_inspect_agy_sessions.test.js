#!/usr/bin/env node
/**
 * Test suite for inspect_agy_sessions.js (Node.js)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { inspectAgySessions, probeDispatchSession, formatRelativeTime, checkAgentApiRpc, fetchSessionTranscript } = require('../scripts/inspect_agy_sessions');

function runTest() {
  console.log('Running test_inspect_agy_sessions.test.js...');

  // Test 1: formatRelativeTime
  const now = new Date();
  const tenSecAgo = new Date(now.getTime() - 10 * 1000).toISOString();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400 * 1000).toISOString();

  assert.strictEqual(formatRelativeTime(tenSecAgo), '10 秒前');
  assert.strictEqual(formatRelativeTime(fiveMinAgo), '5 分钟前');
  assert.strictEqual(formatRelativeTime(twoHoursAgo), '2 小时前');
  assert.strictEqual(formatRelativeTime(twoDaysAgo), '2 天前');

  // Test 2: Mock filesystem inspection
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inspect-test-'));
  const tempBrain = path.join(tempDir, 'brain');
  const tempProject = path.join(tempDir, 'project');
  fs.mkdirSync(tempBrain, { recursive: true });
  fs.mkdirSync(path.join(tempProject, '.agents', 'task-loop'), { recursive: true });

  const mainId = '11111111-1111-1111-1111-111111111111';
  const topicId = '22222222-2222-2222-2222-222222222222';
  const unrelatedId = '33333333-3333-3333-3333-333333333333';

  // Write sessions.antigravity.json
  const registryData = {
    schema_version: 3,
    vendor: 'antigravity',
    main_thread_id: mainId,
    modules: {
      main: {
        session_id: mainId,
        title: '[主会话] 任务编排',
        memory_doc: 'docs/MEMORY.md'
      },
      topic_demo: {
        session_id: topicId,
        title: '[专题] Demo 模块',
        memory_doc: 'docs/memory/demo.md'
      }
    },
    sessions: [
      {
        session_id: mainId,
        is_main: true,
        title: '[主会话] 任务编排',
        module_key: 'main',
        memory_docs: ['docs/MEMORY.md']
      },
      {
        session_id: topicId,
        is_main: false,
        title: '[专题] Demo 模块',
        module_key: 'topic_demo',
        memory_docs: ['docs/memory/demo.md']
      }
    ]
  };
  fs.writeFileSync(path.join(tempProject, '.agents', 'task-loop', 'sessions.antigravity.json'), JSON.stringify(registryData, null, 2), 'utf8');

  // Create main session log (active, 2 mins ago)
  const mainLogDir = path.join(tempBrain, mainId, '.system_generated', 'logs');
  fs.mkdirSync(mainLogDir, { recursive: true });
  const mainLogFile = path.join(mainLogDir, 'transcript.jsonl');
  const twoMinAgoIso = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  fs.writeFileSync(mainLogFile, [
    JSON.stringify({ type: 'USER_INPUT', content: 'Hello in project ' + tempProject, created_at: twoMinAgoIso }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Step 1', created_at: twoMinAgoIso })
  ].join('\n'), 'utf8');

  // Create topic session log (sleeping, 2 hours ago)
  const topicLogDir = path.join(tempBrain, topicId, '.system_generated', 'logs');
  fs.mkdirSync(topicLogDir, { recursive: true });
  const topicLogFile = path.join(topicLogDir, 'transcript.jsonl');
  fs.writeFileSync(topicLogFile, [
    JSON.stringify({ type: 'USER_INPUT', content: '[主会话派单任务: WORK] in ' + tempProject, created_at: twoHoursAgo }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Done work', created_at: twoHoursAgo })
  ].join('\n'), 'utf8');

  // Create unrelated session log (unrelated path)
  const unrelatedLogDir = path.join(tempBrain, unrelatedId, '.system_generated', 'logs');
  fs.mkdirSync(unrelatedLogDir, { recursive: true });
  const unrelatedLogFile = path.join(unrelatedLogDir, 'transcript.jsonl');
  fs.writeFileSync(unrelatedLogFile, [
    JSON.stringify({ type: 'USER_INPUT', content: 'Other project /path/to/other', created_at: twoMinAgoIso })
  ].join('\n'), 'utf8');

  // Inspect
  const report = inspectAgySessions({
    root: tempProject,
    brainPath: tempBrain,
    activeWindow: 30
  });

  assert.strictEqual(report.total, 2, 'Should only discover 2 sessions belonging to the project');
  assert.strictEqual(report.active_count, 1, 'Should have 1 active session');
  assert.strictEqual(report.sleeping_count, 1, 'Should have 1 sleeping session');

  const mainSess = report.sessions.find(s => s.session_id === mainId);
  assert.ok(mainSess, 'Main session should be present');
  assert.strictEqual(mainSess.is_main, true);
  assert.strictEqual(mainSess.status, 'ACTIVE');
  assert.strictEqual(mainSess.deep_link, `conversation://${mainId}`);

  const topicSess = report.sessions.find(s => s.session_id === topicId);
  assert.ok(topicSess, 'Topic session should be present');
  assert.strictEqual(topicSess.is_main, false);
  assert.strictEqual(topicSess.status, 'IDLE_SLEEPING');
  assert.strictEqual(topicSess.deep_link, `conversation://${topicId}`);

  // Test 3: probeDispatchSession true/false activation probe
  const dormantSessId = '44444444-4444-4444-4444-444444444444';
  const dormantLogDir = path.join(tempBrain, dormantSessId, '.system_generated', 'logs');
  fs.mkdirSync(dormantLogDir, { recursive: true });
  const dormantLogFile = path.join(dormantLogDir, 'transcript.jsonl');
  // Only sidebus dispatch message appended, no MODEL step
  fs.writeFileSync(dormantLogFile, [
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Initial message', created_at: twoHoursAgo }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Initial response', created_at: twoHoursAgo }),
    JSON.stringify({ type: 'USER_INPUT', source: 'SYSTEM', content: '[主会话派单任务: WORK (测试任务)] 请执行修复', created_at: new Date().toISOString() })
  ].join('\n'), 'utf8');

  const { probeDispatchSession } = require('../scripts/inspect_agy_sessions');
  const dormantProbe = probeDispatchSession(dormantSessId, { brainPath: tempBrain });
  assert.strictEqual(dormantProbe.found, true);
  assert.strictEqual(dormantProbe.thread_running, false);
  assert.strictEqual(dormantProbe.is_working, false, 'Session with no MODEL step after dispatch should NOT be working');
  assert.strictEqual(dormantProbe.can_enter_120s_gate, false, 'Dormant session must NOT enter 120s gate');
  assert.strictEqual(dormantProbe.should_loop_30s_probe, true, 'Dormant session must continue 30s probe loop');
  assert.strictEqual(dormantProbe.working_status, 'DORMANT_NOT_ACTIVATED');
  assert.strictEqual(dormantProbe.model_steps_count, 0);
  assert.ok(dormantProbe.alert_card && dormantProbe.alert_card.includes('🔴 专题未激活告警卡'));

  // Test 4: IN_PROGRESS streaming generation state detection
  const inProgSessId = '55555555-5555-5555-5555-555555555555';
  const inProgDir = path.join(tempBrain, inProgSessId, '.system_generated', 'logs');
  fs.mkdirSync(inProgDir, { recursive: true });
  const inProgFile = path.join(inProgDir, 'transcript.jsonl');
  fs.writeFileSync(inProgFile, [
    JSON.stringify({ type: 'USER_INPUT', source: 'SYSTEM', content: '[主会话派单任务: WORK] 开始执行', created_at: new Date().toISOString() }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'IN_PROGRESS', thinking: 'Currently thinking in flight...', created_at: new Date().toISOString() })
  ].join('\n'), 'utf8');

  const inProgProbe = probeDispatchSession(inProgSessId, { brainPath: tempBrain });
  assert.strictEqual(inProgProbe.found, true);
  assert.strictEqual(inProgProbe.thread_running, true, 'IN_PROGRESS step must set thread_running to true');
  assert.strictEqual(inProgProbe.is_working, true, 'IN_PROGRESS step must set is_working to true');
  assert.strictEqual(inProgProbe.can_enter_120s_gate, true, 'IN_PROGRESS step must allow 120s gate admission');
  assert.strictEqual(inProgProbe.should_loop_30s_probe, false);
  assert.strictEqual(inProgProbe.in_progress_steps_count, 1);
  assert.strictEqual(inProgProbe.thinking_steps_count, 1);
  assert.strictEqual(inProgProbe.alert_card, null);

  // Now append a completed MODEL step to simulate full turn
  fs.appendFileSync(dormantLogFile, '\n' + JSON.stringify({
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    status: 'DONE',
    thinking: 'Analyzing task...',
    tool_calls: [{ name: 'view_file', args: {} }],
    created_at: new Date().toISOString()
  }), 'utf8');

  const activeProbe = probeDispatchSession(dormantSessId, { brainPath: tempBrain });
  assert.strictEqual(activeProbe.found, true);
  assert.strictEqual(activeProbe.is_working, true, 'Session with MODEL step after dispatch SHOULD be working');
  assert.strictEqual(activeProbe.can_enter_120s_gate, true, 'Active session allows 120s gate admission');
  assert.strictEqual(activeProbe.should_loop_30s_probe, false);
  assert.strictEqual(activeProbe.working_status, 'WORKING_IN_PROGRESS');
  assert.strictEqual(activeProbe.model_steps_count, 1);
  assert.strictEqual(activeProbe.tool_calls_count, 1);
  assert.strictEqual(activeProbe.thinking_steps_count, 1);
  assert.strictEqual(activeProbe.alert_card, null);

  // Test 5: 彻底根除历史旧步骤（如 3 天前）产生的假阳性绿灯 (Stale history step false-positive elimination)
  const staleSessId = '66666666-6666-6666-6666-666666666666';
  const staleDir = path.join(tempBrain, staleSessId, '.system_generated', 'logs');
  fs.mkdirSync(staleDir, { recursive: true });
  const staleFile = path.join(staleDir, 'transcript.jsonl');
  const threeDaysAgoIso = new Date(now.getTime() - 3 * 86400 * 1000).toISOString();
  // 会话中有历史 MODEL 步骤，但在 3 天前产生；新派单后专题会话实际休眠未激活
  fs.writeFileSync(staleFile, [
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Old conversation', created_at: threeDaysAgoIso }),
    JSON.stringify({ type: 'USER_INPUT', source: 'SYSTEM', content: '[主会话派单任务: WORK] 3天前下发的任务', created_at: threeDaysAgoIso }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', thinking: '3天前的旧响应', created_at: threeDaysAgoIso })
  ].join('\n'), 'utf8');

  // 物理修改文件 mtime 为 3 天前
  const threeDaysAgoDate = new Date(now.getTime() - 3 * 86400 * 1000);
  fs.utimesSync(staleFile, threeDaysAgoDate, threeDaysAgoDate);

  const staleProbe = probeDispatchSession(staleSessId, { brainPath: tempBrain, freshWindowSec: 30, skipRpc: true });
  assert.strictEqual(staleProbe.found, true);
  assert.strictEqual(staleProbe.is_working, false, '3-day-old step must NOT be considered is_working (False Positive Eliminated!)');
  assert.strictEqual(staleProbe.can_enter_gate, false, 'Stale session must NOT enter gate');
  assert.strictEqual(staleProbe.can_enter_120s_gate, false);
  assert.strictEqual(staleProbe.should_loop_probe, true);
  assert.strictEqual(staleProbe.dimensions.inference_step.is_fresh, false, 'Inference step must be flagged is_fresh: false');
  assert.ok(staleProbe.dimensions.inference_step.step_age_sec > 86400, 'Step age must be > 1 day');
  assert.ok(staleProbe.alert_card && staleProbe.alert_card.includes('🔴 专题未激活告警卡'));

  // Test 6: 4维物理交叉验证指标健全性 (Presence 在场锁 + 文件增量)
  const presenceMockDir = path.join(tempDir, 'presence');
  fs.mkdirSync(presenceMockDir, { recursive: true });
  const lockFilePath = path.join(presenceMockDir, `${staleSessId}.lock`);
  fs.writeFileSync(lockFilePath, 'active_gui_window', 'utf8');

  // 当存在在场锁但文件无近期写入时，仍未工作
  const presenceOnlyProbe = probeDispatchSession(staleSessId, { brainPath: tempBrain, presencePath: presenceMockDir, skipRpc: true });
  assert.strictEqual(presenceOnlyProbe.dimensions.presence.is_present, true, 'Presence lock should be detected');
  assert.strictEqual(presenceOnlyProbe.dimensions.filesystem.has_recent_write, false, 'Old file should not have recent write');
  assert.strictEqual(presenceOnlyProbe.is_working, false, 'Presence alone without recent write is not working');

  // 当在场锁存在 + 文件发生新鲜物理写入 (近 10s 内更新)
  const freshWriteTime = new Date().toISOString();
  fs.appendFileSync(staleFile, '\n' + JSON.stringify({
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    content: 'User typed in foreground window',
    created_at: freshWriteTime
  }), 'utf8');

  const activePresenceProbe = probeDispatchSession(staleSessId, { brainPath: tempBrain, presencePath: presenceMockDir, skipRpc: true });
  assert.strictEqual(activePresenceProbe.dimensions.presence.is_present, true);
  assert.strictEqual(activePresenceProbe.dimensions.filesystem.has_recent_write, true, 'Recent write should be detected');
  assert.strictEqual(activePresenceProbe.is_working, true, 'Presence + Recent Write should validate working state');
  assert.strictEqual(activePresenceProbe.can_enter_gate, true);

  // Test 7: Windows 环境下 RPC 探测 EINVAL 根除验证与保护性连通性
  const skippedRpc = checkAgentApiRpc(staleSessId, { skipRpc: true });
  assert.strictEqual(skippedRpc.skipped, true);
  assert.strictEqual(skippedRpc.available, true);

  const realRpc = checkAgentApiRpc(staleSessId);
  assert.ok(typeof realRpc.available === 'boolean');
  if (realRpc.error) {
    assert.strictEqual(realRpc.error.includes('EINVAL'), false, 'RPC probe must NOT fail with EINVAL on Windows');
  }

  // Test 8: 转录内省原语 fetchSessionTranscript 与 recent_trajectory 校验
  const transcriptTestId = '77777777-7777-7777-7777-777777777777';
  const tDir = path.join(tempBrain, transcriptTestId, '.system_generated', 'logs');
  fs.mkdirSync(tDir, { recursive: true });
  const tFile = path.join(tDir, 'transcript.jsonl');
  fs.writeFileSync(tFile, [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Step 0 user query', created_at: '2026-10-16T01:00:00Z' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', thinking: 'Deep thoughts step 1', content: 'Model answer 1', created_at: '2026-10-16T01:01:00Z' }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      thinking: 'Deep thoughts step 2 with long reasoning analysis',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      content: 'Executing command...',
      created_at: '2026-10-16T01:02:00Z'
    })
  ].join('\n'), 'utf8');

  const introspectRes = fetchSessionTranscript(transcriptTestId, { brainPath: tempBrain, tail: 2 });
  assert.strictEqual(introspectRes.found, true);
  assert.strictEqual(introspectRes.total_steps, 3);
  assert.strictEqual(introspectRes.steps.length, 2);
  assert.strictEqual(introspectRes.steps[0].step_index, 1);
  assert.strictEqual(introspectRes.steps[1].step_index, 2);
  assert.strictEqual(introspectRes.steps[1].tool_calls.length, 1);
  assert.strictEqual(introspectRes.steps[1].tool_calls[0].name, 'run_command');
  assert.ok(introspectRes.steps[1].thinking_preview.includes('Deep thoughts step 2'));

  // probeDispatchSession 中 recent_trajectory 校验
  const probeWithTrajectory = probeDispatchSession(transcriptTestId, { brainPath: tempBrain, skipRpc: true });
  assert.ok(Array.isArray(probeWithTrajectory.recent_trajectory));
  assert.strictEqual(probeWithTrajectory.recent_trajectory.length, 3);
  assert.strictEqual(probeWithTrajectory.recent_trajectory[2].action_summary, 'tool_calls(run_command)');

  // 不存在会话测试
  const notFoundRes = fetchSessionTranscript('non-existent-uuid', { brainPath: tempBrain });
  assert.strictEqual(notFoundRes.found, false);
  assert.strictEqual(notFoundRes.steps.length, 0);
  assert.ok(notFoundRes.error);

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log('test_inspect_agy_sessions.test.js PASSED!');
}

runTest();
