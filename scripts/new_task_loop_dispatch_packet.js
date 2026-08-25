#!/usr/bin/env node
/**
 * New Task Loop Dispatch Packet (Node.js)
 * Generates 1/2/3 complexity-aware dispatch packets and safely acquires task lease.
 */

const fs = require('fs');
const path = require('path');
const { acquireLease } = require('./acquire_task_loop_lease');

function normalizeComplexity(val) {
  if (val === null || val === undefined) return 2;
  const s = String(val).trim().toLowerCase();
  if (s === '1' || s === 'simple') return 1;
  if (s === '3' || s === 'complex') return 3;
  return 2;
}

function createDispatchPacket(projectRoot, runId, targetThreadId) {
  const root = path.resolve(projectRoot);
  let runtime = path.join(root, '.agents', 'task-loop');
  if (!fs.existsSync(runtime)) {
    runtime = path.join(root, '.codex', 'task-loop');
  }

  const todoFile = path.join(runtime, 'todo.json');
  const registryFile = path.join(runtime, 'sessions.json');
  const leaseFile = path.join(runtime, 'lease.json');

  if (!fs.existsSync(todoFile) || !fs.existsSync(registryFile)) {
    return { action: 'INVALID', reason: 'required_state_files_missing' };
  }

  let todo;
  try {
    todo = JSON.parse(fs.readFileSync(todoFile, 'utf8'));
  } catch (e) {
    return { action: 'INVALID', reason: 'todo_json_corrupted' };
  }

  const items = todo.items || [];
  const active = items.filter(i => i.state !== 'done' && i.state !== 'cancelled');
  if (active.length === 0) {
    return { action: 'NOOP', reason: 'no_eligible_items' };
  }

  const item = active[0];
  const goal = item.agent_goal || {};

  const complexity = normalizeComplexity(goal.complexity);
  const subagentPolicyMap = { 1: 'none', 2: 'optional', 3: 'mandatory' };
  const executionModeMap = {
    1: 'single_thread_direct',
    2: 'standard_topic',
    3: 'subagent_orchestration_required'
  };

  const subagentPolicy = subagentPolicyMap[complexity];
  const executionMode = executionModeMap[complexity];

  const allowlist = goal.allowlist || ['*'];
  const criteria = goal.acceptance_criteria || [];
  const verification = goal.verification || [];

  const createdAt = new Date().toISOString();
  const packet = {
    schema_version: 2,
    task_id: item.id,
    run_id: runId,
    target_thread_id: targetThreadId,
    complexity: complexity,
    subagent_policy: subagentPolicy,
    execution_mode: executionMode,
    objective: goal.objective || '',
    allowlist: allowlist,
    acceptance_criteria: criteria,
    verification: verification,
    authorization: {
      change_intent: goal.change_intent || 'change',
      commit_policy: goal.commit_policy || 'local_commit',
      remote_push_allowed: false
    },
    created_at: createdAt
  };

  const dispatchDir = path.join(runtime, 'dispatch');
  if (!fs.existsSync(dispatchDir)) {
    fs.mkdirSync(dispatchDir, { recursive: true });
  }
  const packetPath = path.join(dispatchDir, `${runId}.json`);

  // Acquire lease
  const leaseRes = acquireLease(leaseFile, item.id, runId, 25);
  if (leaseRes.action === 'NOOP') {
    return leaseRes;
  }

  fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2), 'utf8');

  return {
    action: 'PREPARED',
    reason: 'dispatch_packet_created',
    run_id: runId,
    packet_path: path.relative(root, packetPath).replace(/\\/g, '/'),
    complexity: complexity,
    subagent_policy: subagentPolicy
  };
}

function main() {
  const args = process.argv.slice(2);
  let root = '.';
  let runId = null;
  let targetThreadId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = args[++i];
    else if (args[i] === '--run-id' && args[i + 1]) runId = args[++i];
    else if (args[i] === '--target-thread-id' && args[i + 1]) targetThreadId = args[++i];
  }

  if (!runId || !targetThreadId) {
    console.error('Missing required arguments: --run-id, --target-thread-id');
    process.exit(1);
  }

  const result = createDispatchPacket(root, runId, targetThreadId);
  console.log(JSON.stringify(result));
  if (result.action === 'INVALID') process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = { createDispatchPacket, normalizeComplexity };
