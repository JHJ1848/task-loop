#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test suite for inspect_agy_sessions.py (Python)
"""

import os
import sys
import json
import shutil
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

# Force UTF-8 encoding on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Ensure project root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.inspect_agy_sessions import inspect_agy_sessions, format_relative_time


class TestInspectAgySessions(unittest.TestCase):
    def test_format_relative_time(self):
        now = datetime.now(timezone.utc)
        ten_sec_ago = (now - timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
        five_min_ago = (now - timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        two_hours_ago = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
        two_days_ago = (now - timedelta(days=2)).isoformat().replace("+00:00", "Z")

        self.assertEqual(format_relative_time(ten_sec_ago), "10 秒前")
        self.assertEqual(format_relative_time(five_min_ago), "5 分钟前")
        self.assertEqual(format_relative_time(two_hours_ago), "2 小时前")
        self.assertEqual(format_relative_time(two_days_ago), "2 天前")

    def test_inspect_agy_sessions_mock(self):
        temp_dir = tempfile.mkdtemp(prefix="agy-inspect-py-")
        temp_brain = os.path.join(temp_dir, "brain")
        temp_project = os.path.join(temp_dir, "project")
        os.makedirs(temp_brain, exist_ok=True)
        os.makedirs(os.path.join(temp_project, ".agents", "task-loop"), exist_ok=True)

        main_id = "11111111-1111-1111-1111-111111111111"
        topic_id = "22222222-2222-2222-2222-222222222222"
        unrelated_id = "33333333-3333-3333-3333-333333333333"

        registry_data = {
            "schema_version": 3,
            "vendor": "antigravity",
            "main_thread_id": main_id,
            "modules": {
                "main": {
                    "session_id": main_id,
                    "title": "[主会话] 任务编排",
                    "memory_doc": "docs/MEMORY.md"
                },
                "topic_demo": {
                    "session_id": topic_id,
                    "title": "[专题] Demo 模块",
                    "memory_doc": "docs/memory/demo.md"
                }
            },
            "sessions": [
                {
                    "session_id": main_id,
                    "is_main": True,
                    "title": "[主会话] 任务编排",
                    "module_key": "main",
                    "memory_docs": ["docs/MEMORY.md"]
                },
                {
                    "session_id": topic_id,
                    "is_main": False,
                    "title": "[专题] Demo 模块",
                    "module_key": "topic_demo",
                    "memory_docs": ["docs/memory/demo.md"]
                }
            ]
        }

        with open(os.path.join(temp_project, ".agents", "task-loop", "sessions.antigravity.json"), "w", encoding="utf-8") as f:
            json.dump(registry_data, f, indent=2, ensure_ascii=False)

        now = datetime.now(timezone.utc)
        two_min_ago = (now - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
        two_hours_ago = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")

        # Main session log
        main_log_dir = os.path.join(temp_brain, main_id, ".system_generated", "logs")
        os.makedirs(main_log_dir, exist_ok=True)
        with open(os.path.join(main_log_dir, "transcript.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "USER_INPUT", "content": f"Hello in project {temp_project}", "created_at": two_min_ago}) + "\n")
            f.write(json.dumps({"type": "PLANNER_RESPONSE", "content": "Step 1", "created_at": two_min_ago}) + "\n")

        # Topic session log
        topic_log_dir = os.path.join(temp_brain, topic_id, ".system_generated", "logs")
        os.makedirs(topic_log_dir, exist_ok=True)
        with open(os.path.join(topic_log_dir, "transcript.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "USER_INPUT", "content": f"[主会话派单任务: WORK] in {temp_project}", "created_at": two_hours_ago}) + "\n")
            f.write(json.dumps({"type": "PLANNER_RESPONSE", "content": "Done work", "created_at": two_hours_ago}) + "\n")

        # Unrelated session log
        unrelated_log_dir = os.path.join(temp_brain, unrelated_id, ".system_generated", "logs")
        os.makedirs(unrelated_log_dir, exist_ok=True)
        with open(os.path.join(unrelated_log_dir, "transcript.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "USER_INPUT", "content": "Other /unrelated/path", "created_at": two_min_ago}) + "\n")

        report = inspect_agy_sessions(root=temp_project, brain_path=temp_brain, active_window=30)

        self.assertEqual(report["total"], 2)
        self.assertEqual(report["active_count"], 1)
        self.assertEqual(report["sleeping_count"], 1)

        main_sess = next((s for s in report["sessions"] if s["session_id"] == main_id), None)
        self.assertIsNotNone(main_sess)
        self.assertTrue(main_sess["is_main"])
        self.assertEqual(main_sess["status"], "ACTIVE")
        self.assertEqual(main_sess["deep_link"], f"conversation://{main_id}")

        topic_sess = next((s for s in report["sessions"] if s["session_id"] == topic_id), None)
        self.assertIsNotNone(topic_sess)
        self.assertFalse(topic_sess["is_main"])
        self.assertEqual(topic_sess["status"], "IDLE_SLEEPING")
        self.assertEqual(topic_sess["deep_link"], f"conversation://{topic_id}")

        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
