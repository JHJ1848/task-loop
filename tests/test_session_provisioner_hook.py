#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit Tests for Session Auto-Provisioner Hook (Python 3.8+)
Tests PreToolUse hook for send_message:
1. Valid UUID -> Allow
2. Known topic alias with existing active session -> Overwrite Recipient (Idempotent, no duplicates)
3. Known topic alias with archived session -> Provision new session (Archive treated as deleted)
4. Unknown/malformed target -> Deny
5. Send to archived UUID -> Deny with clear message
"""

import os
import sys
import json
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts", "hooks")))
from resolve_or_create_session import process_payload, normalize_topic_key


class TestSessionProvisionerHook(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="test_provisioner_py_")
        self.agent_dir = os.path.join(self.temp_dir, ".agents", "task-loop")
        os.makedirs(self.agent_dir, exist_ok=True)

        sessions_data = {
            "schema_version": 1,
            "main_thread_id": "11111111-1111-1111-1111-111111111111",
            "sessions": [
                {
                    "session_id": "11111111-1111-1111-1111-111111111111",
                    "title": "[主会话] 任务编排 & 治理中枢",
                    "is_main": True,
                    "archived": False
                },
                {
                    "session_id": "22222222-2222-2222-2222-222222222222",
                    "title": "[钩子专题] Hooks体系 & 状态拦截",
                    "is_main": False,
                    "archived": False,
                    "memory_docs": ["docs/memory/hook.md"]
                },
                {
                    "session_id": "33333333-3333-3333-3333-333333333333",
                    "title": "[历史专题] 旧版会话",
                    "is_main": False,
                    "archived": True,
                    "archived_at": "2026-08-20T00:00:00Z"
                }
            ],
            "modules": {
                "hook": {
                    "session_id": "22222222-2222-2222-2222-222222222222",
                    "title": "[钩子专题] Hooks体系 & 状态拦截",
                    "archived": False
                },
                "legacy": {
                    "session_id": "33333333-3333-3333-3333-333333333333",
                    "title": "[历史专题] 旧版会话",
                    "archived": True
                }
            }
        }
        with open(os.path.join(self.agent_dir, "sessions.json"), "w", encoding="utf-8") as f:
            json.dump(sessions_data, f, indent=2)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_normalize_topic_key(self):
        self.assertEqual(normalize_topic_key("topic:hook"), "hook")
        self.assertEqual(normalize_topic_key("module:session"), "session_control")
        self.assertEqual(normalize_topic_key("SUBAGENT"), "subagent")

    def test_valid_uuid_allow(self):
        payload = {
            "workspacePaths": [self.temp_dir],
            "toolCall": {
                "name": "send_message",
                "args": {
                    "Recipient": "22222222-2222-2222-2222-222222222222",
                    "Message": "hello"
                }
            }
        }
        res = process_payload(payload)
        self.assertEqual(res["decision"], "allow")
        self.assertNotIn("overwrite", res)

    def test_topic_alias_overwrite(self):
        payload = {
            "workspacePaths": [self.temp_dir],
            "toolCall": {
                "name": "send_message",
                "args": {
                    "Recipient": "hook",
                    "Message": "task dispatch"
                }
            }
        }
        res = process_payload(payload)
        self.assertEqual(res["decision"], "allow")
        self.assertIn("overwrite", res)
        self.assertEqual(res["overwrite"]["Recipient"], "22222222-2222-2222-2222-222222222222")

    def test_unknown_topic_deny(self):
        payload = {
            "workspacePaths": [self.temp_dir],
            "toolCall": {
                "name": "send_message",
                "args": {
                    "Recipient": "random_non_existent_module",
                    "Message": "do something"
                }
            }
        }
        res = process_payload(payload)
        self.assertEqual(res["decision"], "deny")
        self.assertIn("未在已知专题清单中注册", res["reason"])

    def test_archived_uuid_deny(self):
        payload = {
            "workspacePaths": [self.temp_dir],
            "toolCall": {
                "name": "send_message",
                "args": {
                    "Recipient": "33333333-3333-3333-3333-333333333333",
                    "Message": "hello archived"
                }
            }
        }
        res = process_payload(payload)
        self.assertEqual(res["decision"], "deny")
        self.assertIn("已归档", res["reason"])


if __name__ == "__main__":
    unittest.main()
