#!/usr/bin/env node
/**
 * Unit test for 1/2/3 Complexity Dispatch Packet (Node.js)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');

const { initState } = require('../scripts/initialize_task_loop_state');
const { createDispatchPacket } = require('../scripts/new_task_loop_dispatch_packet');
const { releaseLease } = require('../scripts/release_task_loop_lease');

function testComplexityDispatch() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_dispatch_js_'));
  try {
    const runtime = path.join(tempDir, '.agents', 'task-loop');
    initState({ rootPathStr: runtime, scanSessions: false });

    const todoFile = path.join(runtime, 'todo.json');
    const sessionsFile = path.join(runtime, 'sessions.json');
    const leaseFile = path.join(runtime, 'lease.json');

    const targetThread = crypto.randomUUID();
    const sessionsData = {
      schema_version: 1,
      main_thread_id: crypto.randomUUID(),
      modules: {
        workflow: {
          thread_id: targetThread,
          title: 'workflow-WorkflowModule'
        }
      }
    };
    fs.writeFileSync(sessionsFile, JSON.stringify(sessionsData, null, 2), 'utf8');

    for (const c of [1, 2, 3]) {
      const runId = crypto.randomUUID();
      const todoData = {
        schema_version: 2,
        items: [
          {
            id: `LOOP-00${c}`,
            state: 'ready',
            confirmation: 'approved',
            user_description: [{ text: `Test requirement ${c}` }],
            agent_goal: {
              complexity: c,
              module_keys: ['workflow'],
              objective: `Objective for level ${c}`,
              allowlist: ['src/*']
            }
          }
        ]
      };
      fs.writeFileSync(todoFile, JSON.stringify(todoData, null, 2), 'utf8');

      const res = createDispatchPacket(tempDir, runId, targetThread);
      assert.strictEqual(res.action, 'PREPARED', `Failed on level ${c}: ${JSON.stringify(res)}`);
      assert.strictEqual(res.complexity, c, `Complexity mismatch on level ${c}: ${JSON.stringify(res)}`);

      const expectedPolicy = { 1: 'none', 2: 'optional', 3: 'mandatory' }[c];
      assert.strictEqual(res.subagent_policy, expectedPolicy);

      const packetFile = path.join(tempDir, res.packet_path);
      const packet = JSON.parse(fs.readFileSync(packetFile, 'utf8'));
      assert.strictEqual(packet.subagent_policy, expectedPolicy);

      const rel = releaseLease(leaseFile, runId);
      assert.strictEqual(rel.action, 'RELEASED');

      console.log(`Node.js Complexity Level ${c} (${expectedPolicy}) Dispatch Test PASSED!`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testComplexityDispatch();
