#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for Schema v4 vendor-partitioned state store (task_loop_state.py)
覆盖: 动态扩展 / 厂商隔离 / 旧格式迁移 / 点路径查询 / 兼容读。
"""

import importlib.util
import json
import os
import sys
import tempfile
import shutil
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "task_loop_state", Path(__file__).resolve().parent.parent / "scripts" / "task_loop_state.py"
)
store = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(store)


def fresh_file(name):
    d = tempfile.mkdtemp(prefix="test_v4_")
    return d, os.path.join(d, name)


def test_dynamic_vendor_extension():
    _, file = fresh_file("sessions.json")
    store.write_partition(file, "zcode", {"main_thread_id": "sess_z1", "modules": {"hook": {"session_id": "sess_z1"}}, "sessions": []})
    store.write_partition(file, "mistral", {"main_thread_id": "sess_m1", "modules": {}, "sessions": []})

    doc = store.read_json(file)
    assert doc["schema_version"] == 4
    assert sorted(doc["vendors"].keys()) == ["mistral", "zcode"]
    assert "main_thread_id" not in doc and "modules" not in doc, "v4 top-level must carry no per-vendor state"
    print("DynamicVendorExtension PASSED!")


def test_vendor_isolation():
    _, file = fresh_file("sessions.json")
    store.write_partition(file, "zcode", {"main_thread_id": "sess_z", "modules": {"hook": {"session_id": "sess_z_hook"}}, "sessions": [{"session_id": "sess_z"}]})
    store.write_partition(file, "antigravity", {"main_thread_id": "sess_a", "modules": {"hook": {"session_id": "sess_a_hook"}}, "sessions": [{"session_id": "sess_a"}]})

    z = store.get_partition(file, "zcode")
    a = store.get_partition(file, "antigravity")
    assert z["modules"]["hook"]["session_id"] == "sess_z_hook"
    assert a["modules"]["hook"]["session_id"] == "sess_a_hook"

    store.write_partition(file, "zcode", {"main_thread_id": "sess_z2", "modules": {"hook": {"session_id": "sess_z_hook2"}}, "sessions": []})
    doc = store.read_json(file)
    assert doc["vendors"]["antigravity"]["main_thread_id"] == "sess_a", "antigravity partition must be untouched"
    assert doc["vendors"]["zcode"]["modules"]["hook"]["session_id"] == "sess_z_hook2"
    print("VendorIsolation PASSED!")


def test_legacy_migration():
    _, file = fresh_file("sessions_v3.json")
    with open(file, "w", encoding="utf-8") as fh:
        json.dump({
            "schema_version": 3,
            "main_thread_id": "sess_top",
            "current_vendor": "zcode",
            "modules": {"main": {"session_id": "sess_top"}},
            "sessions": [{"session_id": "sess_top"}],
            "vendors": {"antigravity": {"vendor": "antigravity", "main_thread_id": "sess_agy", "modules": {}, "sessions": []}},
        }, fh, ensure_ascii=False)

    store.write_partition(file, "zcode", {"main_thread_id": "sess_top", "modules": {"main": {"session_id": "sess_top"}}, "sessions": [{"session_id": "sess_top"}]})
    doc = store.read_json(file)
    assert doc["schema_version"] == 4
    assert doc["vendors"]["antigravity"]["main_thread_id"] == "sess_agy", "v3 vendors must be preserved"
    assert doc["vendors"]["zcode"]["main_thread_id"] == "sess_top"

    _, f2 = fresh_file("sessions_v2.json")
    with open(f2, "w", encoding="utf-8") as fh:
        json.dump({"schema_version": 2, "main_thread_id": "sess_v2", "modules": {"main": {"session_id": "sess_v2"}}, "sessions": []}, fh)
    store.write_partition(f2, "claude", {"main_thread_id": "sess_v2", "modules": {"main": {"session_id": "sess_v2"}}, "sessions": []})
    doc2 = store.read_json(f2)
    assert doc2["schema_version"] == 4
    assert doc2["vendors"]["claude"]["main_thread_id"] == "sess_v2"
    print("LegacyMigration PASSED!")


def test_topics_and_query():
    _, file = fresh_file("topics.json")
    store.write_partition(file, "zcode", {"topics": [{
        "topic_key": "hook", "name": "[钩子专题]", "session_id": "sess_z",
        "vendor": "zcode", "resumable": True, "tags": ["hook"], "memory_doc": "docs/memory/hook.md",
    }]}, {"kind": "topics"})
    part = store.get_partition(file, "zcode")
    assert part["topics"][0]["topic_key"] == "hook"

    assert store.get_dot_path(part, "topics.0.session_id") == "sess_z"
    assert store.get_dot_path(part, "nope.nada") is None

    assert store.normalize_vendor("agy") == "antigravity"
    assert store.normalize_vendor("Claude-Code") == "claude"
    print("TopicsAndQuery PASSED!")


def test_compat_read_v4_file():
    _, file = fresh_file("sessions_compat.json")
    store.write_partition(file, "zcode", {"main_thread_id": "sess_z", "modules": {}, "sessions": []})
    assert store.get_partition(file, "zcode")["main_thread_id"] == "sess_z"
    assert store.get_partition(file, "codex") is None
    assert store.detect_vendor({"ZCODE_SESSION_ID": "sess_x"}) == "zcode"
    print("CompatRead PASSED!")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    test_dynamic_vendor_extension()
    test_vendor_isolation()
    test_legacy_migration()
    test_topics_and_query()
    test_compat_read_v4_file()
    print("ALL State-Partition Python Tests PASSED SUCCESSFULLY!")
