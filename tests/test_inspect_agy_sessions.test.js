#!/usr/bin/env node
/**
 * Test suite for inspect_agy_sessions.js (Node.js)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { inspectAgySessions, formatRelativeTime } = require('../scripts/inspect_agy_sessions');

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
  assert.strictEqual(dormantProbe.is_working, false, 'Session with no MODEL step after dispatch should NOT be working');
  assert.strictEqual(dormantProbe.working_status, 'DORMANT_NOT_ACTIVATED');
  assert.strictEqual(dormantProbe.model_steps_count, 0);
  assert.ok(dormantProbe.alert_card && dormantProbe.alert_card.includes('🔴 专题未激活告警卡'));

  // Now append a MODEL step to simulate activation
  fs.appendFileSync(dormantLogFile, '\n' + JSON.stringify({
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    thinking: 'Analyzing task...',
    created_at: new Date().toISOString()
  }), 'utf8');

  const activeProbe = probeDispatchSession(dormantSessId, { brainPath: tempBrain });
  assert.strictEqual(activeProbe.found, true);
  assert.strictEqual(activeProbe.is_working, true, 'Session with MODEL step after dispatch SHOULD be working');
  assert.strictEqual(activeProbe.working_status, 'WORKING_IN_PROGRESS');
  assert.strictEqual(activeProbe.model_steps_count, 1);
  assert.strictEqual(activeProbe.alert_card, null);

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log('test_inspect_agy_sessions.test.js PASSED!');
}

runTest();
