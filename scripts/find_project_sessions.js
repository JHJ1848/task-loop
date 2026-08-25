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

function findSessions(projectRoot = '.', vendor = 'Auto', inspect = false) {
  let allSessions = [];
  const v = (vendor || 'auto').toLowerCase();

  if (v === 'antigravity') {
    allSessions = allSessions.concat(scanAgySessions(projectRoot, null, inspect));
  } else if (v === 'codex') {
    allSessions = allSessions.concat(scanCodexSessions(projectRoot));
  } else if (v === 'claude') {
    allSessions = allSessions.concat(scanClaudeSessions(projectRoot, null, inspect));
  } else if (v === 'all') {
    allSessions = allSessions.concat(scanAgySessions(projectRoot, null, inspect));
    allSessions = allSessions.concat(scanCodexSessions(projectRoot));
    allSessions = allSessions.concat(scanClaudeSessions(projectRoot, null, inspect));
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

    if (activeVendor === 'antigravity') {
      const agy = scanAgySessions(projectRoot, null, inspect);
      allSessions = allSessions.concat(agy);
      if (agy.length === 0) {
        allSessions = allSessions.concat(scanCodexSessions(projectRoot));
      }
    } else if (activeVendor === 'codex') {
      const codex = scanCodexSessions(projectRoot);
      allSessions = allSessions.concat(codex);
      if (codex.length === 0) {
        allSessions = allSessions.concat(scanAgySessions(projectRoot, null, inspect));
      }
    } else if (activeVendor === 'claude') {
      const claude = scanClaudeSessions(projectRoot, null, inspect);
      allSessions = allSessions.concat(claude);
      if (claude.length === 0) {
        allSessions = allSessions.concat(scanAgySessions(projectRoot, null, inspect));
      }
    } else {
      allSessions = allSessions.concat(scanAgySessions(projectRoot, null, inspect));
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
