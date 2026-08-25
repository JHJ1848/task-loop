#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for Summarize Project Sessions & Topic Inference
"""

import sys
from pathlib import Path

# Add scripts directory
scripts_dir = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(scripts_dir))

from summarize_project_sessions import infer_suggested_module, format_markdown_table, summarize_project_sessions


def test_infer_suggested_module():
    session1 = {
        "title": "Fix session scanner provider",
        "recent_touched_files": ["scripts/providers/get_agy_project_sessions.py"],
        "recent_prompts": ["check session sdk"]
    }
    assert infer_suggested_module(session1) == "session_control", f"Got {infer_suggested_module(session1)}"

    session2 = {
        "title": "Update dispatch packet 123 logic",
        "recent_touched_files": ["scripts/new_task_loop_dispatch_packet.py"],
        "recent_prompts": ["generate dispatch packet"]
    }
    assert infer_suggested_module(session2) == "dispatch_engine", f"Got {infer_suggested_module(session2)}"

    session3 = {
        "title": "Acquire lease lock",
        "recent_touched_files": ["scripts/acquire_task_loop_lease.py"],
        "recent_prompts": ["lease test"]
    }
    assert infer_suggested_module(session3) == "lease_manager", f"Got {infer_suggested_module(session3)}"


def test_format_markdown_table():
    mock_sessions = [
        {
            "vendor": "antigravity",
            "session_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
            "title": "Inspect session module",
            "last_active_at": "2026-08-25T01:42:46.000Z",
            "is_active": True,
            "recent_touched_files": ["scripts/find_project_sessions.py"]
        },
        {
            "vendor": "claude",
            "session_id": "11111111-2222-3333-4444-555555555555",
            "title": "Claude test run",
            "last_active_at": "2026-08-24T01:00:00.000Z",
            "is_active": False,
            "recent_touched_files": []
        }
    ]

    table = format_markdown_table(mock_sessions)
    assert "| ANTIGRAVITY | `cdd1ca5c...` |" in table
    assert "| CLAUDE | `11111111...` |" in table
    assert "活动 (Active)" in table
    assert "离线 (Idle)" in table


def run_all_tests():
    test_infer_suggested_module()
    test_format_markdown_table()
    print("Summarize project sessions test PASSED!")


if __name__ == "__main__":
    run_all_tests()
