#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Claude Code Project Session Provider Stub
Scans local .claude directory for project sessions.
"""

import sys
import json
from pathlib import Path
from datetime import datetime, timezone


def normalize_path(path_str: str) -> str:
    if not path_str:
        return ""
    return str(Path(path_str).resolve()).replace("\\", "/").rstrip("/").lower()


def scan_claude_sessions(project_root_str: str = ".") -> list:
    project_root = normalize_path(project_root_str)
    root_path = Path(project_root_str)
    claude_dir = root_path / ".claude"
    
    sessions = []
    if claude_dir.is_dir():
        for f in claude_dir.glob("*.json"):
            try:
                stat = f.stat()
                last_modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
                created = datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat()
                claude_md = root_path / "CLAUDE.md"
                rule_files = [str(claude_md.resolve()).replace("\\", "/")] if claude_md.is_file() else []
                
                sessions.append({
                    "vendor": "claude",
                    "session_id": f.stem,
                    "title": f"Claude Session {f.stem}",
                    "project_root": project_root,
                    "is_active": True,
                    "created_at": created,
                    "last_active_at": last_modified,
                    "log_path": str(f.resolve()).replace("\\", "/"),
                    "rule_files": rule_files
                })
            except Exception:
                pass
                
    return sessions


def main():
    project_root = sys.argv[1] if len(sys.argv) > 1 else "."
    sessions = scan_claude_sessions(project_root)
    print(json.dumps(sessions, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
