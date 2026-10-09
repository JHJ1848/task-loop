#!/usr/bin/env node
/**
 * [Test Suite] test_async_parallel_dispatch.test.js
 * 
 * Validates the Orthogonal Async Parallel Dispatch & Verification Queue Protocol:
 * 1. Orthogonality 3-Criteria Assertion (Session isolation, Allowlist disjoint, Dependency decoupled)
 * 2. Concurrency Limit (<= 3) & Serial Fallback
 * 3. In-Context Verification Queue FIFO Lifecycle (Enqueue, Dequeue, Independent Review)
 * 4. Isolated DELIVERABLE_REJECTED arbitration
 * 5. Prompt Templates & Contract Rules Parity Check
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running test_async_parallel_dispatch.test.js...');

// ============================================================================
// 1. Orthogonality Evaluation Logic
// ============================================================================

function normalizePath(p) {
  return p.replace(/\\/g, '/').toLowerCase().trim();
}

function isAllowlistOrthogonal(listA, listB) {
  if (!Array.isArray(listA) || !Array.isArray(listB)) return false;
  const setA = new Set(listA.map(normalizePath));
  for (const item of listB) {
    if (setA.has(normalizePath(item))) {
      return false; // Intersection found
    }
  }
  return true;
}

function checkOrthogonality(taskA, taskB) {
  // Criterion 1: Target Session Isolation
  if (!taskA.target_session_id || !taskB.target_session_id) {
    return { orthogonal: false, reason: 'Missing target session id' };
  }
  if (taskA.target_session_id === taskB.target_session_id) {
    return { orthogonal: false, reason: 'Target sessions are identical (violates intra-topic serial rule)' };
  }

  // Criterion 2: Allowlist Orthogonality (Disjoint)
  if (!isAllowlistOrthogonal(taskA.allowlist || [], taskB.allowlist || [])) {
    return { orthogonal: false, reason: 'Allowlists have intersecting physical files' };
  }

  // Criterion 3: Logic & Data Decoupled
  const depsA = Array.isArray(taskA.dependencies) ? taskA.dependencies : [];
  const depsB = Array.isArray(taskB.dependencies) ? taskB.dependencies : [];
  if (depsA.includes(taskB.id) || depsB.includes(taskA.id)) {
    return { orthogonal: false, reason: 'Inter-task dependency detected' };
  }

  return { orthogonal: true, reason: null };
}

function evaluateParallelBatch(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { can_parallel: false, reason: 'Empty tasks' };
  }
  if (tasks.length === 1) {
    return { can_parallel: true, mode: 'single', reason: 'Single task' };
  }
  if (tasks.length > 3) {
    return { can_parallel: false, mode: 'serial_fallback', reason: 'Exceeds max concurrency limit (<= 3)' };
  }

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const res = checkOrthogonality(tasks[i], tasks[j]);
      if (!res.orthogonal) {
        return {
          can_parallel: false,
          mode: 'serial_fallback',
          reason: `Tasks ${tasks[i].id} and ${tasks[j].id} not orthogonal: ${res.reason}`
        };
      }
    }
  }

  return { can_parallel: true, mode: 'async_parallel', reason: 'All pairs satisfied 3 orthogonality criteria' };
}

// ============================================================================
// 2. In-Context Verification Queue FIFO Implementation
// ============================================================================

class VerificationQueue {
  constructor() {
    this.queue = [];
    this.reviewed = [];
    this.rejected = [];
  }

  enqueue(deliverable) {
    this.queue.push({
      ...deliverable,
      enqueued_at: Date.now(),
      status: 'pending_review'
    });
  }

  dequeue() {
    return this.queue.shift() || null;
  }

  size() {
    return this.queue.length;
  }

  reviewDeliverable(deliverable, isPass, rejectionReason = null) {
    if (isPass) {
      this.reviewed.push({
        task_id: deliverable.task_id,
        session_id: deliverable.session_id,
        status: 'accepted',
        reviewed_at: Date.now()
      });
      return { action: 'ACCEPTED', task_id: deliverable.task_id };
    } else {
      this.rejected.push({
        task_id: deliverable.task_id,
        session_id: deliverable.session_id,
        status: 'rejected',
        reason: rejectionReason,
        rejected_at: Date.now()
      });
      return {
        action: 'DELIVERABLE_REJECTED',
        task_id: deliverable.task_id,
        recipient: deliverable.session_id,
        reason: rejectionReason
      };
    }
  }
}

// ============================================================================
// 3. Tests Execution
// ============================================================================

// Test Case 1: Positive Orthogonal Pair (Disjoint Sessions & Allowlist & No Deps)
const taskHook = {
  id: 'task-hook-01',
  target_session_id: 'session-hook-uuid',
  allowlist: ['scripts/hooks/inject_session_context.js', 'scripts/hooks/enforce_allowlist.js'],
  dependencies: []
};

const taskSessionCtrl = {
  id: 'task-sess-01',
  target_session_id: 'session-ctrl-uuid',
  allowlist: ['scripts/providers/session_provider.js', 'references/sdk/session.md'],
  dependencies: []
};

const taskPluginSpec = {
  id: 'task-plugin-01',
  target_session_id: 'session-plugin-uuid',
  allowlist: ['scripts/install_agy_plugin.js', 'rules/task-loop-governance.md'],
  dependencies: []
};

const batch3Orthogonal = [taskHook, taskSessionCtrl, taskPluginSpec];
const eval3 = evaluateParallelBatch(batch3Orthogonal);
assert.strictEqual(eval3.can_parallel, true);
assert.strictEqual(eval3.mode, 'async_parallel');
console.log('✔ Positive 3-Orthogonal Batch PASSED!');

// Test Case 2: Negative - Same Target Session (Intra-topic conflict)
const taskHook2 = {
  id: 'task-hook-02',
  target_session_id: 'session-hook-uuid', // same as taskHook
  allowlist: ['scripts/hooks/host_vendor.js'],
  dependencies: []
};

const evalSameSession = evaluateParallelBatch([taskHook, taskHook2]);
assert.strictEqual(evalSameSession.can_parallel, false);
assert.strictEqual(evalSameSession.mode, 'serial_fallback');
assert.ok(evalSameSession.reason.includes('intra-topic serial rule'));
console.log('✔ Intra-topic Same Session Serial Fallback PASSED!');

// Test Case 3: Negative - Intersecting Allowlist (File write collision)
const taskOverlap = {
  id: 'task-overlap-01',
  target_session_id: 'session-overlap-uuid',
  allowlist: ['scripts/hooks/inject_session_context.js', 'other/file.js'],
  dependencies: []
};

const evalOverlap = evaluateParallelBatch([taskHook, taskOverlap]);
assert.strictEqual(evalOverlap.can_parallel, false);
assert.strictEqual(evalOverlap.mode, 'serial_fallback');
assert.ok(evalOverlap.reason.includes('intersecting physical files'));
console.log('✔ Intersecting Allowlist Collision Serial Fallback PASSED!');

// Test Case 4: Negative - Dependency Detected
const taskWithDep = {
  id: 'task-dep-01',
  target_session_id: 'session-dep-uuid',
  allowlist: ['some/independent/file.js'],
  dependencies: ['task-hook-01']
};

const evalDep = evaluateParallelBatch([taskHook, taskWithDep]);
assert.strictEqual(evalDep.can_parallel, false);
assert.strictEqual(evalDep.mode, 'serial_fallback');
assert.ok(evalDep.reason.includes('dependency detected'));
console.log('✔ Task Dependency Serial Fallback PASSED!');

// Test Case 5: Negative - Concurrency Limit Exceeded (> 3)
const task4 = {
  id: 'task-4',
  target_session_id: 'session-4',
  allowlist: ['file4.js'],
  dependencies: []
};
const evalExceed = evaluateParallelBatch([taskHook, taskSessionCtrl, taskPluginSpec, task4]);
assert.strictEqual(evalExceed.can_parallel, false);
assert.strictEqual(evalExceed.mode, 'serial_fallback');
assert.ok(evalExceed.reason.includes('max concurrency limit'));
console.log('✔ Max Concurrency Limit (> 3) Serial Fallback PASSED!');

// Test Case 6: Verification Queue FIFO & Isolated Rejection
const vQueue = new VerificationQueue();

vQueue.enqueue({ task_id: 'task-hook-01', session_id: 'session-hook-uuid', changes: ['inject_session_context.js'] });
vQueue.enqueue({ task_id: 'task-sess-01', session_id: 'session-ctrl-uuid', changes: ['session_provider.js'] });
vQueue.enqueue({ task_id: 'task-plugin-01', session_id: 'session-plugin-uuid', changes: ['install_agy_plugin.js'] });

assert.strictEqual(vQueue.size(), 3);

// Dequeue 1: task-hook-01 (Passed)
const item1 = vQueue.dequeue();
assert.strictEqual(item1.task_id, 'task-hook-01');
const review1 = vQueue.reviewDeliverable(item1, true);
assert.strictEqual(review1.action, 'ACCEPTED');

// Dequeue 2: task-sess-01 (Failed - Missing comment traceability)
const item2 = vQueue.dequeue();
assert.strictEqual(item2.task_id, 'task-sess-01');
const review2 = vQueue.reviewDeliverable(item2, false, '门禁2未过: 缺失代码改动溯源注释');
assert.strictEqual(review2.action, 'DELIVERABLE_REJECTED');
assert.strictEqual(review2.recipient, 'session-ctrl-uuid');

// Dequeue 3: task-plugin-01 (Passed)
const item3 = vQueue.dequeue();
assert.strictEqual(item3.task_id, 'task-plugin-01');
const review3 = vQueue.reviewDeliverable(item3, true);
assert.strictEqual(review3.action, 'ACCEPTED');

// Queue should now be empty, 2 accepted, 1 rejected
assert.strictEqual(vQueue.size(), 0);
assert.strictEqual(vQueue.reviewed.length, 2);
assert.strictEqual(vQueue.rejected.length, 1);
assert.strictEqual(vQueue.rejected[0].task_id, 'task-sess-01');
console.log('✔ In-Context Verification Queue FIFO & Isolated Rejection PASSED!');

// Test Case 7: Prompt Templates Parity Check
const rootDir = path.resolve(__dirname, '..');
const promptTemplatesPath = path.join(rootDir, 'templates', 'prompt_templates.json');
assert.ok(fs.existsSync(promptTemplatesPath), 'prompt_templates.json must exist');
const promptData = JSON.parse(fs.readFileSync(promptTemplatesPath, 'utf8'));
const mainRules = promptData.plugin_rules.main_session;

const rule12 = mainRules.find(r => r.includes('12. 正交多专题异步并行派单与反馈验收队列机制'));
assert.ok(rule12, 'Rule 12 must exist in prompt_templates.json');
assert.ok(rule12.includes('专题隔离'), 'Rule 12 must contain criterion 1');
assert.ok(rule12.includes('白名单正交'), 'Rule 12 must contain criterion 2');
assert.ok(rule12.includes('逻辑解耦'), 'Rule 12 must contain criterion 3');
assert.ok(rule12.includes('并发度上限 <= 3'), 'Rule 12 must specify concurrency cap');
assert.ok(rule12.includes('反馈验收队列 (FIFO)'), 'Rule 12 must specify FIFO queue');
console.log('✔ Prompt Templates Rule 12 Parity PASSED!');

console.log('ALL Async Parallel Dispatch & Verification Queue Tests PASSED SUCCESSFULLY!');
