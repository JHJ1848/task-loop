#!/usr/bin/env node
/**
 * Shared Codex registration and top-level identity checks, plus the bounded
 * long-session advisory. Only reminder cooldowns are written to PLUGIN_DATA.
 */
const fs = require('fs');
const path = require('path');

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const WARNING_BYTES = 8 * MIB;
const HIGH_BYTES = 16 * MIB;
const WARNING_DAYS = 30;
const HIGH_DAYS = 60;
const REMIND_AFTER_MS = 7 * DAY_MS;
const MAX_META_BYTES = 256 * 1024;
const META_CHUNK_BYTES = 4096;
const THREAD_ID = /^[a-zA-Z0-9_-]{8,80}$/;

function stringId(value) {
  return typeof value === 'string' && THREAD_ID.test(value) ? value : null;
}

function isCodexPayload(payload, env) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.vendor && payload.vendor !== 'codex') return false;
  return !(env.ANTIGRAVITY_CONVERSATION_ID || env.ZCODE_SESSION_ID ||
    env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || env.CLAUDECODE);
}

function hasNestedThreadEvidence(value) {
  return Boolean(value.parent_thread_id || value.parentThreadId ||
    value.parent_session_id || value.parentSessionId ||
    value.is_subagent || value.isSubagent ||
    (value.thread_source && !['user', 'agent_created_thread'].includes(value.thread_source)) ||
    (value.threadSource && !['user', 'agent_created_thread'].includes(value.threadSource)));
}

function activeBinding(binding) {
  return binding && binding.resumable !== false &&
    (!binding.id_kind || binding.id_kind === 'threadId') &&
    (!binding.vendor || binding.vendor === 'codex');
}

/**
 * A linked worktree may share the main checkout's ignored registry. Require
 * Git's reciprocal gitdir pointer and common-directory layout before using it;
 * a normal nested repository is a hard project boundary.
 */
function sharedWorktreeRoot(root) {
  const gitFile = path.join(root, '.git');
  if (!fs.statSync(gitFile).isFile()) return null;
  const marker = fs.readFileSync(gitFile, 'utf8').trim();
  if (!marker.startsWith('gitdir: ')) return null;
  const admin = path.resolve(root, marker.slice(8).trim());
  const common = path.resolve(admin, fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim());
  if (path.basename(common) !== '.git' || !fs.statSync(common).isDirectory() ||
      path.basename(path.dirname(admin)) !== 'worktrees' ||
      path.dirname(path.dirname(admin)) !== common) return null;
  const backReference = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim();
  if (fs.realpathSync(path.resolve(admin, backReference)) !== fs.realpathSync(gitFile)) return null;
  return path.dirname(common);
}

/**
 * Stop at the nearest project registry; never borrow an ancestor's registration.
 * Within that project, unified state is authoritative, followed by the Codex
 * mirror and finally the old Codex-specific v1-v3 registry.
 */
