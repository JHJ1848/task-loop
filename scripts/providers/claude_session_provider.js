#!/usr/bin/env node
'use strict';

/**
 * Claude Code Session Provider (Node.js)
 *
 * Reads the Claude Desktop session registry (~/.claude/sessions/<pid>.json) and
 * reports whether a live App session attachment currently exists for a session.
 *
 * Measurement scope: the registry only lists running/attachable processes, and
 * an entry disappears once that process exits. The App session index has no
 * readable on-disk source, so this tool can never tell whether an idle session
 * is still listed in the sidebar. Every verdict is therefore scoped to
 * `verdict_scope: live_registry_presence`:
 *   - true  -> an interactive App session with a hostSessionId is attached now
 *   - false -> no live attachment right now (pid_dead / not_registered), which
 *              does NOT mean the session is missing from the sidebar list
 *
 * App ids (local_xxx) and CLI/hook ids (bare UUID) are two namespaces; topic
 * binding must always use the bare UUID, resolved from hostSessionId via
 * `resolve`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const VERDICT_SCOPE = 'live_registry_presence';

const REASON = {
  VISIBLE: 'interactive_app_session',
  NO_HOST_SESSION_ID: 'no_host_session_id',
  KIND_BG: 'kind_bg',
  PID_DEAD: 'pid_dead',
  NOT_REGISTERED: 'not_registered'
};

const COMMANDS = ['list', 'verify', 'resolve'];

const USAGE = [
  'Usage:',
  '  node claude_session_provider.js list [--cwd <path>] [--all] [--claude-home <dir>]',
  '  node claude_session_provider.js verify --session <uuid|local_xxx> [--claude-home <dir>]',
  '  node claude_session_provider.js resolve --host <local_xxx> [--claude-home <dir>]',
  '',
  'Reasons: interactive_app_session | no_host_session_id | kind_bg | pid_dead | not_registered',
  '',
  'Scope: verdict_scope is always live_registry_presence. reason=not_registered or',
  'pid_dead means no live process is attached right now; it does NOT mean the',
  'session is absent from the App sidebar list - idle App sessions stay listed.'
].join('\n');

function defaultClaudeHome() {
  return path.join(os.homedir(), '.claude');
}

function sessionsDir(claudeHome) {
  return path.join(path.resolve(claudeHome || defaultClaudeHome()), 'sessions');
}

function normalizeValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isHostSessionId(value) {
  return normalizeValue(value).startsWith('local_');
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // An existing process owned by another user still holds the pid.
    return error.code === 'EPERM';
  }
}

function readRegistryFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`[claude-provider] unreadable registry entry ${path.basename(file)}: ${error.message}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`[claude-provider] invalid registry entry ${path.basename(file)}: ${error.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const filePid = Number(path.basename(file, '.json'));
  const entryPid = Number(parsed.pid);
  const updatedAt = Number(parsed.updatedAt || parsed.statusUpdatedAt) || null;

  return {
    pid: Number.isInteger(entryPid) && entryPid > 0 ? entryPid : (Number.isInteger(filePid) ? filePid : null),
    session_id: normalizeValue(parsed.sessionId),
    host_session_id: normalizeValue(parsed.hostSessionId),
    kind: normalizeValue(parsed.kind),
    entrypoint: normalizeValue(parsed.entrypoint),
    cwd: normalizeValue(parsed.cwd),
    name: normalizeValue(parsed.name),
    status: normalizeValue(parsed.status),
    updated_at: updatedAt ? new Date(updatedAt).toISOString() : null,
    registry_path: path.resolve(file).replace(/\\/g, '/')
  };
}

function loadRegistry(claudeHome) {
  const dir = sessionsDir(claudeHome);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const entries = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const entry = readRegistryFile(path.join(dir, name));
    if (entry) entries.push(entry);
  }
  return entries;
}

// Reason precedence follows reachability: a bg session never carries a
// hostSessionId, so the kind gate has to answer before the id gate.
// The verdict answers "is a live App session attached right now?", not "is this
// session a member of the sidebar list?" - see VERDICT_SCOPE.
function classifyEntry(entry) {
  if (!entry || !entry.session_id) {
    return { sidebar_visible: false, reason: REASON.NOT_REGISTERED };
  }
  if (entry.kind !== 'interactive') {
    return { sidebar_visible: false, reason: REASON.KIND_BG };
  }
  if (!entry.host_session_id) {
    return { sidebar_visible: false, reason: REASON.NO_HOST_SESSION_ID };
  }
  if (!isPidAlive(entry.pid)) {
    return { sidebar_visible: false, reason: REASON.PID_DEAD };
  }
  return { sidebar_visible: true, reason: REASON.VISIBLE };
}

function describeEntry(entry) {
  const verdict = classifyEntry(entry);
  return {
    session_id: entry.session_id,
    host_session_id: entry.host_session_id,
    pid: entry.pid,
    kind: entry.kind,
    entrypoint: entry.entrypoint,
    cwd: entry.cwd,
    name: entry.name,
    status: entry.status,
    updated_at: entry.updated_at,
    registry_path: entry.registry_path,
    sidebar_visible: verdict.sidebar_visible,
    reason: verdict.reason,
    verdict_scope: VERDICT_SCOPE
  };
}

function findBySessionId(entries, sessionId) {
  const target = normalizeValue(sessionId);
  if (!target) return null;
  return entries.find(entry => entry.session_id === target) || null;
}

function findByHostSessionId(entries, hostSessionId) {
  const target = normalizeValue(hostSessionId);
  if (!target) return null;
  return entries.find(entry => entry.host_session_id === target) || null;
}

function listSessions(options = {}) {
  const claudeHome = path.resolve(options.claudeHome || defaultClaudeHome());
  const cwdFilter = options.cwd ? normalizePath(options.cwd) : '';
  const includeAll = Boolean(options.all);

  let entries = loadRegistry(claudeHome).map(describeEntry);
  if (cwdFilter) entries = entries.filter(entry => normalizePath(entry.cwd) === cwdFilter);
  if (!includeAll) entries = entries.filter(entry => entry.sidebar_visible);

  entries.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
    || a.session_id.localeCompare(b.session_id));

  return {
    vendor: 'claude',
    claude_home: claudeHome.replace(/\\/g, '/'),
    cwd_filter: options.cwd || null,
    sidebar_visible_only: !includeAll,
    count: entries.length,
    sessions: entries
  };
}

function verifySession(sessionRef, options = {}) {
  const claudeHome = path.resolve(options.claudeHome || defaultClaudeHome());
  const query = normalizeValue(sessionRef);
  const queryKind = isHostSessionId(query) ? 'host_session_id' : 'session_id';
  const entries = loadRegistry(claudeHome);
  const entry = queryKind === 'host_session_id'
    ? findByHostSessionId(entries, query)
    : findBySessionId(entries, query);

  if (!entry) {
    return {
      vendor: 'claude',
      query,
      query_kind: queryKind,
      found: false,
      session_id: null,
      host_session_id: queryKind === 'host_session_id' ? query : null,
      sidebar_visible: false,
      reason: REASON.NOT_REGISTERED,
      verdict_scope: VERDICT_SCOPE
    };
  }

  return {
    vendor: 'claude',
    query,
    query_kind: queryKind,
    found: true,
    ...describeEntry(entry)
  };
}

function resolveHostSession(hostSessionId, options = {}) {
  const claudeHome = path.resolve(options.claudeHome || defaultClaudeHome());
  const query = normalizeValue(hostSessionId);
  const entry = findByHostSessionId(loadRegistry(claudeHome), query);
  if (!entry) {
    return {
      vendor: 'claude',
      host_session_id: query,
      resolved: false,
      session_id: null,
      reason: REASON.NOT_REGISTERED,
      verdict_scope: VERDICT_SCOPE
    };
  }
  const verdict = classifyEntry(entry);
  return {
    vendor: 'claude',
    host_session_id: query,
    resolved: true,
    session_id: entry.session_id,
    cwd: entry.cwd,
    registry_path: entry.registry_path,
    sidebar_visible: verdict.sidebar_visible,
    reason: verdict.reason,
    verdict_scope: VERDICT_SCOPE
  };
}

function parseArgs(argv) {
  const options = { all: false, cwd: null, claudeHome: null, session: null, host: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const take = () => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`missing value for ${key}`);
      return next;
    };
    try {
      if (key === '--all' || key === '-a') options.all = true;
      else if (key === '--help' || key === '-h') options.help = true;
      else if (key === '--cwd') options.cwd = take();
      else if (key === '--claude-home') options.claudeHome = take();
      else if (key === '--session') options.session = take();
      else if (key === '--host') options.host = take();
      else return { error: `unknown option: ${arg}` };
    } catch (error) {
      return { error: error.message };
    }
  }
  return { options };
}

function run(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (!COMMANDS.includes(command)) {
    console.error(`[claude-provider] unknown command: ${command}`);
    console.error(USAGE);
    return 2;
  }

  const parsed = parseArgs(argv.slice(1));
  if (parsed.error) {
    console.error(`[claude-provider] ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (command === 'list') {
    console.log(JSON.stringify(listSessions(options), null, 2));
    return 0;
  }
  if (command === 'verify') {
    if (!options.session) {
      console.error('[claude-provider] verify requires --session <uuid|local_xxx>');
      return 2;
    }
    const result = verifySession(options.session, options);
    console.log(JSON.stringify(result, null, 2));
    return result.sidebar_visible ? 0 : 1;
  }
  if (!options.host) {
    console.error('[claude-provider] resolve requires --host <local_xxx>');
    return 2;
  }
  const result = resolveHostSession(options.host, options);
  console.log(JSON.stringify(result, null, 2));
  return result.resolved ? 0 : 1;
}

function main() {
  process.exitCode = run(process.argv.slice(2));
}

if (require.main === module) {
  main();
}

module.exports = {
  REASON,
  VERDICT_SCOPE,
  defaultClaudeHome,
  sessionsDir,
  isPidAlive,
  isHostSessionId,
  normalizePath,
  loadRegistry,
  classifyEntry,
  describeEntry,
  findBySessionId,
  findByHostSessionId,
  listSessions,
  verifySession,
  resolveHostSession,
  run
};
