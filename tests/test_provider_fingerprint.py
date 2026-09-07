#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test suite for provider schema fingerprint probes and graceful degradation (Python)
"""

import os
import sys
import json
import shutil
import tempfile
import unittest
import io
from pathlib import Path

# Force UTF-8 encoding on Windows
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
from scripts.providers.get_codex_project_sessions import scan_codex_sessions
from scripts.providers.get_claude_project_sessions import scan_claude_sessions, munge_project_dir
from scripts.find_project_sessions import find_sessions


class TestProviderFingerprint(unittest.TestCase):
    def test_agy_fingerprint_and_corrupt_line(self):
        temp_dir = tempfile.mkdtemp(prefix="test_fingerprint_agy_py_")
        try:
            mock_brain = os.path.join(temp_dir, "brain")
            project_root = os.path.join(temp_dir, "project")
            conv_id = "11111111-2222-3333-4444-555555555555"
            log_dir = os.path.join(mock_brain, conv_id, ".system_generated", "logs")
            os.makedirs(log_dir, exist_ok=True)
            os.makedirs(project_root, exist_ok=True)

            log_file = os.path.join(log_dir, "transcript.jsonl")
            norm_proj = project_root.replace("\\", "/")
            lines = [
                json.dumps({"type": "USER_INPUT", "content": f"Valid prompt in {norm_proj}", "created_at": "2026-09-07T00:00:00Z"}),
                "{corrupted line missing brackets",
                '"not-a-json-object"',
                json.dumps({"type": "PLANNER_RESPONSE", "content": "Done"})
            ]
            with open(log_file, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")

            # Capture stderr
            captured_stderr = io.StringIO()
            old_stderr = sys.stderr
            sys.stderr = captured_stderr
            try:
                sessions = scan_agy_sessions(project_root, custom_brain_path=mock_brain, inspect_activity=True)
            finally:
                sys.stderr = old_stderr

            stderr_val = captured_stderr.getvalue()
            self.assertEqual(len(sessions), 1, "Valid AGY session should still be extracted despite corrupt lines")
            self.assertEqual(sessions[0]["session_id"], conv_id)
            self.assertIn("[agy-provider] schema mismatch", stderr_val, "Stderr should contain structured schema mismatch warning")
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_codex_fingerprint_and_corrupt_line(self):
        temp_dir = tempfile.mkdtemp(prefix="test_fingerprint_codex_py_")
        try:
            mock_codex_home = Path(temp_dir) / "codex_home"
            project_root = os.path.join(temp_dir, "project")
            sessions_dir = mock_codex_home / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            os.makedirs(project_root, exist_ok=True)

            session_file = sessions_dir / "rollout-sess-001.jsonl"
            lines = [
                "{bad json line",
                json.dumps({
                    "type": "session_meta",
                    "payload": {
                        "id": "rollout-001",
                        "session_id": "codex-sess-001",
                        "cwd": project_root,
                        "timestamp": "2026-09-07T00:00:00Z",
                        "thread_source": "user"
                    }
                })
            ]
            session_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

            captured_stderr = io.StringIO()
            old_stderr = sys.stderr
            sys.stderr = captured_stderr
            try:
                sessions = scan_codex_sessions(project_root, codex_home=mock_codex_home, include_registry=False)
            finally:
                sys.stderr = old_stderr

            stderr_val = captured_stderr.getvalue()
            self.assertEqual(len(sessions), 1, "Valid Codex session should be extracted")
            self.assertEqual(sessions[0]["session_id"], "codex-sess-001")
            self.assertIn("[codex-provider] schema mismatch", stderr_val, "Stderr should contain codex schema mismatch warning")
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_claude_fingerprint(self):
        temp_dir = tempfile.mkdtemp(prefix="test_fingerprint_claude_py_")
        try:
            mock_claude_home = Path(temp_dir) / "claude_home"
            project_root = os.path.join(temp_dir, "project")
            projects_dir = mock_claude_home / "projects"
            os.makedirs(project_root, exist_ok=True)

            munged = munge_project_dir(project_root)
            target_dir = projects_dir / munged
            target_dir.mkdir(parents=True, exist_ok=True)

            sess_file = target_dir / "claude-sess-001.jsonl"
            lines = [
                json.dumps({"timestamp": "2026-09-07T00:00:00Z", "cwd": project_root}),
                json.dumps({"type": "user", "content": "Claude initial prompt"}),
                "{corrupted line in claude"
            ]
            sess_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

            sessions = scan_claude_sessions(project_root, custom_claude_home=str(mock_claude_home), inspect_activity=True)
            self.assertEqual(len(sessions), 1, "Valid Claude session should be parsed")
            self.assertEqual(sessions[0]["session_id"], "claude-sess-001")
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_find_project_sessions_safe_isolation(self):
        temp_dir = tempfile.mkdtemp(prefix="test_find_sessions_py_")
        try:
            project_root = os.path.join(temp_dir, "project")
            os.makedirs(project_root, exist_ok=True)
            sessions = find_sessions(project_root, vendor="All", inspect=True)
            self.assertIsInstance(sessions, list, "find_sessions should return a list")
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
