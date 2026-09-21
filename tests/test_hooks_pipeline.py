import os
import sys
import json
import subprocess
import unittest


MOCK_MAIN_ID = "11111111-2222-3333-4444-555555555555"
MOCK_TOPIC_ID = "83bae782-1e95-4923-a76f-2141fe8c5c61"
MOCK_CODEX_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class TestHooksPipeline(unittest.TestCase):
    def setUp(self):
        import time
        self.root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        self.inject_script = os.path.join(self.root_dir, "scripts", "hooks", "inject_session_context.py")
        self.allowlist_script = os.path.join(self.root_dir, "scripts", "hooks", "enforce_allowlist.py")
        self.sandbox_dir = os.path.join(self.root_dir, f".test_sandbox_pipeline_py_{int(time.time() * 1000)}")
        agent_dir = os.path.join(self.sandbox_dir, ".agents", "task-loop")
        os.makedirs(agent_dir, exist_ok=True)
        sessions_data = {
            "schema_version": 4,
            "vendors": {
                "antigravity": {
                    "vendor": "antigravity",
                    "main_thread_id": MOCK_MAIN_ID,
                    "sessions": [
                        {
                            "session_id": MOCK_MAIN_ID,
                            "title": "[主会话] 任务编排 & 治理中枢",
                            "is_main": True,
                            "created_at": "2026-08-21T08:54:04Z",
                            "last_active_at": "2026-08-25T02:02:46Z"
                        },
                        {
                            "session_id": MOCK_TOPIC_ID,
                            "title": "[专题] 会话控制与内省",
                            "summary": "跨厂商会话日志反向内省",
                            "memory_docs": ["docs/memory/session_control.md"],
                            "module_key": "session_control",
                            "is_main": False,
                            "created_at": "2026-08-25T05:48:23Z",
                            "last_active_at": "2026-08-25T05:48:23Z"
                        }
                    ],
                    "modules": {
                        "session_control": {
                            "session_id": MOCK_TOPIC_ID,
                            "title": "[专题] 会话控制与内省",
                            "memory_docs": ["docs/memory/session_control.md"]
                        }
                    }
                }
            }
        }
        with open(os.path.join(agent_dir, "sessions.json"), "w", encoding="utf-8") as f:
            json.dump(sessions_data, f, indent=2)

    def tearDown(self):
        import shutil
        if os.path.exists(self.sandbox_dir):
            shutil.rmtree(self.sandbox_dir, ignore_errors=True)

    def test_inject_session_context(self):
        mock_input = json.dumps({
            "vendor": "antigravity", "conversationId": MOCK_TOPIC_ID,
            "workspacePaths": [self.sandbox_dir],
            "invocationNum": 0,
            "initialNumSteps": 2,
            "isTest": True
        })
        proc = subprocess.Popen(
            [sys.executable, self.inject_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout, _ = proc.communicate(input=mock_input)
        res = json.loads(stdout)
        self.assertIn("injectSteps", res)
        self.assertTrue(len(res["injectSteps"]) > 0)
        self.assertIn("83bae782", res["injectSteps"][0]["ephemeralMessage"])

        # Codex is explicitly unsupported, even when its thread ID looks like an AGY UUID.
        codex_proc = subprocess.Popen(
            [sys.executable, self.inject_script], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8"
        )
        codex_stdout, _ = codex_proc.communicate(input=json.dumps({
            "vendor": "codex", "conversationId": MOCK_CODEX_ID,
            "workspacePaths": [self.sandbox_dir], "isTest": True
        }))
        codex_res = json.loads(codex_stdout)
        self.assertTrue({"supported", "vendor", "hook", "status", "reasonCode", "reason"}.issubset(codex_res.keys()))
        self.assertFalse(codex_res["supported"])
        self.assertEqual(codex_res["vendor"], "codex")
        self.assertEqual(codex_res["status"], "unsupported")
        self.assertEqual(codex_res["reasonCode"], "CODEX_AUTOMATIC_HOOK_UNSUPPORTED")
        self.assertEqual(codex_res["hook"], "PreInvocation")
        self.assertIn("unsupported", codex_res["reason"].lower())
        self.assertNotIn("injectSteps", codex_res)

        # Test consecutive invocation (should not be blocked in test environment)
        proc2 = subprocess.Popen(
            [sys.executable, self.inject_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout2, _ = proc2.communicate(input=mock_input)
        res2 = json.loads(stdout2)
        self.assertIn("injectSteps", res2)
        self.assertTrue(len(res2["injectSteps"]) > 0)

    def test_inject_deduplication(self):
        import time
        dedup_id = f"dedupe-py-test-{int(time.time() * 1000)}"
        mock_input = json.dumps({
            "vendor": "antigravity", "conversationId": dedup_id,
            "workspacePaths": [self.sandbox_dir]
        })
        proc1 = subprocess.Popen(
            [sys.executable, self.inject_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout1, _ = proc1.communicate(input=mock_input)
        res1 = json.loads(stdout1)
        self.assertTrue(len(res1.get("injectSteps", [])) > 0)

        proc2 = subprocess.Popen(
            [sys.executable, self.inject_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout2, _ = proc2.communicate(input=mock_input)
        res2 = json.loads(stdout2)
        self.assertEqual(len(res2.get("injectSteps", [])), 0)

    def test_vendor_autodetection_and_zcode_ignore(self):
        # 1. Test main session autodetected as AGY
        mock_main = json.dumps({
            "vendor": "antigravity", "conversationId": MOCK_MAIN_ID,
            "workspacePaths": [self.sandbox_dir],
            "isTest": True
        })
        proc = subprocess.Popen(
            [sys.executable, self.inject_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout, _ = proc.communicate(input=mock_main)
        res = json.loads(stdout)
        self.assertTrue(len(res.get("injectSteps", [])) > 0)
        self.assertIn("主会话", res["injectSteps"][0]["ephemeralMessage"])
        self.assertNotIn("专题强制收尾与反向汇报契约", res["injectSteps"][0]["ephemeralMessage"])

        # 2. Test ZCode hook ignores AGY UUID sessions
        # 本用例验证「宿主厂商未声明」分支，故必须显式剥离宿主环境变量：在 Claude Code 等宿主内运行时
        # 会注入 CLAUDECODE / CLAUDE_CODE_SESSION_ID，此时 UUID 会话应被正确识别为该宿主会话（见 2b）。
        HOST_VENDOR_ENV_KEYS = (
            "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID",
            "CLAUDE_CONVERSATION_ID", "CLAUDE_PROJECT_DIR",
            "ZCODE_SESSION_ID", "ZCODE_PROJECT_DIR",
            "CODEX_THREAD_ID", "CODEX_SESSION_ID",
            "ANTIGRAVITY_CONVERSATION_ID",
        )

        def scrub_host_vendor_env(extra=None):
            env = {k: v for k, v in os.environ.items() if k not in HOST_VENDOR_ENV_KEYS}
            if extra:
                env.update(extra)
            return env

        zcode_script = os.path.join(self.root_dir, "scripts", "hooks", "inject_session_context_zcode.py")
        mock_zcode = json.dumps({
            "sessionId": MOCK_TOPIC_ID,
            "workspacePaths": [self.sandbox_dir],
            "isTest": True
        })
        proc2 = subprocess.Popen(
            [sys.executable, zcode_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=scrub_host_vendor_env()
        )
        stdout2, _ = proc2.communicate(input=mock_zcode)
        res2 = json.loads(stdout2 or "{}")
        self.assertEqual(len(res2), 0)

        # 2b. 宿主厂商已声明时，同一 UUID 会话不得再被跳过，须产出注入上下文
        proc2b = subprocess.Popen(
            [sys.executable, zcode_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=scrub_host_vendor_env({"CLAUDECODE": "1"})
        )
        stdout2b, _ = proc2b.communicate(input=mock_zcode)
        res2b = json.loads(stdout2b or "{}")
        self.assertEqual(
            res2b.get("hookSpecificOutput", {}).get("hookEventName"),
            "UserPromptSubmit",
            "Declared host vendor must make the adapter process UUID sessions instead of skipping them"
        )
        self.assertIn(
            "Unregistered",
            res2b["hookSpecificOutput"]["additionalContext"],
            "Unregistered UUID session should receive init guidance"
        )

        # 3. Test Topic Session receives mandatory wrapup reverse reporting rule
        mock_topic = json.dumps({
            "vendor": "antigravity", "conversationId": MOCK_TOPIC_ID,
            "workspacePaths": [self.sandbox_dir],
            "isTest": True
        })
        proc3 = subprocess.Popen(
            [sys.executable, self.inject_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout3, _ = proc3.communicate(input=mock_topic)
        res3 = json.loads(stdout3)
        self.assertTrue(len(res3.get("injectSteps", [])) > 0)
        self.assertIn("专题强制收尾与反向汇报契约", res3["injectSteps"][0]["ephemeralMessage"])
        self.assertIn("send_message(recipient=", res3["injectSteps"][0]["ephemeralMessage"])

    def test_enforce_allowlist_allowed(self):
        os.environ["TASK_LOOP_ALLOWLIST"] = "SKILL.md"
        mock_input = json.dumps({
            "vendor": "antigravity", "conversationId": MOCK_TOPIC_ID,
            "toolCall": {
                "name": "replace_file_content",
                "args": {
                    "TargetFile": "SKILL.md"
                }
            },
            "workspacePaths": [self.sandbox_dir]
        })
        proc = subprocess.Popen(
            [sys.executable, self.allowlist_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout, _ = proc.communicate(input=mock_input)
        res = json.loads(stdout)
        self.assertEqual(res.get("decision"), "allow")

        for vendor_case in [
            {"vendor": "codex", "conversationId": MOCK_CODEX_ID},
            {"vendor": "unknown-vendor", "conversationId": MOCK_TOPIC_ID},
            {"vendor": "zcode", "conversationId": MOCK_TOPIC_ID},
            {"vendor": "antigravity", "conversationId": "99999999-8888-7777-6666-555555555555"}
        ]:
            denied_proc = subprocess.Popen(
                [sys.executable, self.allowlist_script], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8"
            )
            denied_stdout, _ = denied_proc.communicate(input=json.dumps({
                **vendor_case,
                "toolCall": {"name": "replace_file_content", "args": {"TargetFile": "SKILL.md"}},
                "workspacePaths": [self.sandbox_dir]
            }))
            denied = json.loads(denied_stdout)
            self.assertEqual(denied.get("decision"), "deny")

    def test_enforce_allowlist_denied(self):
        mock_input = json.dumps({
            "vendor": "antigravity", "conversationId": MOCK_MAIN_ID,
            "toolCall": {
                "name": "replace_file_content",
                "args": {
                    "TargetFile": "src/unauthorized_file.js"
                }
            },
            "workspacePaths": [self.sandbox_dir]
        })
        proc = subprocess.Popen(
            [sys.executable, self.allowlist_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout, _ = proc.communicate(input=mock_input)
        res = json.loads(stdout)
        self.assertEqual(res.get("decision"), "deny")
        self.assertTrue(
            "Allowlist" in res.get("reason", "") or
            "白名单" in res.get("reason", "") or
            "主会话" in res.get("reason", "") or
            "Explore Only" in res.get("reason", "")
        )

    def test_enforce_allowlist_topic_expansion_request(self):
        os.environ["TASK_LOOP_ALLOWLIST"] = "skills/subagent/SKILL.md"
        mock_input = json.dumps({
            "vendor": "antigravity", "conversationId": MOCK_TOPIC_ID,
            "toolCall": {
                "name": "replace_file_content",
                "args": {
                    "TargetFile": "src/forbidden_module.js"
                }
            },
            "workspacePaths": [self.sandbox_dir]
        })
        proc = subprocess.Popen(
            [sys.executable, self.allowlist_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout, _ = proc.communicate(input=mock_input)
        os.environ.pop("TASK_LOOP_ALLOWLIST", None)
        res = json.loads(stdout)
        self.assertEqual(res.get("decision"), "deny")
        self.assertIn("ALLOWLIST_EXPANSION_REQUEST", res.get("reason", ""))
        self.assertIn("send_message", res.get("reason", ""))

    def test_enforce_allowlist_exempt_paths(self):
        os.environ["TASK_LOOP_ALLOWLIST"] = "src/only_allowed.js"
        mock_input = json.dumps({
            "vendor": "antigravity", "conversationId": MOCK_TOPIC_ID,
            "toolCall": {
                "name": "write_to_file",
                "args": {
                    "TargetFile": "docs/memory/session_control.md"
                }
            },
            "workspacePaths": [self.sandbox_dir]
        })
        proc = subprocess.Popen(
            [sys.executable, self.allowlist_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout, _ = proc.communicate(input=mock_input)
        os.environ.pop("TASK_LOOP_ALLOWLIST", None)
        res = json.loads(stdout)
        self.assertEqual(res.get("decision"), "allow")


if __name__ == "__main__":
    unittest.main()

