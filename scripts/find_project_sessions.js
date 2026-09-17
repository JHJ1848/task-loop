#!/usr/bin/env node
/**
 * Find Project Sessions (Universal Scanner & Introspection Entrypoint - Node.js)
 * Aggregates sessions across Antigravity, Codex, and Claude Code.
 */

const fs = require('fs');
const path = require('path');
const stateStore = require('./task_loop_state');

const { scanAgySessions } = require('./providers/get_agy_project_sessions');
const { scanCodexSessions, getCurrentSessionMetadata } = require('./providers/get_codex_project_sessions');
const { scanClaudeSessions } = require('./providers/get_claude_project_sessions');
const { scanZcodeSessions } = require('./providers/get_zcode_project_sessions');

function safeScan(vendorName, scanFn) {
  try {
    return (scanFn() || []).map(item => ({
      ...item,
      vendor: stateStore.normalizeVendor(item && item.vendor) || vendorName
    }));
  } catch (err) {
    console.error(`[find-sessions] ${vendorName} provider error: ${err.message}`);
    return [];
  }
}

function findSessions(projectRoot = '.', vendor = 'Auto', inspect = false) {
  let allSessions = [];
  const v = stateStore.normalizeVendor(vendor) || (vendor || 'auto').toLowerCase();

  const scanAgy = () => safeScan('antigravity', () => scanAgySessions(projectRoot, null, inspect));
  const scanCodex = () => safeScan('codex', () => scanCodexSessions(projectRoot));
  const scanClaude = () => safeScan('claude', () => scanClaudeSessions(projectRoot, null, inspect));
  const scanZcode = () => safeScan('zcode', () => scanZcodeSessions(projectRoot, null, inspect));

  if (v === 'antigravity') {
    allSessions = allSessions.concat(scanAgy());
  } else if (v === 'codex') {
    allSessions = allSessions.concat(scanCodex());
  } else if (v === 'claude') {
    allSessions = allSessions.concat(scanClaude());
  } else if (v === 'zcode') {
    allSessions = allSessions.concat(scanZcode());
  } else if (v === 'all') {
    allSessions = allSessions.concat(scanAgy());
    allSessions = allSessions.concat(scanCodex());
    allSessions = allSessions.concat(scanClaude());
    allSessions = allSessions.concat(scanZcode());
  } else { // 'auto'
    const rootPath = path.resolve(projectRoot);
    let policyFile = path.join(rootPath, '.agents', 'task-loop', 'policy.json');
    if (!fs.existsSync(policyFile)) {
      policyFile = path.join(rootPath, '.codex', 'task-loop', 'policy.json');
    }

    let activeVendor = stateStore.normalizeVendor(stateStore.detectVendor(process.env)) || 'antigravity';
    if (fs.existsSync(policyFile)) {
      try {
        const p = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
        if (p.active_vendor) {
          activeVendor = stateStore.normalizeVendor(p.active_vendor) || activeVendor;
        }
      } catch (e) {}
    }
    const primaryScans = { antigravity: scanAgy, codex: scanCodex, claude: scanClaude, zcode: scanZcode };
    const primary = primaryScans[activeVendor] || scanAgy;
    const primarySessions = primary();
    allSessions = allSessions.concat(primarySessions);
    if (primarySessions.length === 0) {
      for (const [otherVendor, scan] of Object.entries(primaryScans)) {
        if (otherVendor !== activeVendor) allSessions = allSessions.concat(scan());
      }
    }
  }

  const unique = new Map();
  for (const session of allSessions) {
    const identity = stateStore.sessionIdentity(session.vendor, session.session_id);
    if (identity && !unique.has(identity)) unique.set(identity, session);
  }
  return Array.from(unique.values()).sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
}

function main() {
  const args = process.argv.slice(2);
  let projectRoot = '.';
  let vendor = 'Auto';
  let inspect = false;
  let current = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      projectRoot = args[++i];
    } else if (args[i] === '--vendor' && args[i + 1]) {
      vendor = args[++i];
    } else if (args[i] === '--inspect' || args[i] === '-i') {
      inspect = true;
    } else if (args[i] === '--current') {
      current = true;
    } else if (!args[i].startsWith('-')) {
      projectRoot = args[i];
    }
  }

  if (current) {
    if (vendor.toLowerCase() !== 'codex') {
      console.error('--current is currently supported only with --vendor Codex');
      process.exit(1);
    }
    console.log(JSON.stringify(getCurrentSessionMetadata(), null, 2));
    return;
  }

  const sessions = findSessions(projectRoot, vendor, inspect);
  console.log(JSON.stringify(sessions, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { findSessions };
