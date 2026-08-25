#!/usr/bin/env node
/**
 * Test Task Loop Preflight (Node.js)
 * Evaluates whether current queue item is eligible for dispatch (1/2/3 complexity aware).
 */

const fs = require('fs');
const path = require('path');

function preflight({
  todoPath = null,
  registryPath = null,
  policyPath = null,
  leasePath = null,
  projectRoot = '.'
} = {}) {
  const root = path.resolve(projectRoot);
  let runtime = path.join(root, '.agents', 'task-loop');
  if (!fs.existsSync(runtime)) {
    runtime = path.join(root, '.codex', 'task-loop');
  }

  const todoFile = todoPath ? (path.isAbsolute(todoPath) ? todoPath : path.join(root, todoPath)) : path.join(runtime, 'todo.json');
  const leaseFile = leasePath ? (path.isAbsolute(leasePath) ? leasePath : path.join(root, leasePath)) : path.join(runtime, 'lease.json');

  if (!fs.existsSync(todoFile)) {
    return { action: 'NOOP', reason: 'no_todo_items' };
  }

  let todo;
  try {
    todo = JSON.parse(fs.readFileSync(todoFile, 'utf8'));
  } catch (e) {
    return { action: 'INVALID', reason: `todo_parse_error: ${e.message}` };
  }

  // Check active lease
  if (leaseFile && fs.existsSync(leaseFile)) {
    try {
      const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
      if (lease.expires_at) {
        const expDate = new Date(lease.expires_at);
        if (expDate > new Date()) {
          return {
            action: 'NOOP',
            reason: 'active_lease_held',
            active_task: lease.task_id,
            run_id: lease.run_id
          };
        }
      }
    } catch (e) {}
  }

  const items = todo.items || [];
  const activeItems = items.filter(i => i.state !== 'done' && i.state !== 'cancelled');
  if (activeItems.length === 0) {
    return { action: 'NOOP', reason: 'queue_empty' };
  }

  const firstItem = activeItems[0];
  const state = firstItem.state;
  const confirmation = firstItem.confirmation;

  if (state === 'ready' && confirmation === 'approved') {
    const goal = firstItem.agent_goal || {};
    return {
      action: 'DISPATCH',
      reason: 'eligible',
      item_id: firstItem.id,
      complexity: goal.complexity || 2
    };
  } else if (['needs_normalization', 'planning', 'awaiting_user_input', 'awaiting_user_confirmation'].includes(state)) {
    return {
      action: 'DISCUSS',
      reason: 'pending_discussion',
      item_id: firstItem.id,
      state: state
    };
  }

  return {
    action: 'NOOP',
    reason: 'item_in_progress',
    item_id: firstItem.id,
    state: state
  };
}

function main() {
  const args = process.argv.slice(2);
  let todo = null;
  let registry = null;
  let policy = null;
  let lease = null;
  let root = '.';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--todo' && args[i + 1]) todo = args[++i];
    else if (args[i] === '--registry' && args[i + 1]) registry = args[++i];
    else if (args[i] === '--policy' && args[i + 1]) policy = args[++i];
    else if (args[i] === '--lease' && args[i + 1]) lease = args[++i];
    else if (args[i] === '--root' && args[i + 1]) root = args[++i];
    else if (!args[i].startsWith('-')) root = args[i];
  }

  const result = preflight({
    todoPath: todo,
    registryPath: registry,
    policyPath: policy,
    leasePath: lease,
    projectRoot: root
  });

  console.log(JSON.stringify(result));
  if (result.action === 'INVALID') process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = { preflight };
