#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Multi-Vendor End-to-End Smoke Test Suite (Python)
Verifies universal scanning and introspection across Google Antigravity,
ZCode, OpenAI Codex, and Anthropic Claude Code.
"""

import os
import sys
import json
import shutil
import tempfile
import unittest
from pathlib import Path

# Force UTF-8 on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Ensure project root & providers in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts", "providers")))

from scripts.providers.get_agy_project_sessions import scan_agy_sessions
from scripts.providers.get_zcode_project_sessions import scan_zcode_sessions
from scripts.providers.get_codex_project_sessions import scan_codex_sessions
from scripts.providers.get_claude_project_sessions import scan_claude_sessions, munge_project_dir
from scripts.find_project_sessions import find_sessions


class TestMultivendorSmoke(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="test_smoke_env_py_")
        self.project_root = os.path.join(self.temp_dir, "workspace")
        os.makedirs(self.project_root, exist_ok=True)
        with open(os.path.join(self.project_root, "AGENTS.md"), "w", encoding="utf-8") as f:
            f.write("# Project Rules\n")

        self.norm_project = self.project_root.replace("\\", "/")

        # 1. Mock AGY Brain
        self.mock_brain = os.path.join(self.temp_dir, "brain")
        self.agy_id = "11111111-1111-1111-1111-111111111111"
        agy_log_dir = os.path.join(self.mock_brain, self.agy_id, ".system_generated", "logs")
        os.makedirs(agy_log_dir, exist_ok=True)
        with open(os.path.join(agy_log_dir, "transcript.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "USER_INPUT", "content": f"AGY Task in {self.norm_project}", "created_at": "2026-09-07T01:00:00Z"}) + "\n")
            f.write(json.dumps({"type": "PLANNER_RESPONSE", "tool_calls": [{"name": "edit_file", "args": {"TargetFile": f"{self.norm_project}/src/main.js"}}]}) + "\n")

        # 2. Mock ZCode Rollout
        self.mock_rollout = os.path.join(self.temp_dir, "zcode_rollout")
        os.makedirs(self.mock_rollout, exist_ok=True)
        self.zcode_suffix = "22222222-2222-2222-2222-222222222222"
        with open(os.path.join(self.mock_rollout, f"model-io-sess_{self.zcode_suffix}.jsonl"), "w", encoding="utf-8") as f:
            f.write(f'{{"role":"user","text":"ZCode Task in {self.norm_project}"}}\n')
            f.write(f'{{"role":"assistant","text":"Working on {self.norm_project}/src/app.js"}}\n')

        # 3. Mock Codex Home
        self.mock_codex_home = Path(self.temp_dir) / "codex_home"
        codex_sessions = self.mock_codex_home / "sessions"
        codex_sessions.mkdir(parents=True, exist_ok=True)
        self.codex_id = "33333333-3333-3333-3333-333333333333"
        with open(codex_sessions / "rollout-sess-003.jsonl", "w", encoding="utf-8") as f:
            f.write(json.dumps({
                "type": "session_meta",
                "payload": {
                    "id": "rollout-003",
                    "session_id": self.codex_id,
                    "cwd": self.project_root,
                    "timestamp": "2026-09-07T03:00:00Z",
                    "thread_source": "user"
                }
            }) + "\n")

        # 4. Mock Claude Home
        self.mock_claude_home = Path(self.temp_dir) / "claude_home"
        claude_munged = munge_project_dir(self.project_root)
        claude_target_dir = self.mock_claude_home / "projects" / claude_munged
        claude_target_dir.mkdir(parents=True, exist_ok=True)
        self.claude_id = "44444444-4444-4444-4444-444444444444"
        with open(claude_target_dir / f"{self.claude_id}.jsonl", "w", encoding="utf-8") as f:
            f.write(json.dumps({"timestamp": "2026-09-07T04:00:00Z", "cwd": self.norm_project}) + "\n")
            f.write(json.dumps({"type": "user", "content": f"Claude Task in {self.norm_project}"}) + "\n")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_direct_provider_scans(self):
        agy_sessions = scan_agy_sessions(self.project_root, custom_brain_path=self.mock_brain, inspect_activity=True)
        self.assertEqual(len(agy_sessions), 1)
        self.assertEqual(agy_sessions[0]["vendor"], "antigravity")
        self.assertEqual(agy_sessions[0]["session_id"], self.agy_id)

        zcode_sessions = scan_zcode_sessions(self.project_root, options={"rollout_dir": self.mock_rollout}, inspect_activity=True)
        self.assertEqual(len(zcode_sessions), 1)
        self.assertEqual(zcode_sessions[0]["vendor"], "zcode")
        self.assertEqual(zcode_sessions[0]["session_id"], f"sess_{self.zcode_suffix}")

        codex_sessions = scan_codex_sessions(self.project_root, codex_home=self.mock_codex_home, include_registry=False)
        self.assertEqual(len(codex_sessions), 1)
        self.assertEqual(codex_sessions[0]["vendor"], "codex")
        self.assertEqual(codex_sessions[0]["session_id"], self.codex_id)

        claude_sessions = scan_claude_sessions(self.project_root, custom_claude_home=str(self.mock_claude_home), inspect_activity=True)
        self.assertEqual(len(claude_sessions), 1)
        self.assertEqual(claude_sessions[0]["vendor"], "claude")
        self.assertEqual(claude_sessions[0]["session_id"], self.claude_id)

    def test_find_sessions_environment_aggregation(self):
        orig_rollout = os.environ.get("ZCODE_ROLLOUT_DIR")
        orig_codex = os.environ.get("CODEX_HOME")

        os.environ["ZCODE_ROLLOUT_DIR"] = self.mock_rollout
        os.environ["CODEX_HOME"] = str(self.mock_codex_home)

        try:
            all_sessions = find_sessions(self.project_root, vendor="All", inspect=True)
            vendors = {s["vendor"] for s in all_sessions}
            self.assertIn("zcode", vendors)
            self.assertIn("codex", vendors)

            for s in all_sessions:
                self.assertTrue(s.get("vendor"))
                self.assertTrue(s.get("session_id"))
                self.assertTrue(s.get("title"))
                self.assertTrue(s.get("project_root"))
        finally:
            if orig_rollout:
                os.environ["ZCODE_ROLLOUT_DIR"] = orig_rollout
            else:
                os.environ.pop("ZCODE_ROLLOUT_DIR", None)
            if orig_codex:
                os.environ["CODEX_HOME"] = orig_codex
            else:
                os.environ.pop("CODEX_HOME", None)


if __name__ == "__main__":
    unittest.main()