function findCodexProject(cwd, sessionId) {
  let root = path.resolve(cwd);
  while (true) {
    const candidates = [
      path.join(root, '.agents', 'task-loop', 'sessions.json'),
      path.join(root, '.agents', 'task-loop', 'sessions.codex.json'),
      path.join(root, '.codex', 'task-loop', 'sessions.json')
    ];
    const registryPath = candidates.find(file => fs.existsSync(file));
    if (registryPath) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return null;
      let codex = null;
      if (registry.vendors && typeof registry.vendors === 'object') {
        codex = registry.vendors.codex;
      } else if (registry.schema_version < 4 &&
          (!registry.vendor || registry.vendor === 'codex') &&
          (!registry.current_vendor || registry.current_vendor === 'codex') &&
          (registryPath !== candidates[0] || registry.vendor === 'codex' || registry.current_vendor === 'codex')) {
        codex = registry;
      }
      if (!codex || typeof codex !== 'object' || (codex.vendor && codex.vendor !== 'codex')) return null;
      const mainThreadId = stringId(codex.main_thread_id);
      const entries = codex.modules && typeof codex.modules === 'object' ? Object.entries(codex.modules) : [];
      if (mainThreadId === sessionId) {
        // An explicitly retired or non-formal binding must not regain Main
        // authority just because main_thread_id was left behind.
        const mainBindings = entries.filter(([, binding]) => binding && binding.session_id === sessionId);
        const sessions = Array.isArray(codex.sessions) ? codex.sessions : [];
        if (mainBindings.some(([, binding]) => !activeBinding(binding)) ||
            sessions.some(binding => binding && binding.session_id === sessionId && !activeBinding(binding))) return null;
        return { root, source: registryPath, mainThreadId, moduleKey: 'main', isMain: true };
      }
      for (const [moduleKey, binding] of entries) {
        if (binding && binding.session_id === sessionId && activeBinding(binding) &&
            binding.resumable === true && binding.id_kind === 'threadId') {
          return { root, source: registryPath, mainThreadId, moduleKey, isMain: false };
        }
      }
      return null;
    }
    if (fs.existsSync(path.join(root, '.git'))) {
      const sharedRoot = sharedWorktreeRoot(root);
      return sharedRoot ? findCodexProject(sharedRoot, sessionId) : null;
    }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

/** Read bounded metadata; optionally inspect the verified descriptor before closing. */
function readTopLevelMeta(transcriptPath, sessionId, inspectVerifiedTranscript) {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const chunks = [];
    let total = 0;
    while (total < MAX_META_BYTES) {
      const buffer = Buffer.alloc(Math.min(META_CHUNK_BYTES, MAX_META_BYTES - total));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (bytesRead === 0) return null;
      const lineEnd = buffer.subarray(0, bytesRead).indexOf(10);
      chunks.push(buffer.subarray(0, lineEnd < 0 ? bytesRead : lineEnd));
      total += bytesRead;
      if (lineEnd < 0) continue;
      const firstLine = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const meta = firstLine && firstLine.payload;
      if (firstLine.type !== 'session_meta' || !meta || typeof meta !== 'object' ||
          !(meta.session_id || meta.id) ||
          (meta.session_id && meta.session_id !== sessionId) ||
          (meta.id && meta.id !== sessionId) || hasNestedThreadEvidence(meta) ||
          !['user', 'agent_created_thread'].includes(meta.thread_source)) return null;
      // A Main-only history inspection can reuse the verified descriptor.
      // Ownership stays here so every caller still closes it exactly once.
      if (inspectVerifiedTranscript) inspectVerifiedTranscript(fd);
      return meta;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Missing or inconsistent top-level evidence is a quiet advisory no-op. */
function resolveSession(payload, env = process.env, inspectMainTranscript) {
  if (!isCodexPayload(payload, env)) return null;
  const event = payload.hook_event_name || payload.hookEventName || payload.event || payload.eventName;
  if (event !== 'UserPromptSubmit') return null;
  const sessionId = stringId(payload.session_id || payload.sessionId || payload.sessionID);
  if (!sessionId || hasNestedThreadEvidence(payload) ||
      (env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== sessionId) ||
      (env.CODEX_SESSION_ID && env.CODEX_SESSION_ID !== sessionId)) return null;
  const cwd = payload.cwd || payload.currentWorkingDirectory || payload.workspace || payload.workspaceRoot;
  const transcriptPath = payload.transcript_path || payload.transcriptPath;
  if (typeof cwd !== 'string' || !cwd.trim() ||
      typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return null;
  const project = findCodexProject(cwd, sessionId);
  if (!project) return null;
  let mainContextPresent = false;
  const inspect = project.isMain && typeof inspectMainTranscript === 'function'
    ? fd => { mainContextPresent = inspectMainTranscript(fd) === true; }
    : undefined;
  const meta = readTopLevelMeta(transcriptPath, sessionId, inspect);
  return meta ? { sessionId, project, meta, transcriptPath, mainContextPresent } : null;
}

function warningTier(size, ageDays) {
  if (size >= HIGH_BYTES || ageDays >= HIGH_DAYS) return 2;
  if (size >= WARNING_BYTES || ageDays >= WARNING_DAYS) return 1;
  return 0;
}

function sessionHealth(context, env = process.env, now = Date.now()) {
  if (!context || !env.PLUGIN_DATA) return null;
  const { sessionId, project, meta, transcriptPath } = context;
  const stat = fs.statSync(transcriptPath);
  const createdAt = Date.parse(meta.timestamp);
  const ageDays = Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((now - createdAt) / DAY_MS)) : 0;
  const tier = warningTier(stat.size, ageDays);
  if (tier === 0) return null;

  const stateDir = path.join(env.PLUGIN_DATA, 'codex-session-health');
  const statePath = path.join(stateDir, `${sessionId}.json`);
  if (fs.existsSync(statePath)) {
    const previous = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (previous && previous.tier >= tier && now - previous.warnedAt < REMIND_AFTER_MS) return null;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ tier, warnedAt: now, size: stat.size }), 'utf8');

  const sizeMiB = (stat.size / MIB).toFixed(1);
  const urgency = tier === 2 ? '已明显增长' : '已接近长期使用阈值';
  const ageText = Number.isFinite(createdAt) ? `创建至今约 ${ageDays} 天` : '创建时间未知';
  return `[task-loop · Codex] ${project.moduleKey} 会话${urgency}（JSONL ${sizeMiB} MiB，${ageText}）。完成当前工作后，先整理项目记忆、变更记录、未完成任务与工作区改动，再在同一项目新建全新会话；如有专题绑定，用正式 threadId 更新并核验，随后归档旧会话。删除旧会话仅在你明确决定后操作。`;
}

// Compatibility API for callers that only need the health reminder.
function checkSession(payload, env = process.env, now = Date.now()) {
  return sessionHealth(resolveSession(payload, env), env, now);
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const message = checkSession(JSON.parse(input));
      if (message) process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
    } catch {
      // An advisory must never block a user prompt when metadata changes.
    }
  });
}

module.exports = {
  checkSession, findCodexProject, hasNestedThreadEvidence, isCodexPayload,
  readTopLevelMeta, resolveSession, sessionHealth, warningTier
};
if (require.main === module) main();
