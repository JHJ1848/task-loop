#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for ZCode Hook Protocol Adapters (Python)
Covers inject_session_context_zcode.py and enforce_allowlist_zcode.py.
"""

import importlib
import json
import os
import sys
import tempfile
import shutil
from pathlib import Path

SCRIPTS_HOOKS = Path(__file__).resolve().parent.parent / "scripts" / "hooks"
sys.path.insert(0, str(SCRIPTS_HOOKS))

inject_adapter = importlib.import_module("inject_session_context_zcode")
gate_adapter = importlib.import_module("enforce_allowlist_zcode")
core_gate = importlib.import_module("enforce_allowlist")


def write_zcode_registry(ws, session_ids):
    agent_dir = Path(ws) / ".agents" / "task-loop"
    agent_dir.mkdir(parents=True, exist_ok=True)
    registry = {
        "schema_version": 4,
        "vendors": {
            "zcode": {
                "vendor": "zcode",
                "main_thread_id": None,
                "modules": {},
                "sessions": [{"session_id": session_id, "vendor": "zcode", "is_main": False} for session_id in session_ids],
            }
        },
    }
    (agent_dir / "sessions.json").write_text(json.dumps(registry, indent=2), encoding="utf-8")


def test_inject_contract():
    ws = tempfile.mkdtemp(prefix="test_zcode_hooks_py_")
    try:
        payload = {"session_id": "sess_abc123_py", "hook_event_name": "UserPromptSubmit", "cwd": ws, "isTest": True}
        out = inject_adapter.process_payload(payload, env={})
        assert "hookSpecificOutput" in out, "missing hookSpecificOutput"
        assert out["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
        ctx = out["hookSpecificOutput"]["additionalContext"]
        assert "[Plugin: task-loop | 会话上下文感知]" in ctx, "namespace header missing"
        assert out.get("suppressOutput") is True
    finally:
        shutil.rmtree(ws, ignore_errors=True)


def test_inject_env_fallback_and_noop():
    ws = tempfile.mkdtemp(prefix="test_zcode_hooks2_py_")
    try:
        env = {"CLAUDE_SESSION_ID": "sess_env_fallback", "ZCODE_PROJECT_DIR": ws}
        out = inject_adapter.process_payload({"cwd": ws, "isTest": True}, env=env)
        assert "sess_env_fallback" in out["hookSpecificOutput"]["additionalContext"]

        start = inject_adapter.process_payload(
            {"session_id": "sess_start1", "hook_event_name": "SessionStart", "cwd": ws, "isTest": True}, env={}
        )
        assert start["hookSpecificOutput"]["hookEventName"] == "SessionStart"

        assert inject_adapter.process_payload({"cwd": ws, "isTest": True}, env={}) == {}
    finally:
        shutil.rmtree(ws, ignore_errors=True)


class _AllowlistEnv:
    def __init__(self):
        self.prev = os.environ.get("TASK_LOOP_ALLOWLIST")
        self.prev_zcode_session = os.environ.get("ZCODE_SESSION_ID")

    def __enter__(self):
        os.environ["TASK_LOOP_ALLOWLIST"] = '["src/**"]'
        os.environ["ZCODE_SESSION_ID"] = "sess_gate1"
        return self

    def __exit__(self, *a):
        if self.prev is None:
            os.environ.pop("TASK_LOOP_ALLOWLIST", None)
        else:
            os.environ["TASK_LOOP_ALLOWLIST"] = self.prev
        if self.prev_zcode_session is None:
            os.environ.pop("ZCODE_SESSION_ID", None)
        else:
            os.environ["ZCODE_SESSION_ID"] = self.prev_zcode_session


def test_gate_deny_and_allow():
    ws = tempfile.mkdtemp(prefix="test_zcode_gate_py_")
    try:
        write_zcode_registry(ws, ["sess_gate1"])
        with _AllowlistEnv():
            deny_payload = {
                "session_id": "sess_gate1",
                "tool_name": "Edit",
                "tool_input": {"file_path": os.path.join(ws, "README.md")},
                "cwd": ws,
            }
            out = gate_adapter.process_payload(deny_payload, env={})
            assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
            assert out["hookSpecificOutput"]["permissionDecisionReason"]

            allow_out = gate_adapter.process_payload(
                {**deny_payload, "tool_input": {"file_path": os.path.join(ws, "src", "app.js")}}, env={}
            )
            assert allow_out == {}

            unregistered_out = gate_adapter.process_payload(
                {
                    **deny_payload,
                    "session_id": "sess_unregistered",
                    "tool_input": {"file_path": os.path.join(ws, "src", "app.js")},
                },
                env={},
            )
            assert unregistered_out["hookSpecificOutput"]["permissionDecision"] == "deny"

            read_out = gate_adapter.process_payload({**deny_payload, "tool_name": "Read"}, env={})
            assert read_out == {}
    finally:
        shutil.rmtree(ws, ignore_errors=True)


def test_core_agy_tools_still_guarded():
    ws = tempfile.mkdtemp(prefix="test_zcode_agy_py_")
    try:
        with _AllowlistEnv():
            agy_deny = core_gate.process_payload({
                "toolCall": {"name": "write_to_file", "args": {"TargetFile": os.path.join(ws, "evil.md")}},
                "conversationId": "sess_agy",
                "workspacePaths": [ws],
            })
            assert agy_deny["decision"] == "deny"
    finally:
        shutil.rmtree(ws, ignore_errors=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    test_inject_contract()
    test_inject_env_fallback_and_noop()
    test_gate_deny_and_allow()
    test_core_agy_tools_still_guarded()
    print("Python ZCode Hook Adapter tests PASSED!")
