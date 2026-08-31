#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for init approval gate / assignment consistency / module key hygiene.
全部使用合成建议数据, 不依赖真实厂商扫描器。
"""

import importlib.util
import os
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "init_task_loop", Path(__file__).resolve().parent.parent / "scripts" / "init_task_loop.py"
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


def mk_suggestion(sid, key, vendor="antigravity", **opts):
    base = {
        "session_id": sid,
        "vendor": vendor,
        "original_title": f"session {sid}",
        "suggested_module_key": key,
        "needs_naming": False,
        "suggested_topic_name": f"[专题] {key}",
        "suggested_tags": [key, "topic"],
        "suggested_memory_doc": f"docs/memory/{key}.md",
        "resumable": False,
        "dispatch_hint": "hint",
        "is_main_candidate": False,
        "is_current_session": False,
    }
    base.update(opts)
    return base


def test_first_match_consistency():
    suggestions = [
        mk_suggestion("sess_hook_first", "hook"),
        mk_suggestion("sess_hook_second", "hook", "claude"),
        mk_suggestion("sess_main", "main", "zcode", is_main_candidate=True),
    ]
    suggestions.sort(key=lambda x: 0 if x.get("is_main_candidate") else 1)
    assignments = mod.resolve_module_assignments(suggestions)
    assert assignments["hook"]["session_id"] == "sess_hook_first", "first match must win"
    print("First-match consistency PASSED!")


def test_approval_gate():
    suggestions = [
        mk_suggestion("sess_main", "main", is_main_candidate=True),
        mk_suggestion("sess_hook", "hook"),
        mk_suggestion("sess_junk", "调用"),
        mk_suggestion("sess_excluded", "debug"),
    ]
    assignments = mod.resolve_module_assignments(suggestions)
    alignment = [
        {"module_key": "hook", "status": "ALIGNED"},
        {"module_key": "main", "status": "ALIGNED"},
    ]

    gate = mod.apply_approval_gate(assignments, alignment, {})
    approved = sorted(a["module_key"] for a in gate["approved"])
    assert approved == ["hook", "main"], f"default gate = main + aligned only, got {approved}"
    assert any(p["module_key"] == "调用" for p in gate["pending"])
    assert any(p["module_key"] == "debug" for p in gate["pending"])

    gate2 = mod.apply_approval_gate(assignments, alignment, {"module_allowlist": ["debug"]})
    assert any(a["module_key"] == "debug" for a in gate2["approved"])

    gate3 = mod.apply_approval_gate(assignments, alignment, {"module_exclude": ["hook"]})
    assert not any(a["module_key"] == "hook" for a in gate3["approved"])
    assert any(p["module_key"] == "hook" and p["reason"] == "explicitly_excluded" for p in gate3["pending"])
    print("ApprovalGate PASSED!")


def test_key_hygiene():
    junk1 = mod.infer_topic_mapping({"title": "你是一个专门负责 mock_quality 的智能体"})
    assert junk1["module_key"] == "custom_topic", f"got {junk1['module_key']}"
    assert junk1["needs_naming"] is True

    junk2 = mod.infer_topic_mapping({"title": "核心功能维护   The current local time is: 2026-08-27"})
    assert junk2["module_key"] == "custom_topic"
    assert junk2["needs_naming"] is True

    ok1 = mod.infer_topic_mapping({"title": "refactor the dispatch pipeline for worker agents"})
    assert ok1["module_key"] == "refactor" and ok1["needs_naming"] is False

    assert mod.is_valid_module_key("hook") is True
    assert mod.is_valid_module_key("调用") is False

    stranger = mod.infer_topic_mapping({
        "title": "某普通会话标题",
        "session_id": "ee94b2c5-c0c2-473f-8f71-213250ba5295",
    })
    assert stranger["module_key"] != "main", "hardcoded UUID must not force main"
    print("KeyHygiene PASSED!")


def test_title_sanitize():
    assert mod.sanitize_title("当前项目作为skill的开发仓库 \\") == "当前项目作为skill的开发仓库"
    assert mod.sanitize_title("[$init](C:\\x\\y\\SKILL.md) 标题") == "标题"
    assert mod.sanitize_title("") == "(无标题)"
    print("TitleSanitize PASSED!")


def test_resumable_fields():
    s = mk_suggestion("sess_z", "hook", "zcode")
    assert "resumable" in s and "dispatch_hint" in s
    assert mod.detect_current_vendor({"ZCODE_SESSION_ID": "sess_x"}) == "zcode"
    assert mod.detect_current_vendor({"ANTIGRAVITY_CONVERSATION_ID": "uuid"}) == "antigravity"
    assert mod.detect_current_vendor({}) is None
    print("ResumableFields PASSED!")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    test_first_match_consistency()
    test_approval_gate()
    test_key_hygiene()
    test_title_sanitize()
    test_resumable_fields()
    print("ALL init Confirm-Gate Python Tests PASSED SUCCESSFULLY!")
