#!/usr/bin/env node
/**
 * Acquire Task Loop Lease (Node.js)
 * Safely acquires a time-bounded atomic lease lock for dispatching tasks.
 */

const fs = require('fs');
const path = require('path');

function acquireLease(leasePathStr, taskId, runId, leaseMinutes = 25) {
  const leaseFile = path.resolve(leasePathStr);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMinutes * 60 * 1000).toISOString();

  if (fs.existsSync(leaseFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
      if (existing.run_id === runId) {
        return { action: 'LEASED', reason: 'lease_already_held', run_id: runId, task_id: taskId };
      }

      if (existing.expires_at) {
        const expDate = new Date(existing.expires_at);
        if (expDate > now) {
          return {
            action: 'NOOP',
            reason: 'lease_active_by_other',
            active_run_id: existing.run_id,
            expires_at: existing.expires_at
          };
        }
      }
    } catch (e) {}
  }

  const parentDir = path.dirname(leaseFile);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const leaseData = {
    task_id: taskId,
    run_id: runId,
    acquired_at: now.toISOString(),
    expires_at: expiresAt
  };

  fs.writeFileSync(leaseFile, JSON.stringify(leaseData, null, 2), 'utf8');
  return { action: 'LEASED', reason: 'lease_acquired', run_id: runId, expires_at: expiresAt };
}

function main() {
  const args = process.argv.slice(2);
  let leasePath = null;
  let taskId = null;
  let runId = null;
  let minutes = 25;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lease' && args[i + 1]) leasePath = args[++i];
    else if (args[i] === '--task-id' && args[i + 1]) taskId = args[++i];
    else if (args[i] === '--run-id' && args[i + 1]) runId = args[++i];
    else if (args[i] === '--minutes' && args[i + 1]) minutes = parseInt(args[++i], 10);
  }

  if (!leasePath || !taskId || !runId) {
    console.error('Missing required arguments: --lease, --task-id, --run-id');
    process.exit(1);
  }

  const result = acquireLease(leasePath, taskId, runId, minutes);
  console.log(JSON.stringify(result));
  if (result.action === 'INVALID') process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = { acquireLease };
