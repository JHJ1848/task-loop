#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[Hook Helper] Host vendor declaration for protocol adapters.

Adapters are the only layer that knows which host is calling; the shared cores
stay vendor-agnostic. Every adapter resolves the host through this module and
forwards it explicitly, so no host-specific branch ever enters a core.

Resolution precedence (most explicit wins):
  1. --vendor <name> on the command line (the host's own hook config declares it)
  2. payload.vendor
  3. an environment variable the host exports (table below)

Adding a host means adding a row to the table, never a branch in a core.
"""

import os

# Only variables actually exported by the named host belong here. Verified for
# Claude Code: CLAUDECODE and CLAUDE_CODE_SESSION_ID (== the hook payload's
# session_id). CLAUDE_PROJECT_DIR is set in hook context only.
HOST_VENDOR_ENV_SIGNALS = (
    ('CLAUDECODE', 'claude'),
    ('CLAUDE_CODE_SESSION_ID', 'claude'),
    ('CLAUDE_PROJECT_DIR', 'claude'),
    ('ZCODE_PROJECT_DIR', 'zcode'),
    ('ZCODE_SESSION_ID', 'zcode'),
    ('CODEX_THREAD_ID', 'codex'),
    ('ANTIGRAVITY_CONVERSATION_ID', 'antigravity'),
)


def read_arg(argv, flag):
    args = argv or []
    for i, arg in enumerate(args):
        if arg == flag:
            return args[i + 1] if i + 1 < len(args) else None
        if isinstance(arg, str) and arg.startswith(flag + '='):
            return arg[len(flag) + 1:] or None
    return None


def resolve_vendor(payload, env=None, argv=None):
    env = env if env is not None else os.environ
    declared = read_arg(argv, '--vendor')
    if declared:
        return declared
    payload_vendor = payload.get('vendor') if isinstance(payload, dict) else None
    if isinstance(payload_vendor, str) and payload_vendor:
        return payload_vendor
    for key, vendor in HOST_VENDOR_ENV_SIGNALS:
        if env.get(key):
            return vendor
    return None
