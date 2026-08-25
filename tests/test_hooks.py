#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit Tests for Antigravity Hooks (Python 3.8+)
Covers:
1. PreInvocation: inject_session_context.py (session_id, is_main, title, module_key, timestamps, memory_docs, todo)
2. PreToolUse: enforce_allowlist.py (read-only tools, allowed write, directory write, denied write)
"""

import os
import sys
import json
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts", "hooks")))
from inject_session_context import process_payload as process_inject_payload, get_session_details
from enforce_allowlist import process_payload as process_allowlist_payload


class TestAntigravityHooks(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="test_hooks_py_")
        self.agent_dir = os.path.join(self.temp_dir, ".agents", "task-loop")
        os.makedirs(self.agent_dir, exist_ok=True)

        sessions_data = {
            "schema_version": 1,
            "main_thread_id": "main-thread-uuid-1234",
            "sessions": [
                {
                    "session_id": "main-thread-uuid-1234",
                    "title": "[主会话] 任务编排 & 治理中枢",
                    "is_main": True,
                    "created_at": "2026-08-21T08:54:04Z",
                    "last_active_at": "2026-08-25T02:02:46Z"
                },
                {
                    "session_id": "hook-topic-uuid-5678",
                    "title": "[钩子专题] Hooks体系 & 状态拦截",
                    "summary": "Google Antigravity 钩子体系与事件拦截",
                    "memory_docs": ["docs/memory/hook.md"],
                    "is_main": False,
                    "created_at": "2026-08-25T05:48:23Z",
                    "last_active_at": "2026-08-25T05:48:23Z"
                }
            ],
            "modules": {
                "hook": {
                    "session_id": "hook-topic-uuid-5678",
                    "title": "[钩子专题] Hooks体系 & 状态拦截",
                    "memory_docs": ["docs/memory/hook.md"]
                }
            }
        }
        with open(os.path.join(self.agent_dir, "sessions.json"), "w", encoding="utf-8") as f:
            json.dump(sessions_data, f, indent=2)

        todo_data = {
            "items": [
                {
                    "id": "TASK-HOOK-01",
                    "title": "开发并验证 Hooks 体系",
                    "assignee_thread_id": "hook-topic-uuid-5678",
                    "status": "in_progress",
                    "allowlist": ["docs/memory/hook.md", "scripts/hooks/"]
                }
            ]
        }
        with open(os.path.join(self.agent_dir, "todo.json"), "w", encoding="utf-8") as f:
            json.dump(todo_data, f, indent=2)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_pre_invocation_main_session(self):
        payload = {
            "conversationId": "main-thread-uuid-1234",
            "workspacePaths": [self.temp_dir],
            "invocationNum": 1
        }
        res = process_inject_payload(payload)
        self.assertIn("injectSteps", res)
        self.assertEqual(len(res["injectSteps"]), 1)
        msg = res["injectSteps"][0]["ephemeralMessage"]
        self.assertIn("是否主会话: 是 (Main Thread)", msg)
        self.assertIn("[主会话] 任务编排 & 治理中枢", msg)

    def test_pre_invocation_topic_session(self):
        payload = {
            "conversationId": "hook-topic-uuid-5678",
            "workspacePaths": [self.temp_dir],
            "invocationNum": 2
        }
        res = process_inject_payload(payload)
        self.assertEqual(len(res["injectSteps"]), 1)
        msg = res["injectSteps"][0]["ephemeralMessage"]
        self.assertIn("会话 ID: hook-topic-uuid-5678", msg)
        self.assertIn("是否主会话: 否 (Topic Session)", msg)
        self.assertIn("专题主题: [钩子专题] Hooks体系 & 状态拦截", msg)
        self.assertIn("所属模块: hook", msg)
        self.assertIn("创建时间: 2026-08-25T05:48:23Z", msg)
        self.assertIn("关联记忆文档: docs/memory/hook.md", msg)
        self.assertIn("TASK-HOOK-01", msg)
        self.assertIn("Allowlist", msg)

    def test_pre_invocation_unknown_session(self):
        payload = {
            "conversationId": "unknown-uuid-9999",
            "workspacePaths": [self.temp_dir],
            "invocationNum": 1
        }
        res = process_inject_payload(payload)
        self.assertEqual(len(res["injectSteps"]), 1)
        self.assertIn("unknown-uuid-9999", res["injectSteps"][0]["ephemeralMessage"])

    def test_pre_tool_use_read_tool(self):
        payload = {
            "conversationId": "hook-topic-uuid-5678",
            "workspacePaths": [self.temp_dir],
            "toolCall": {
                "name": "view_file",
                "args": {
                    "AbsolutePath": os.path.join(self.temp_dir, "secret.env")
                }
            }
        }
        res = process_allowlist_payload(payload)
        self.assertEqual(res["decision"], "allow")

    def test_pre_tool_use_write_allowed(self):
        payload = {
            "conversationId": "hook-topic-uuid-5678",
            "workspacePaths": [self.temp_dir],
            "toolCall": {
                "name": "replace_file_content",
                "args": {
                    "TargetFile": os.path.join(self.temp_dir, "docs", "memory", "hook.md"),
                    "Instruction": "update"
                }
            }
        }
        res = process_allowlist_payload(payload)
        self.assertEqual(res["decision"], "allow")

    def test_pre_tool_use_write_dir_allowed(self):
        payload = {
            "conversationId": "hook-topic-uuid-5678",
            "workspacePaths": [self.temp_dir],
            "toolCall": {
                "name": "write_to_file",
                "args": {
                    "TargetFile": os.path.join(self.temp_dir, "scripts", "hooks", "test.py"),
                    "CodeContent": "# test"
                }
            }
        }
        res = process_allowlist_payload(payload)
        self.assertEqual(res["decision"], "allow")

    def test_pre_tool_use_write_denied(self):
        payload = {
            "conversationId": "hook-topic-uuid-5678",
            "workspacePaths": [self.temp_dir],
            "toolCall": {
                "name": "write_to_file",
                "args": {
                    "TargetFile": os.path.join(self.temp_dir, "src", "auth", "dangerous.py"),
                    "CodeContent": "# dangerous"
                }
            }
        }
        res = process_allowlist_payload(payload)
        self.assertEqual(res["decision"], "deny")
        self.assertIn("不在当前任务白名单", res["reason"])


if __name__ == "__main__":
    unittest.main()
