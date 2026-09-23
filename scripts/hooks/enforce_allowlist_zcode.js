#!/usr/bin/env node
/**
 * [Hook Script] Enforce Allowlist Guard for ZCode (PreToolUse)
 * 
 * @deprecated All ZCode / Claude Code adaptation logic has been natively merged into
 * `scripts/hooks/enforce_allowlist.js`. This file is preserved as a lightweight
 * forwarder for backward compatibility with existing configs and tests.
 */

const universal = require('./enforce_allowlist.js');

module.exports = {
  processPayload: universal.processPayload,
  normalizeToolCall: universal.normalizeToolCall,
  extractSessionId: universal.extractSessionId,
  resolveWorkspace: universal.resolveWorkspace
};

if (require.main === module) {
  universal.main();
}

