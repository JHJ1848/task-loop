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

from scripts.inspect_agy_sessions import inspect_agy_sessions, format_relative_time, probe_dispatch_session, check_agentapi_rpc, fetch_session_transcript


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

    def test_probe_dispatch_session(self):
        temp_dir = tempfile.mkdtemp(prefix="agy-probe-py-")
        temp_brain = os.path.join(temp_dir, "brain")
        os.makedirs(temp_brain, exist_ok=True)

        dormant_sess_id = "44444444-4444-4444-4444-444444444444"
        dormant_log_dir = os.path.join(temp_brain, dormant_sess_id, ".system_generated", "logs")
        os.makedirs(dormant_log_dir, exist_ok=True)
        dormant_log_file = os.path.join(dormant_log_dir, "transcript.jsonl")

        now = datetime.now(timezone.utc)
        two_hours_ago = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")

        # Write sidebus dispatch message only (no MODEL step after)
        with open(dormant_log_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Initial message", "created_at": two_hours_ago}) + "\n")
            f.write(json.dumps({"type": "PLANNER_RESPONSE", "source": "MODEL", "content": "Initial response", "created_at": two_hours_ago}) + "\n")
            f.write(json.dumps({"type": "USER_INPUT", "source": "SYSTEM", "content": "[主会话派单任务: WORK (测试任务)] 请执行修复", "created_at": now.isoformat().replace("+00:00", "Z")}) + "\n")

        dormant_probe = probe_dispatch_session(dormant_sess_id, brain_path=temp_brain)
        self.assertTrue(dormant_probe["found"])
        self.assertFalse(dormant_probe["thread_running"])
        self.assertFalse(dormant_probe["is_working"], "Session with no MODEL step after dispatch should NOT be working")
        self.assertFalse(dormant_probe["can_enter_120s_gate"], "Dormant session must NOT enter 120s gate")
        self.assertTrue(dormant_probe["should_loop_30s_probe"], "Dormant session must continue 30s probe loop")
        self.assertEqual(dormant_probe["working_status"], "DORMANT_NOT_ACTIVATED")
        self.assertEqual(dormant_probe["model_steps_count"], 0)
        self.assertIsNotNone(dormant_probe["alert_card"])
        self.assertIn("🔴 专题未激活告警卡", dormant_probe["alert_card"])

        # Test IN_PROGRESS streaming generation state
        in_prog_sess_id = "55555555-5555-5555-5555-555555555555"
        in_prog_dir = os.path.join(temp_brain, in_prog_sess_id, ".system_generated", "logs")
        os.makedirs(in_prog_dir, exist_ok=True)
        in_prog_file = os.path.join(in_prog_dir, "transcript.jsonl")
        with open(in_prog_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "USER_INPUT", "source": "SYSTEM", "content": "[主会话派单任务: WORK] 开始执行", "created_at": now.isoformat().replace("+00:00", "Z")}) + "\n")
            f.write(json.dumps({"type": "PLANNER_RESPONSE", "source": "MODEL", "status": "IN_PROGRESS", "thinking": "Thinking in flight...", "created_at": now.isoformat().replace("+00:00", "Z")}) + "\n")

        in_prog_probe = probe_dispatch_session(in_prog_sess_id, brain_path=temp_brain)
        self.assertTrue(in_prog_probe["found"])
        self.assertTrue(in_prog_probe["thread_running"], "IN_PROGRESS step must set thread_running to True")
        self.assertTrue(in_prog_probe["is_working"], "IN_PROGRESS step must set is_working to True")
        self.assertTrue(in_prog_probe["can_enter_120s_gate"], "IN_PROGRESS step must allow 120s gate admission")
        self.assertFalse(in_prog_probe["should_loop_30s_probe"])
        self.assertEqual(in_prog_probe["in_progress_steps_count"], 1)
        self.assertEqual(in_prog_probe["thinking_steps_count"], 1)
        self.assertIsNone(in_prog_probe["alert_card"])

        # Append completed MODEL step to simulate full turn
        with open(dormant_log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "type": "PLANNER_RESPONSE",
                "source": "MODEL",
                "status": "DONE",
                "thinking": "Analyzing task...",
                "tool_calls": [{"name": "view_file", "args": {}}],
                "created_at": now.isoformat().replace("+00:00", "Z")
            }) + "\n")

        active_probe = probe_dispatch_session(dormant_sess_id, brain_path=temp_brain)
        self.assertTrue(active_probe["found"])
        self.assertTrue(active_probe["is_working"], "Session with MODEL step after dispatch SHOULD be working")
        self.assertTrue(active_probe["can_enter_120s_gate"], "Active session allows 120s gate admission")
        self.assertFalse(active_probe["should_loop_30s_probe"])
        self.assertEqual(active_probe["working_status"], "WORKING_IN_PROGRESS")
        self.assertEqual(active_probe["model_steps_count"], 1)
        self.assertEqual(active_probe["tool_calls_count"], 1)
        self.assertEqual(active_probe["thinking_steps_count"], 1)
        self.assertIsNone(active_probe["alert_card"])

        # Test 5: 彻底根除历史旧步骤（如 3 天前）产生的假阳性绿灯 (Stale history step false-positive elimination)
        stale_sess_id = "66666666-6666-6666-6666-666666666666"
        stale_dir = os.path.join(temp_brain, stale_sess_id, ".system_generated", "logs")
        os.makedirs(stale_dir, exist_ok=True)
        stale_file = os.path.join(stale_dir, "transcript.jsonl")
        three_days_ago_dt = now - timedelta(days=3)
        three_days_ago_iso = three_days_ago_dt.isoformat().replace("+00:00", "Z")

        with open(stale_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Old conversation", "created_at": three_days_ago_iso}) + "\n")
            f.write(json.dumps({"type": "USER_INPUT", "source": "SYSTEM", "content": "[主会话派单任务: WORK] 3天前下发的任务", "created_at": three_days_ago_iso}) + "\n")
            f.write(json.dumps({"type": "PLANNER_RESPONSE", "source": "MODEL", "status": "DONE", "thinking": "3天前的旧响应", "created_at": three_days_ago_iso}) + "\n")

        # 物理修改文件 mtime 为 3 天前
        past_epoch = three_days_ago_dt.timestamp()
        os.utime(stale_file, (past_epoch, past_epoch))

        stale_probe = probe_dispatch_session(stale_sess_id, brain_path=temp_brain, fresh_window_sec=30, skip_rpc=True)
        self.assertTrue(stale_probe["found"])
        self.assertFalse(stale_probe["is_working"], "3-day-old step must NOT be considered is_working (False Positive Eliminated!)")
        self.assertFalse(stale_probe["can_enter_gate"], "Stale session must NOT enter gate")
        self.assertFalse(stale_probe["can_enter_120s_gate"])
        self.assertTrue(stale_probe["should_loop_probe"])
        self.assertFalse(stale_probe["dimensions"]["inference_step"]["is_fresh"], "Inference step must be flagged is_fresh: False")
        self.assertGreater(stale_probe["dimensions"]["inference_step"]["step_age_sec"], 86400, "Step age must be > 1 day")
        self.assertIsNotNone(stale_probe["alert_card"])
        self.assertIn("🔴 专题未激活告警卡", stale_probe["alert_card"])

        # Test 6: 4维物理交叉验证指标健全性 (Presence 在场锁 + 文件增量)
        presence_mock_dir = os.path.join(temp_dir, "presence")
        os.makedirs(presence_mock_dir, exist_ok=True)
        lock_file_path = os.path.join(presence_mock_dir, f"{stale_sess_id}.lock")
        with open(lock_file_path, "w", encoding="utf-8") as f:
            f.write("active_gui_window")

        # 当存在在场锁但文件无近期写入时，仍未工作
        presence_only_probe = probe_dispatch_session(stale_sess_id, brain_path=temp_brain, presence_path=presence_mock_dir, skip_rpc=True)
        self.assertTrue(presence_only_probe["dimensions"]["presence"]["is_present"], "Presence lock should be detected")
        self.assertFalse(presence_only_probe["dimensions"]["filesystem"]["has_recent_write"], "Old file should not have recent write")
        self.assertFalse(presence_only_probe["is_working"], "Presence alone without recent write is not working")

        # 当在场锁存在 + 文件发生新鲜物理写入 (近 10s 内更新)
        fresh_write_time = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with open(stale_file, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "type": "USER_INPUT",
                "source": "USER_EXPLICIT",
                "content": "User typed in foreground window",
                "created_at": fresh_write_time
            }) + "\n")

        active_presence_probe = probe_dispatch_session(stale_sess_id, brain_path=temp_brain, presence_path=presence_mock_dir, skip_rpc=True)
        self.assertTrue(active_presence_probe["dimensions"]["presence"]["is_present"])
        self.assertTrue(active_presence_probe["dimensions"]["filesystem"]["has_recent_write"], "Recent write should be detected")
        self.assertTrue(active_presence_probe["is_working"], "Presence + Recent Write should validate working state")
        self.assertTrue(active_presence_probe["can_enter_gate"])

        # Test 7: Windows 环境下 RPC 探测 EINVAL 根除验证与保护性连通性
        skipped_rpc = check_agentapi_rpc(stale_sess_id, {"skip_rpc": True})
        self.assertTrue(skipped_rpc["skipped"])
        self.assertTrue(skipped_rpc["available"])

        real_rpc = check_agentapi_rpc(stale_sess_id)
        self.assertIsInstance(real_rpc["available"], bool)
        # Test 8: 转录内省原语 fetch_session_transcript 与 recent_trajectory 校验
        transcript_test_id = "77777777-7777-7777-7777-777777777777"
        t_dir = os.path.join(temp_brain, transcript_test_id, ".system_generated", "logs")
        os.makedirs(t_dir, exist_ok=True)
        t_file = os.path.join(t_dir, "transcript.jsonl")
        with open(t_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"step_index": 0, "type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Step 0 user query", "created_at": "2026-10-16T01:00:00Z"}) + "\n")
            f.write(json.dumps({"step_index": 1, "type": "PLANNER_RESPONSE", "source": "MODEL", "status": "DONE", "thinking": "Deep thoughts step 1", "content": "Model answer 1", "created_at": "2026-10-16T01:01:00Z"}) + "\n")
            f.write(json.dumps({
                "step_index": 2,
                "type": "PLANNER_RESPONSE",
                "source": "MODEL",
                "status": "DONE",
                "thinking": "Deep thoughts step 2 with long reasoning analysis",
                "tool_calls": [{"name": "run_command", "args": {"CommandLine": "npm test"}}],
                "content": "Executing command...",
                "created_at": "2026-10-16T01:02:00Z"
            }) + "\n")

        introspect_res = fetch_session_transcript(transcript_test_id, brain_path=temp_brain, tail=2)
        self.assertTrue(introspect_res["found"])
        self.assertEqual(introspect_res["total_steps"], 3)
        self.assertEqual(len(introspect_res["steps"]), 2)
        self.assertEqual(introspect_res["steps"][0]["step_index"], 1)
        self.assertEqual(introspect_res["steps"][1]["step_index"], 2)
        self.assertEqual(len(introspect_res["steps"][1]["tool_calls"]), 1)
        self.assertEqual(introspect_res["steps"][1]["tool_calls"][0]["name"], "run_command")
        self.assertIn("Deep thoughts step 2", introspect_res["steps"][1]["thinking_preview"])

        # probe_dispatch_session 中 recent_trajectory 校验
        probe_with_trajectory = probe_dispatch_session(transcript_test_id, brain_path=temp_brain, skip_rpc=True)
        self.assertIsInstance(probe_with_trajectory["recent_trajectory"], list)
        self.assertEqual(len(probe_with_trajectory["recent_trajectory"]), 3)
        self.assertEqual(probe_with_trajectory["recent_trajectory"][2]["action_summary"], "tool_calls(run_command)")

        # 不存在会话测试
        not_found_res = fetch_session_transcript("non-existent-uuid", brain_path=temp_brain)
        self.assertFalse(not_found_res["found"])
        self.assertEqual(len(not_found_res["steps"]), 0)
        self.assertIsNotNone(not_found_res.get("error"))

        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
