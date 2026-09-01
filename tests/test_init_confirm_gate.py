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
    memory_docs = [{"module_key": "hook"}]
    assignments = mod.resolve_module_assignments(suggestions, memory_docs)
    assert assignments["hook"]["session_id"] == "sess_hook_first", "first match must win"
    # 严格法定专题语义: 未提供 memory_docs 时仅 main 入分配
    solo = mod.resolve_module_assignments(suggestions)
    assert "hook" not in solo and "main" in solo
    print("First-match consistency PASSED!")


def test_approval_gate():
    suggestions = [
        mk_suggestion("sess_main", "main", is_main_candidate=True),
        mk_suggestion("sess_hook", "hook"),
        mk_suggestion("sess_junk", "调用"),
        mk_suggestion("sess_excluded", "debug"),
    ]
    memory_docs = [{"module_key": "hook"}, {"module_key": "main"}, {"module_key": "debug"}]
    assignments = mod.resolve_module_assignments(suggestions, memory_docs)
    alignment = [
        {"module_key": "hook", "status": "ALIGNED"},
        {"module_key": "main", "status": "ALIGNED"},
        {"module_key": "debug", "status": "MISSING_SESSION"},
    ]

    gate = mod.apply_approval_gate(assignments, alignment, {})
    approved = sorted(a["module_key"] for a in gate["approved"])
    assert approved == ["hook", "main"], f"default gate = main + aligned only, got {approved}"
    assert any(p["module_key"] == "debug" for p in gate["pending"]), "missing-session doc module needs explicit approval"

    gate2 = mod.apply_approval_gate(assignments, alignment, {"module_allowlist": ["debug"]})
    assert any(a["module_key"] == "debug" for a in gate2["approved"])

    gate3 = mod.apply_approval_gate(assignments, alignment, {"module_exclude": ["hook"]})
    assert not any(a["module_key"] == "hook" for a in gate3["approved"])
    assert any(p["module_key"] == "hook" and p["reason"] == "explicitly_excluded" for p in gate3["pending"])

    # 非法定主题 (无 memory_doc 对应) 不进分配管道, 也就不产生垃圾绑定
    junk_assignments = mod.resolve_module_assignments([mk_suggestion("sess_junk", "调用")], memory_docs)
    assert "调用" not in junk_assignments
    print("ApprovalGate PASSED!")


def test_key_hygiene():
    # 严格法定专题语义: 未知/中文碎片/角色扮演前缀标题一律 module_key=None (不生成假专题)
    junk1 = mod.infer_topic_mapping({"title": "你是一个专门负责 mock_quality 的智能体"})
    assert junk1["module_key"] is None, f"got {junk1['module_key']}"
    assert junk1["memory_doc"] is None

    junk2 = mod.infer_topic_mapping({"title": "核心功能维护   The current local time is: 2026-08-27"})
    assert junk2["module_key"] is None

    # 法定专题关键词命中 (hook 法定) 正常归位
    ok1 = mod.infer_topic_mapping({"title": "修复 hook 门禁的生命周期缺陷"})
    assert ok1["module_key"] == "hook" and ok1["memory_doc"] == "docs/memory/hook.md"

    # known_memory_keys 白名单过滤: 命中关键词但非法记忆专题 -> None
    filtered = mod.infer_topic_mapping({"title": "修复 hook 门禁"}, known_memory_keys={"session_control"})
    assert filtered["module_key"] is None

    # 硬编码 UUID 已移除: 陌生 UUID 不得触发 main 推断
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
