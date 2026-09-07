#!/usr/bin/env node
/**
 * Codex session discovery for an outer task-loop controller (Node.js).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ENVIRONMENT_ID_KEYS = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID'];
const SESSION_META_TYPE = 'session_meta';
const SUBAGENT_THREAD_SOURCE = 'subagent';

function normalizePath(p) {
  if (!p) return '';
  let val = String(p).replace(/\\/g, '/');
  if (val.startsWith('//?/')) val = val.substring(4);
  return path.resolve(val).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function getCodexHome() {
  const configured = process.env.CODEX_HOME;
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

function getCurrentSessionId() {
  for (const key of ENVIRONMENT_ID_KEYS) {
    const val = process.env[key];
    if (val) return val;
  }
  return null;
}

function getCurrentSessionMetadata() {
  const sessionId = getCurrentSessionId();
  const envKey = ENVIRONMENT_ID_KEYS.find(k => process.env[k]) || null;
  return {
    vendor: 'codex',
    session_id: sessionId,
    thread_id: sessionId,
    is_available: sessionId !== null,
    is_active: sessionId ? true : null,
    activity_state: sessionId ? 'current_process' : 'unavailable',
    discovery_source: sessionId ? 'runtime_env' : 'unavailable',
    environment_key: envKey
  };
}

function readSessionMeta(sessionFile) {
  try {
    const content = fs.readFileSync(sessionFile, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === SESSION_META_TYPE && typeof record.payload === 'object' && record.payload !== null) {
          return record.payload;
        }
      } catch (e) {
        console.error(`[codex-provider] schema mismatch in ${path.basename(sessionFile)}: malformed json: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[codex-provider] schema mismatch in ${path.basename(sessionFile)}: unreadable: ${e.message}`);
    return null;
  }
  return null;
}

function scanPersistedSessions(projectRoot, codexHome, includeSubagents) {
  const sessionsDir = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) {
    return [];
  }

  const sessions = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.json') || entry.endsWith('.jsonl')) {
        const meta = readSessionMeta(fullPath);
        if (!meta) continue;

        const sessionCwd = meta.cwd || '';
        if (normalizePath(sessionCwd) !== projectRoot) continue;

        const threadSource = meta.thread_source || 'unknown';
        if (threadSource === SUBAGENT_THREAD_SOURCE && !includeSubagents) continue;

        const sessionId = String(meta.session_id || meta.parent_thread_id || '');
        sessions.push({
          vendor: 'codex',
          record_type: threadSource === SUBAGENT_THREAD_SOURCE ? 'subagent_transcript' : 'session',
          session_id: sessionId,
          thread_id: sessionId,
          title: meta.title || `Session ${sessionId}`,
          rollout_id: meta.id,
          parent_thread_id: meta.parent_thread_id,
          thread_source: threadSource,
          agent_path: meta.agent_path,
          project_root: projectRoot,
          is_active: null,
          activity_state: 'unknown',
          created_at: meta.timestamp,
          last_active_at: stat.mtime.toISOString(),
          log_path: fullPath.replace(/\\/g, '/'),
          discovery_source: 'session_log'
        });
      }
    }
  }

  try {
    walk(sessionsDir);
  } catch (e) {}

  sessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
  return sessions;
}

function scanCodexSessions(projectRootStr = '.', customCodexHome = null, includeSubagents = false) {
  const projectRoot = normalizePath(projectRootStr);
  const codexHome = customCodexHome ? path.resolve(customCodexHome) : getCodexHome();
  return scanPersistedSessions(projectRoot, codexHome, includeSubagents);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--current')) {
    console.log(JSON.stringify(getCurrentSessionMetadata(), null, 2));
    return;
  }
  const projectRoot = args[0] && !args[0].startsWith('-') ? args[0] : '.';
  const includeSubagents = args.includes('--include-subagents');
  const sessions = scanCodexSessions(projectRoot, null, includeSubagents);
  console.log(JSON.stringify(sessions, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  scanCodexSessions,
  getCurrentSessionId,
  getCurrentSessionMetadata,
  normalizePath
};
