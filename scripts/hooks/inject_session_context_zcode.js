#!/usr/bin/env node
/**
 * [Hook Script] Inject Session Context for ZCode (SessionStart / UserPromptSubmit)
 *
 * ZCode protocol adapter over the shared AGY core logic
 * (scripts/hooks/inject_session_context.js). Difference matrix:
 *
 *   Dimension      | AGY PreInvocation            | ZCode (this adapter)
 *   ---------------+------------------------------+---------------------------------
 *   Input channel  | stdin { conversationId, ... }| stdin Claude-Code-style payload
 *   Session ID key | conversationId               | session_id | sessionId | $CLAUDE_SESSION_ID | $ZCODE_SESSION_ID
 *   Workspace root | workspacePaths[0]            | cwd | $ZCODE_PROJECT_DIR | $CLAUDE_PROJECT_DIR
 *   Output shape   | { injectSteps:[{ephemeralMessage}] } | { hookSpecificOutput:{ hookEventName, additionalContext } }
 *   Trigger events | PreInvocation (every turn)   | SessionStart + UserPromptSubmit (per-turn parity)
 *
 * The injected message body (sessions.json awareness + [Plugin: task-loop |
 * topic rules) is 100% reused from the shared core, so both hosts render the
 * exact same context contract.
 *
 * Output JSON is strictly schema-validated by the ZCode hook runner:
 * only `hookSpecificOutput` (+ optional suppressOutput/systemMessage) are
 * accepted at top level. On any internal error this adapter fails open with
 * empty output and exit code 0.
 */

const core = require('./inject_session_context.js');

function extractSessionId(payload, env) {
  return (
    payload.session_id ||
    payload.sessionId ||
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

function extractEventName(payload) {
  const raw = payload.hook_event_name || payload.hookEventName || '';
  if (raw === 'SessionStart' || raw === 'UserPromptSubmit') {
    return raw;
  }
  return 'UserPromptSubmit';
}

function processPayload(payload, env) {
  try {
    env = env || process.env;
    const sessionId = extractSessionId(payload, env);
    if (!sessionId) {
      return {};
    }

    // Event-specific requested event (CLI --event overrides, e.g. SessionStart dispatch)
    let eventName = extractEventName(payload);
    if (payload.requested_event === 'SessionStart') eventName = 'SessionStart';

    const wsRoot = resolveWorkspace(payload, env);
    const sessionData = core.findSessionsRegistry(wsRoot);
    const templates = core.findPromptTemplates(wsRoot);
    const activeTodo = core.findActiveTodo(wsRoot, sessionId);

    const additionalContext = core.generateInjectionMessage(sessionId, sessionData, activeTodo, templates);

    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: additionalContext
      },
      suppressOutput: true
    };
  } catch (err) {
    // Fail-open: never break the host session because of injection errors.
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

    // CLI --event flag lifts SessionStart dispatches whose stdin may be minimal.
    const eventIdx = process.argv.indexOf('--event');
    if (eventIdx !== -1 && process.argv[eventIdx + 1] === 'SessionStart') {
      payload.hook_event_name = payload.hook_event_name || 'SessionStart';
    }

    const result = processPayload(payload);
    if (Object.keys(result).length === 0) {
      return; // empty output + exit 0 = healthy no-op for strict schema
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  processPayload,
  extractSessionId,
  resolveWorkspace,
  extractEventName
};
