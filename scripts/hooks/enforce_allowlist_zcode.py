#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[Hook Script] Enforce Allowlist Guard for ZCode (PreToolUse)

ZCode protocol adapter over the shared AGY core logic
(scripts/hooks/enforce_allowlist.py). Difference matrix:

  Dimension      | AGY PreToolUse                       | ZCode (this adapter)
  ---------------+--------------------------------------+----------------------------------------
  Tool payload   | { toolCall: { name, args } }         | { tool_name, tool_input } (snake_case)
  File arg keys  | TargetFile / FilePath / target_path  | file_path / filePath (+ legacy fallbacks)
  Session ID key | conversationId                       | session_id | sessionId | $CLAUDE_SESSION_ID
  Allow output   | { decision: "allow" }                | empty output + exit 0 (strict-schema no-op)
  Deny output    | { decision: "deny", reason }         | { hookSpecificOutput:{ hookEventName:"PreToolUse",
                 |                                      |   permissionDecision:"deny", permissionDecisionReason } }

The whitelist resolution order (env TASK_LOOP_ALLOWLIST -> todo.json ->
dispatch/*.json) and path prefix matching are 100% reused from the shared
core. On any internal error this adapter fails open with exit code 0.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import enforce_allowlist as core


def extract_session_id(payload, env=None):
    env = env if env is not None else os.environ
    return (
        payload.get('session_id')
        or payload.get('sessionId')
        or payload.get('conversationId')
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


def normalize_tool_call(payload):
    raw_args = payload.get('tool_input', payload.get('toolInput'))
    if not isinstance(raw_args, dict):
        return None

    tool_name = payload.get('tool_name') or payload.get('toolName')
    if not tool_name or not isinstance(tool_name, str):
        return None

    # ZCode uses file_path/filePath; map onto the canonical key expected by the core.
    args = dict(raw_args)
    target = None
    for key in ('TargetFile', 'FilePath', 'file_path', 'filePath', 'target_file', 'target_path', 'path'):
        if args.get(key) is not None:
            target = args[key]
            break
    for key in ('file_path', 'filePath'):
        args.pop(key, None)
    args['TargetFile'] = target

    return {'name': tool_name, 'args': args}


def process_payload(payload, env=None):
    try:
        tool_call = normalize_tool_call(payload)
        if not tool_call:
            # Non-file-write tools (or unparseable payloads): strict-schema no-op pass.
            return {}

        ws_root = resolve_workspace(payload, env)
        conversation_id = extract_session_id(payload, env)

        result = core.process_payload({
            'toolCall': tool_call,
            'conversationId': conversation_id,
            'workspacePaths': [ws_root],
        })

        if result and result.get('decision') == 'deny':
            return {
                'suppressOutput': True,
                'systemMessage': '[task-loop Allowlist Guard] blocked an out-of-allowlist write.',
                'hookSpecificOutput': {
                    'hookEventName': 'PreToolUse',
                    'permissionDecision': 'deny',
                    'permissionDecisionReason': result.get('reason') or (
                        'Target file is outside the dispatched task allowlist.'
                    ),
                },
            }

        return {}  # allow: silent pass (empty output + exit 0)
    except Exception:
        # Fail-open on adapter errors; never wedge the host's edit pipeline.
        return {}


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
            loaded = json.loads(raw_input_data)
            if isinstance(loaded, dict):
                payload = loaded
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

    result = process_payload(payload)
    if not result:
        return  # allow via empty output + exit 0
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
