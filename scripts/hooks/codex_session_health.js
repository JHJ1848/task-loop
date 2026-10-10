#!/usr/bin/env node
/**
 * Codex-only advisory for long-lived task-loop threads.
 * The common hook input identifies the current transcript; this script never
 * scans other sessions or changes a Codex thread's lifecycle.
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
const THREAD_ID = /^[a-zA-Z0-9_-]{8,80}$/;

function findCodexProject(cwd, sessionId) {
  let root = path.resolve(cwd);
  while (true) {
    const primaryPath = path.join(root, '.agents', 'task-loop', 'sessions.json');
    const legacyPath = path.join(root, '.codex', 'task-loop', 'sessions.json');
    const registryPath = fs.existsSync(primaryPath) ? primaryPath : legacyPath;
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const codex = registry.vendors && registry.vendors.codex;
      if (codex && codex.modules) {
        for (const [moduleKey, module] of Object.entries(codex.modules)) {
          if (module && module.session_id === sessionId && module.resumable === true) {
            return { root, moduleKey };
          }
        }
      }
      return { root, moduleKey: codex && codex.main_thread_id === sessionId ? 'main' : null };
    }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

function readTopLevelMeta(transcriptPath, sessionId) {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_META_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lineEnd = buffer.indexOf(10, 0);
    if (lineEnd < 0 || lineEnd >= bytesRead) return null;
    const firstLine = JSON.parse(buffer.subarray(0, lineEnd).toString('utf8'));
    const meta = firstLine && firstLine.payload;
    // Hook session_id is the parent ID in subagents. The transcript must be
    // the matching root thread before any user-facing reminder is emitted.
    if (firstLine.type !== 'session_meta' || !meta ||
        (meta.session_id || meta.id) !== sessionId ||
        meta.thread_source !== 'user' || meta.parent_thread_id) return null;
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

function warningTier(size, ageDays) {
  if (size >= HIGH_BYTES || ageDays >= HIGH_DAYS) return 2;
  if (size >= WARNING_BYTES || ageDays >= WARNING_DAYS) return 1;
  return 0;
}

function checkSession(payload, env = process.env, now = Date.now()) {
  if (!payload || payload.hook_event_name !== 'UserPromptSubmit') return null;
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !THREAD_ID.test(sessionId)) return null;
  if (env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== sessionId) return null;
  if (typeof payload.cwd !== 'string' || typeof payload.transcript_path !== 'string') return null;
  if (!env.PLUGIN_DATA) return null;

  const transcriptPath = path.resolve(payload.transcript_path);
  const stat = fs.statSync(transcriptPath);
  if (!stat.isFile()) return null;
  const project = findCodexProject(payload.cwd, sessionId);
  if (!project) return null;
  const meta = readTopLevelMeta(transcriptPath, sessionId);
  if (!meta) return null;
  const createdAt = Date.parse(meta.timestamp);
  const ageDays = Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((now - createdAt) / DAY_MS)) : 0;
  const tier = warningTier(stat.size, ageDays);
  if (tier === 0) return null;

  const stateDir = path.join(env.PLUGIN_DATA, 'codex-session-health');
  const statePath = path.join(stateDir, `${sessionId}.json`);
  let previous = null;
  if (fs.existsSync(statePath)) {
    previous = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }
  if (previous && previous.tier >= tier && now - previous.warnedAt < REMIND_AFTER_MS) return null;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ tier, warnedAt: now, size: stat.size }), 'utf8');

  const sizeMiB = (stat.size / MIB).toFixed(1);
  const urgency = tier === 2 ? '已明显增长' : '已接近长期使用阈值';
  const label = project.moduleKey ? `${project.moduleKey} 会话` : '当前会话';
  const ageText = Number.isFinite(createdAt) ? `创建至今约 ${ageDays} 天` : '创建时间未知';
  return `[task-loop · Codex] ${label}${urgency}（JSONL ${sizeMiB} MiB，${ageText}）。完成当前工作后，先整理项目记忆、变更记录、未完成任务与工作区改动，再在同一项目新建全新会话；如有专题绑定，用正式 threadId 更新并核验，随后归档旧会话。删除旧会话仅在你明确决定后操作。`;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const message = checkSession(JSON.parse(input));
      if (message) process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
    } catch {
      // A health advisory must never block a user prompt when host metadata changes.
    }
  });
}

module.exports = { checkSession, findCodexProject, readTopLevelMeta, warningTier };
if (require.main === module) main();
