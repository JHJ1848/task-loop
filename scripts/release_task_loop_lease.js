#!/usr/bin/env node
/**
 * Release Task Loop Lease (Node.js)
 * Safely releases a lease lock held by a specific run ID.
 */

const fs = require('fs');
const path = require('path');

function releaseLease(leasePathStr, runId) {
  const leaseFile = path.resolve(leasePathStr);
  if (!fs.existsSync(leaseFile)) {
    return { action: 'RELEASED', reason: 'lease_file_not_found' };
  }

  try {
    const existing = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    if (existing.run_id === runId) {
      fs.unlinkSync(leaseFile);
      return { action: 'RELEASED', reason: 'lease_released', run_id: runId };
    } else {
      return { action: 'NOOP', reason: 'run_id_mismatch', held_by: existing.run_id };
    }
  } catch (e) {
    return { action: 'INVALID', reason: 'release_error', message: e.message };
  }
}

function main() {
  const args = process.argv.slice(2);
  let leasePath = null;
  let runId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lease' && args[i + 1]) leasePath = args[++i];
    else if (args[i] === '--run-id' && args[i + 1]) runId = args[++i];
  }

  if (!leasePath || !runId) {
    console.error('Missing required arguments: --lease, --run-id');
    process.exit(1);
  }

  const result = releaseLease(leasePath, runId);
  console.log(JSON.stringify(result));
  if (result.action === 'INVALID') process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = { releaseLease };
