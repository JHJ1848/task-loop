#!/usr/bin/env node
/**
 * Codex UserPromptSubmit advisory for a registered task-loop main thread.
 *
 * This hook is intentionally read-only: it neither creates threads nor sends
 * messages. Its only job is to add a compact dispatch reminder when the active
 * top-level Codex thread is the main thread registered for this workspace.
 */

const fs = require('fs');
const path = require('path');

const THREAD_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const MAX_META_BYTES = 256 * 1024;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function directoriesFrom(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return [];
  const directories = [];
  let current = path.resolve(cwd);
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

function stringId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function codexMainFromPartition(document) {
  if (!document || typeof document !== 'object') return { recognized: false, mainThreadId: null };
  if (document.vendors && typeof document.vendors === 'object') {
    const codex = document.vendors.codex;
    return {
      recognized: true,
      mainThreadId: codex && typeof codex === 'object' ? stringId(codex.main_thread_id) : null
    };
  }
  if (document.vendor === 'codex') {
    return { recognized: true, mainThreadId: stringId(document.main_thread_id) };
  }
  return { recognized: false, mainThreadId: null };
}

/**
 * Newer .agents state is authoritative. The vendor mirror is only used when
 * the unified state does not exist, and the old .codex v1-v3 registry is the
 * final compatibility fallback. This prevents a stale legacy main binding
 * from overriding a current v4/v5 Codex partition.
 */
function findCodexMainThread(cwd) {
  const directories = directoriesFrom(cwd);

  for (const root of directories) {
    const primary = path.join(root, '.agents', 'task-loop', 'sessions.json');
    if (fs.existsSync(primary)) {
      const document = readJson(primary);
      const result = codexMainFromPartition(document);
      return { root, source: primary, mainThreadId: result.mainThreadId, authoritative: true };
    }
  }

  for (const root of directories) {
    const mirror = path.join(root, '.agents', 'task-loop', 'sessions.codex.json');
    if (fs.existsSync(mirror)) {
      const result = codexMainFromPartition(readJson(mirror));
      return { root, source: mirror, mainThreadId: result.mainThreadId, authoritative: true };
    }
  }

  for (const root of directories) {
    const legacy = path.join(root, '.codex', 'task-loop', 'sessions.json');
    if (fs.existsSync(legacy)) {
      const document = readJson(legacy);
      return {
        root,
        source: legacy,
        mainThreadId: document && typeof document === 'object' ? stringId(document.main_thread_id) : null,
        authoritative: true
      };
    }
  }

  return null;
}

function sessionIdFrom(payload) {
  return stringId(payload && (payload.session_id || payload.sessionId || payload.sessionID));
}

function isUserPromptSubmit(payload) {
  const event = payload && (payload.hook_event_name || payload.hookEventName || payload.event || payload.eventName);
  return typeof event === 'string' && event.toLowerCase() === 'userpromptsubmit';
}

function isCodexPayload(payload, env) {
  const declaredVendor = payload && payload.vendor;
  if (typeof declaredVendor === 'string' && declaredVendor && declaredVendor.toLowerCase() !== 'codex') return false;
  return !(env.ANTIGRAVITY_CONVERSATION_ID || env.ZCODE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID);
}

function hasNestedThreadEvidence(payload) {
  if (!payload || typeof payload !== 'object') return true;
  if (stringId(payload.parent_thread_id || payload.parentThreadId || payload.parent_session_id || payload.parentSessionId)) {
    return true;
  }
  if (payload.is_subagent === true || payload.isSubagent === true) return true;
  const source = payload.thread_source || payload.threadSource;
  return typeof source === 'string' && source !== 'user';
}

function transcriptProvesTopLevel(transcriptPath, sessionId) {
  try {
    const fd = fs.openSync(path.resolve(transcriptPath), 'r');
    try {
      const buffer = Buffer.alloc(MAX_META_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const lineEnd = buffer.indexOf(10, 0);
      if (lineEnd < 0 || lineEnd >= bytesRead) return false;
      const firstLine = JSON.parse(buffer.subarray(0, lineEnd).toString('utf8'));
      const meta = firstLine && firstLine.payload;
      return firstLine.type === 'session_meta' && meta &&
        (meta.session_id || meta.id) === sessionId &&
        meta.thread_source === 'user' && !meta.parent_thread_id;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function isTopLevelCodexThread(payload, sessionId, env) {
  if (hasNestedThreadEvidence(payload)) return false;
  if (env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== sessionId) return false;
  const transcriptPath = payload.transcript_path || payload.transcriptPath;
  return !transcriptPath || transcriptProvesTopLevel(transcriptPath, sessionId);
}

function additionalContext() {
  return '[task-loop | Codex 主会话派单提示] 当前为已登记的主会话。需要分派开发、排障或审查时，先查 .agents/task-loop/sessions.json 的 vendors.codex.modules；仅向项目一致、resumable=true、id_kind=threadId 的正式 session_id 用 send_message_to_thread 派单，并以 wait_threads 获取交付。临时子代理或 Multi-Agent 仅在用户明确要求时启用；授权不足时先询问。';
}

function processPayload(payload, env = process.env) {
  if (!isUserPromptSubmit(payload) || !isCodexPayload(payload, env)) return {};
  const sessionId = sessionIdFrom(payload);
  if (!sessionId || !THREAD_ID.test(sessionId) || !isTopLevelCodexThread(payload, sessionId, env)) return {};

  const registry = findCodexMainThread(payload.cwd || payload.currentWorkingDirectory || payload.workspace || payload.workspaceRoot);
  if (!registry || registry.mainThreadId !== sessionId) return {};

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: additionalContext()
    }
  };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const output = processPayload(raw.trim() ? JSON.parse(raw) : {});
      if (Object.keys(output).length) process.stdout.write(JSON.stringify(output) + '\n');
    } catch {
      // A reminder must never block the active Codex prompt.
    }
  });
}

module.exports = {
  additionalContext,
  findCodexMainThread,
  hasNestedThreadEvidence,
  isCodexPayload,
  isTopLevelCodexThread,
  processPayload,
  transcriptProvesTopLevel
};

if (require.main === module) main();
