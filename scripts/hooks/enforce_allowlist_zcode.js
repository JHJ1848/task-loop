#!/usr/bin/env node
/**
 * [Hook Script] Enforce Allowlist Guard for ZCode (PreToolUse)
 *
 * ZCode protocol adapter over the shared AGY core logic
 * (scripts/hooks/enforce_allowlist.js). Difference matrix:
 *
 *   Dimension      | AGY PreToolUse                       | ZCode (this adapter)
 *   ---------------+--------------------------------------+----------------------------------------
 *   Tool payload   | { toolCall: { name, args } }         | { tool_name, tool_input } (snake_case)
 *   File arg keys  | TargetFile / FilePath / target_path  | file_path / filePath (+ legacy fallbacks)
 *   Session ID key | conversationId                       | session_id | sessionId | $CLAUDE_SESSION_ID
 *   Allow output   | { decision: "allow" }                | empty output + exit 0 (strict-schema no-op)
 *   Deny output    | { decision: "deny", reason }         | { hookSpecificOutput:{ hookEventName:"PreToolUse",
 *                  |                                      |   permissionDecision:"deny", permissionDecisionReason } }
 *
 * The whitelist resolution order (env TASK_LOOP_ALLOWLIST -> todo.json ->
 * dispatch/*.json) and path prefix matching are 100% reused from the shared
 * core. On any internal error this adapter fails open with exit code 0.
 */

const core = require('./enforce_allowlist.js');

function extractSessionId(payload, env) {
  return (
    payload.session_id ||
    payload.sessionId ||
    payload.conversationId ||
    (env && env.CLAUDE_SESSION_ID) ||
    (env && env.ZCODE_SESSION_ID) ||
    null
  );
}

function resolveWorkspace(payload, env) {
  if (payload.cwd && typeof payload.cwd === 'string') {
    return payload.cwd;
  }
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0) {
    return payload.workspacePaths[0];
  }
  return (
    (env && env.ZCODE_PROJECT_DIR) ||
    (env && env.CLAUDE_PROJECT_DIR) ||
    process.cwd()
  );
}

function normalizeToolCall(payload) {
  const rawArgs =
    payload.tool_input !== undefined ? payload.tool_input : payload.toolInput;
  if (!rawArgs || typeof rawArgs !== 'object') {
    return null;
  }

  const toolName = payload.tool_name || payload.toolName;
  if (!toolName || typeof toolName !== 'string') {
    return null;
  }

  // ZCode uses file_path/filePath; map onto the canonical key expected by the core.
  const args = Object.assign({}, rawArgs);
  const target =
    args.TargetFile !== undefined ? args.TargetFile :
    args.FilePath !== undefined ? args.FilePath :
    args.file_path !== undefined ? args.file_path :
    args.filePath !== undefined ? args.filePath :
    args.target_file !== undefined ? args.target_file :
    args.target_path !== undefined ? args.target_path :
    args.path;
  delete args.file_path;
  delete args.filePath;
  args.TargetFile = target;

  return { name: toolName, args: args };
}

function processPayload(payload, env) {
  try {
    env = env || process.env;
    const toolCall = normalizeToolCall(payload);
    if (!toolCall) {
      // Non-file-write tools (or unparseable payloads): strict-schema no-op pass.
      return {};
    }

    const wsRoot = resolveWorkspace(payload, env);
    const conversationId = extractSessionId(payload, env);

    const result = core.processPayload({
      toolCall: toolCall,
      conversationId: conversationId,
      workspacePaths: [wsRoot]
    });

    if (result && result.decision === 'deny') {
      return {
        suppressOutput: true,
        systemMessage: '[task-loop Allowlist Guard] blocked an out-of-allowlist write.',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason || 'Target file is outside the dispatched task allowlist.'
        }
      };
    }

    return {}; // allow: silent pass (empty output + exit 0)
  } catch (err) {
    // Fail-open on adapter errors; never wedge the host's edit pipeline.
    return {};
  }
}

function main() {
  let rawInput = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', chunk => {
    rawInput += chunk;
  });

  process.stdin.on('end', () => {
    let payload = {};
    if (rawInput.trim().length > 0) {
      try {
        payload = JSON.parse(rawInput);
      } catch {
        payload = {};
      }
    } else {
      const argIdx = process.argv.indexOf('--payload');
      if (argIdx !== -1 && process.argv[argIdx + 1]) {
        try {
          payload = JSON.parse(process.argv[argIdx + 1]);
        } catch {
          payload = {};
        }
      }
    }

    const result = processPayload(payload);
    if (Object.keys(result).length === 0) {
      return; // allow via empty output + exit 0
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  processPayload,
  normalizeToolCall,
  extractSessionId,
  resolveWorkspace
};
