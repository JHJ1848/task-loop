#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[Hook Script] Inject Session Context for ZCode (SessionStart / UserPromptSubmit)

ZCode protocol adapter over the shared AGY core logic
(scripts/hooks/inject_session_context.py). Difference matrix:

  Dimension      | AGY PreInvocation            | ZCode (this adapter)
  ---------------+------------------------------+---------------------------------
  Input channel  | stdin { conversationId, ... }| stdin Claude-Code-style payload
  Session ID key | conversationId               | session_id | sessionId | $CLAUDE_CODE_SESSION_ID | $ZCODE_SESSION_ID
  Workspace root | workspacePaths[0]            | cwd | $ZCODE_PROJECT_DIR | $CLAUDE_PROJECT_DIR
  Output shape   | { injectSteps:[{ephemeralMessage}] } | { hookSpecificOutput:{ hookEventName, additionalContext } }
  Trigger events | PreInvocation (every turn)   | SessionStart + UserPromptSubmit (per-turn parity)

The injected message body (sessions.json awareness + [Plugin: task-loop |
topic rules) is 100% reused from the shared core via direct import, so both
hosts render the exact same context contract.

Output JSON is strictly schema-validated by the ZCode hook runner: only
`hookSpecificOutput` (+ optional suppressOutput/systemMessage) are accepted at
top level. On any internal error this adapter fails open with empty output and
exit code 0.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import host_vendor
import inject_session_context as core

UUID_SESSION_ID = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE
)


def extract_session_id(payload, env=None):
    env = env if env is not None else os.environ
    return (
        payload.get('session_id')
        or payload.get('sessionId')
        or env.get('CLAUDE_CODE_SESSION_ID')
        or env.get('CLAUDE_SESSION_ID')
        or env.get('ZCODE_SESSION_ID')
        or None
    )


def resolve_workspace(payload, env=None):
    env = env if env is not None else os.environ
    cwd = payload.get('cwd')
    if isinstance(cwd, str) and cwd:
        return cwd
    workspace_paths = payload.get('workspacePaths')
    if isinstance(workspace_paths, list) and len(workspace_paths) > 0:
        return workspace_paths[0]
    return env.get('ZCODE_PROJECT_DIR') or env.get('CLAUDE_PROJECT_DIR') or os.getcwd()


def extract_event_name(payload):
    raw = payload.get('hook_event_name') or payload.get('hookEventName') or ''
    if raw in ('SessionStart', 'UserPromptSubmit'):
        return raw
    return 'UserPromptSubmit'


def process_payload(payload, env=None, argv=None):
    p = dict(payload) if isinstance(payload, dict) else {}
    p.setdefault("requested_vendor", "zcode")
    return core.process_payload(p, env, argv)


def main():
    raw_input_data = ''
    try:
        if not sys.stdin.isatty():
            raw_input_data = sys.stdin.read()
    except Exception:
        raw_input_data = ''

    payload = {}
    if raw_input_data.strip():
        try:
            payload = json.loads(raw_input_data)
            if not isinstance(payload, dict):
                payload = {}
        except Exception:
            payload = {}
    elif '--payload' in sys.argv:
        idx = sys.argv.index('--payload')
        if idx + 1 < len(sys.argv):
            try:
                loaded = json.loads(sys.argv[idx + 1])
                if isinstance(loaded, dict):
                    payload = loaded
            except Exception:
                payload = {}

    # CLI --event flag lifts SessionStart dispatches whose stdin may be minimal.
    if '--event' in sys.argv:
        eidx = sys.argv.index('--event')
        if eidx + 1 < len(sys.argv) and sys.argv[eidx + 1] == 'SessionStart':
            payload.setdefault('hook_event_name', 'SessionStart')

    result = process_payload(payload, None, sys.argv)
    if not result:
        return  # empty output + exit 0 = healthy no-op for strict schema
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
