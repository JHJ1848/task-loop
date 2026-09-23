#!/usr/bin/env node
/**
 * [Hook Script] Inject Session Context for ZCode (SessionStart / UserPromptSubmit)
 * 
 * @deprecated All ZCode / Claude Code adaptation logic has been natively merged into
 * `scripts/hooks/inject_session_context.js`. This file is preserved as a lightweight
 * forwarder for backward compatibility with existing configs and tests.
 */

const universal = require('./inject_session_context.js');

function processPayload(payload, env, argv) {
  const p = Object.assign({ requested_vendor: 'zcode' }, payload);
  return universal.processPayload(p, env, argv);
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

    const eventIdx = process.argv.indexOf('--event');
    if (eventIdx !== -1 && process.argv[eventIdx + 1] === 'SessionStart') {
      payload.hook_event_name = payload.hook_event_name || 'SessionStart';
    }

    const result = processPayload(payload, process.env, process.argv);
    if (Object.keys(result).length === 0) {
      return;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

module.exports = {
  processPayload,
  extractSessionId: universal.extractSessionId,
  resolveWorkspace: universal.resolveWorkspace,
  extractEventName: universal.extractEventName,
  main
};

if (require.main === module) {
  main();
}


