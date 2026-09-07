#!/usr/bin/env node
/**
 * Find Project Sessions (Universal Scanner & Introspection Entrypoint - Node.js)
 * Aggregates sessions across Antigravity, Codex, and Claude Code.
 */

const fs = require('fs');
const path = require('path');

const { scanAgySessions } = require('./providers/get_agy_project_sessions');
const { scanCodexSessions, getCurrentSessionMetadata } = require('./providers/get_codex_project_sessions');
const { scanClaudeSessions } = require('./providers/get_claude_project_sessions');
const { scanZcodeSessions } = require('./providers/get_zcode_project_sessions');

function safeScan(vendorName, scanFn) {
  try {
    return scanFn() || [];
  } catch (err) {
    console.error(`[find-sessions] ${vendorName} provider error: ${err.message}`);
    return [];
  }
}

function findSessions(projectRoot = '.', vendor = 'Auto', inspect = false) {
  let allSessions = [];
  const v = (vendor || 'auto').toLowerCase();

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

    let activeVendor = 'antigravity';
    if (fs.existsSync(policyFile)) {
      try {
        const p = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
        if (p.active_vendor) {
          activeVendor = String(p.active_vendor).toLowerCase();
        }
      } catch (e) {}
    }
    if (!fs.existsSync(policyFile)) {
      // No project policy: prefer the host this session is actually running in.
      if (process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID) {
        activeVendor = 'zcode';
      }
    }

    if (activeVendor === 'antigravity') {
      const agy = scanAgy();
      allSessions = allSessions.concat(agy);
      if (agy.length === 0) {
        allSessions = allSessions.concat(scanCodex());
        allSessions = allSessions.concat(scanZcode());
      }
    } else if (activeVendor === 'codex') {
      const codex = scanCodex();
      allSessions = allSessions.concat(codex);
      if (codex.length === 0) {
        allSessions = allSessions.concat(scanAgy());
      }
    } else if (activeVendor === 'claude') {
      const claude = scanClaude();
      allSessions = allSessions.concat(claude);
      if (claude.length === 0) {
        allSessions = allSessions.concat(scanAgy());
      }
    } else if (activeVendor === 'zcode') {
      const zcode = scanZcode();
      allSessions = allSessions.concat(zcode);
      if (zcode.length === 0) {
        allSessions = allSessions.concat(scanAgy());
      }
    } else {
      allSessions = allSessions.concat(scanAgy());
    }
  }

  allSessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
  return allSessions;
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
