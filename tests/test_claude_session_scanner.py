#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for Claude Code Project Session Scanner
"""

import sys
import json
import shutil
import tempfile
from pathlib import Path

# Add scripts directory
scripts_dir = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(scripts_dir))
sys.path.insert(0, str(scripts_dir / "providers"))

from get_claude_project_sessions import scan_claude_sessions, munge_project_dir

SESSION_ID = "11111111-2222-3333-4444-555555555555"


def _write_fixture(home_dir: Path, project_dir: Path):
    munged = munge_project_dir(str(project_dir))
    session_dir = home_dir / "projects" / munged
    session_dir.mkdir(parents=True)
    cwd_field = str(project_dir).replace("\\", "\\\\")

    lines = [
        json.dumps({"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-08-24T01:00:00.000Z", "sessionId": SESSION_ID, "content": "claude scanner fixture prompt"}),
        json.dumps({"type": "user", "cwd": cwd_field, "sessionId": SESSION_ID, "timestamp": "2026-08-24T01:00:01.000Z", "message": {"role": "user", "content": "claude scanner fixture prompt"}}),
        json.dumps({"type": "assistant", "cwd": cwd_field, "timestamp": "2026-08-24T01:00:02.000Z", "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": str(project_dir / "src" / "demo.py")}}]}}),
    ]
    (session_dir / f"{SESSION_ID}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_claude_scanner():
    project_dir = Path(tempfile.mkdtemp(prefix="claude_scan_proj_"))
    home_dir = Path(tempfile.mkdtemp(prefix="claude_scan_home_"))
    try:
        (project_dir / "src").mkdir()
        (project_dir / "CLAUDE.md").write_text("# rules", encoding="utf-8")
        _write_fixture(home_dir, project_dir)

        sessions = scan_claude_sessions(str(project_dir), custom_claude_home=str(home_dir), inspect_activity=True)

        assert len(sessions) == 1, f"expected 1 session, got {len(sessions)}"
        s = sessions[0]
        assert s["vendor"] == "claude"
        assert s["session_id"] == SESSION_ID
        assert s["log_path"].endswith(f"{SESSION_ID}.jsonl")
        assert s["created_at"].startswith("2026-08-24T01:00:00")
        assert "claude scanner fixture prompt" in s["title"]
        assert s["recent_prompts"], "recent_prompts should not be empty"
        assert "src/demo.py" in s["recent_touched_files"], s["recent_touched_files"]
        assert any(p.endswith("CLAUDE.md") for p in s["rule_files"])

        # cwd mismatch (session resumed from another workspace) must be rejected
        other_home = Path(tempfile.mkdtemp(prefix="claude_scan_other_"))
        try:
            munged = munge_project_dir(str(project_dir))
            other_dir = other_home / "projects" / munged
            other_dir.mkdir(parents=True)
            wrong_cwd = json.dumps({"type": "user", "cwd": "D:\\\\elsewhere", "sessionId": SESSION_ID, "timestamp": "2026-08-24T02:00:00.000Z", "message": {"role": "user", "content": "other"}})
            (other_dir / f"{SESSION_ID}.jsonl").write_text(wrong_cwd + "\n", encoding="utf-8")
            assert scan_claude_sessions(str(project_dir), custom_claude_home=str(other_home)) == []
        finally:
            shutil.rmtree(other_home, ignore_errors=True)

        print("Claude scanner test passed. Fields:", json.dumps({k: s[k] for k in ("vendor", "session_id", "is_active", "created_at")}, ensure_ascii=False))
    finally:
        shutil.rmtree(project_dir, ignore_errors=True)
        shutil.rmtree(home_dir, ignore_errors=True)


if __name__ == "__main__":
    test_claude_scanner()
