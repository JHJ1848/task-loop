import os
import sys
import json
import subprocess
import unittest

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
            "initialNumSteps": 2
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
        self.assertTrue("Allowlist" in res.get("reason", "") or "白名单" in res.get("reason", ""))

if __name__ == "__main__":
    unittest.main()
