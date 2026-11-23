#!/usr/bin/env node
/**
 * Single Codex UserPromptSubmit entry: registered Main dispatch context and
 * long-session health share registration and transcript identity checks.
 * This hook never creates threads, sends messages or changes project state.
 */
const health = require('./codex_session_health.js');
const fs = require('fs');

const HISTORY_TAIL_BYTES = 64 * 1024;
const CONTEXT_EVENTS = new Set([
  'user_message', 'agent_message', 'agent_reasoning', 'token_count',
  'task_started', 'task_complete', 'task_completed', 'turn_aborted',
  'item_started', 'item_completed', 'exec_command_begin', 'exec_command_end',
  'exec_command_output_delta', 'mcp_tool_call_begin', 'mcp_tool_call_end',
  'web_search_begin', 'web_search_end'
]);
const RESPONSE_TYPES = new Set([
  'message', 'reasoning', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'web_search_call',
  'image_generation_call', 'local_shell_call', 'mcp_call', 'mcp_list_tools'
]);

function additionalContext() {
  return '[task-loop Main] 查 vendors.codex.modules。同项目正式会话：resumable=true、id_kind=threadId。send_message_to_thread 派单，wait_threads 收件。WORK 须专题加载 bugfix-dev，附 Allowlist 和验收。临时子代理仅按用户明确要求启用。';
}

/**
 * Prove the exact developer message is still in the recent context. Unknown,
 * partial or reset history cannot establish that proof, so the caller resends.
 * No clock window or persistent marker is used: a lost/failed injection retries.
 */
function hasCurrentMainContext(fd, message) {
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return false;
    const start = Math.max(0, stat.size - HISTORY_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    // Concurrent append/truncate or a partial last line makes the snapshot
    // inconclusive. Never suppress the reminder based on that snapshot.
    if (count !== buffer.length || buffer[count - 1] !== 10 ||
        fs.fstatSync(fd).size !== stat.size) return false;
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // Discard the possibly truncated first record.
    lines.pop();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]);
      const payload = record && record.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
      if (record.type === 'response_item') {
        if (!RESPONSE_TYPES.has(payload.type)) return false;
        if (payload.type === 'message') {
          if (!['developer', 'system', 'user', 'assistant'].includes(payload.role) ||
              !Array.isArray(payload.content)) return false;
          if (payload.role === 'developer' && payload.content.length === 1 &&
              payload.content[0].type === 'input_text' &&
              payload.content[0].text === message) return true;
        }
      } else if (record.type === 'event_msg') {
        // Compaction, clear/rollback and any new unrecognized event stop the
        // proof. In particular, user/assistant echoes never count as injection.
        if (!CONTEXT_EVENTS.has(payload.type)) return false;
      } else if (!['turn_context', 'token_usage_record'].includes(record.type)) {
        // session_meta, compacted and unknown record kinds are boundaries.
        return false;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function processPayload(payload, env = process.env, now = Date.now()) {
  let context;
  const message = additionalContext();
  try {
    context = health.resolveSession(payload, env, fd => hasCurrentMainContext(fd, message));
  } catch {
    return {};
  }
  if (!context) return {};
  const output = {};
  if (context.project.isMain && !context.mainContextPresent) {
    output.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: message
    };
  }
  try {
    const healthMessage = health.sessionHealth(context, env, now);
    if (healthMessage) output.systemMessage = healthMessage;
  } catch {
    // A cooldown/data-directory failure must not suppress Main dispatch context.
  }
  return output;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const output = processPayload(raw.trim() ? JSON.parse(raw) : {});
      if (Object.keys(output).length) process.stdout.write(JSON.stringify(output) + '\n');
    } catch {
      // Malformed host input remains a quiet no-op.
    }
  });
}

module.exports = { additionalContext, hasCurrentMainContext, processPayload };
if (require.main === module) main();
