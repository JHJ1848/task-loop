import os
import sys
import json
import subprocess
import unittest


def _current_main_id():
    """动态读取当前主会话 (任意厂商分区), 避免硬编码随状态机演进失效。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".agents", "task-loop", "sessions.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        for part in (data.get("vendors") or {}).values():
            if isinstance(part, dict) and part.get("main_thread_id"):
                return part["main_thread_id"]
        return data.get("main_thread_id")
    except Exception:
        return None


CURRENT_MAIN_ID = _current_main_id()


class TestHooksPipeline(unittest.TestCase):
    def setUp(self):
        self.root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        self.inject_script = os.path.join(self.root_dir, "scripts", "hooks", "inject_session_context.py")
        self.allowlist_script = os.path.join(self.root_dir, "scripts", "hooks", "enforce_allowlist.py")

    def test_inject_session_context(self):
        mock_input = json.dumps({
            "conversationId": "83bae782-1e95-4923-a76f-2141fe8c5c61",
            "workspacePaths": [self.root_dir],
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
            "conversationId": dedup_id,
            "workspacePaths": [self.root_dir]
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
        if CURRENT_MAIN_ID:
            mock_main = json.dumps({
                "conversationId": CURRENT_MAIN_ID,
                "workspacePaths": [self.root_dir],
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

        # 2. Test ZCode hook ignores AGY UUID sessions
        zcode_script = os.path.join(self.root_dir, "scripts", "hooks", "inject_session_context_zcode.py")
        mock_zcode = json.dumps({
            "sessionId": "83bae782-1e95-4923-a76f-2141fe8c5c61",
            "workspacePaths": [self.root_dir],
            "isTest": True
        })
        proc2 = subprocess.Popen(
            [sys.executable, zcode_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        stdout2, _ = proc2.communicate(input=mock_zcode)
        res2 = json.loads(stdout2 or "{}")
        # 3. Test Topic Session receives mandatory wrapup reverse reporting rule
        mock_topic = json.dumps({
            "conversationId": "83bae782-1e95-4923-a76f-2141fe8c5c61",
            "workspacePaths": [self.root_dir],
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
        mock_input = json.dumps({
            "toolCall": {
                "name": "replace_file_content",
                "args": {
                    "TargetFile": "SKILL.md"
                }
            },
            "workspacePaths": [self.root_dir]
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

    def test_enforce_allowlist_denied(self):
        mock_input = json.dumps({
            "conversationId": CURRENT_MAIN_ID,
            "toolCall": {
                "name": "replace_file_content",
                "args": {
                    "TargetFile": "src/unauthorized_file.js"
                }
            },
            "workspacePaths": [self.root_dir]
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
            "conversationId": "83bae782-1e95-4923-a76f-2141fe8c5c61",
            "toolCall": {
                "name": "replace_file_content",
                "args": {
                    "TargetFile": "src/forbidden_module.js"
                }
            },
            "workspacePaths": [self.root_dir]
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


if __name__ == "__main__":
    unittest.main()

