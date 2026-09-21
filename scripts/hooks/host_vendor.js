#!/usr/bin/env node
/**
 * [Hook Helper] Host vendor declaration for protocol adapters.
 *
 * Adapters are the only layer that knows which host is calling; the shared cores
 * stay vendor-agnostic. Every adapter resolves the host through this module and
 * forwards it explicitly, so no host-specific branch ever enters a core.
 *
 * Resolution precedence (most explicit wins):
 *   1. --vendor <name> on the command line (the host's own hook config declares it)
 *   2. payload.vendor
 *   3. an environment variable the host exports (table below)
 *
 * Adding a host means adding a row to the table, never a branch in a core.
 */

// Only variables actually exported by the named host belong here. Verified for
// Claude Code: CLAUDECODE and CLAUDE_CODE_SESSION_ID (== the hook payload's
// session_id). CLAUDE_PROJECT_DIR is set in hook context only.
const HOST_VENDOR_ENV_SIGNALS = [
  ['CLAUDECODE', 'claude'],
  ['CLAUDE_CODE_SESSION_ID', 'claude'],
  ['CLAUDE_PROJECT_DIR', 'claude'],
  ['ZCODE_PROJECT_DIR', 'zcode'],
  ['ZCODE_SESSION_ID', 'zcode'],
  ['CODEX_THREAD_ID', 'codex'],
  ['ANTIGRAVITY_CONVERSATION_ID', 'antigravity']
];

function readArg(argv, flag) {
  const args = argv || [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1] || null;
    if (typeof args[i] === 'string' && args[i].indexOf(flag + '=') === 0) {
      return args[i].slice(flag.length + 1) || null;
    }
  }
  return null;
}

function resolveVendor(payload, env, argv) {
  const declared = readArg(argv, '--vendor');
  if (declared) return declared;
  if (payload && typeof payload.vendor === 'string' && payload.vendor) return payload.vendor;
  for (const [key, vendor] of HOST_VENDOR_ENV_SIGNALS) {
    if (env && env[key]) return vendor;
  }
  return null;
}

module.exports = {
  HOST_VENDOR_ENV_SIGNALS,
  readArg,
  resolveVendor
};
