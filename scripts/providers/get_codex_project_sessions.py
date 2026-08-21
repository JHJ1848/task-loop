#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Codex Project Session Provider
Scans local .codex/task-loop/sessions.json or registry for Codex sessions.
"""

import sys
import json
from pathlib import Path
from datetime import datetime, timezone


def normalize_path(path_str: str) -> str:
    if not path_str:
        return ""
    return str(Path(path_str).resolve()).replace("\\", "/").rstrip("/").lower()


def scan_codex_sessions(project_root_str: str = ".") -> list:
    project_root = normalize_path(project_root_str)
    root_path = Path(project_root_str)
    local_registry = root_path / ".codex" / "task-loop" / "sessions.json"
    
    sessions = []
    if local_registry.is_file():
        try:
            with open(local_registry, "r", encoding="utf-8") as f:
                reg = json.load(f)
            stat = local_registry.stat()
            last_modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
            created = datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat()
            
            agents_md = root_path / "AGENTS.md"
            rule_files = [str(agents_md.resolve()).replace("\\", "/")] if agents_md.is_file() else []

            if reg.get("main_thread_id"):
                sessions.append({
                    "vendor": "codex",
                    "session_id": str(reg["main_thread_id"]),
                    "title": "Codex Main Dispatcher",
                    "project_root": project_root,
                    "is_active": True,
                    "created_at": created,
                    "last_active_at": last_modified,
                    "log_path": str(local_registry.resolve()).replace("\\", "/"),
                    "rule_files": rule_files
                })
                
            modules = reg.get("modules", {})
            for mod_key, mod_val in modules.items():
                if isinstance(mod_val, dict) and mod_val.get("thread_id"):
                    sessions.append({
                        "vendor": "codex",
                        "session_id": str(mod_val["thread_id"]),
                        "title": str(mod_val.get("title", f"Codex Module {mod_key}")),
                        "module_key": mod_key,
                        "project_root": project_root,
                        "is_active": True,
                        "created_at": created,
                        "last_active_at": last_modified,
                        "log_path": str(local_registry.resolve()).replace("\\", "/"),
                        "rule_files": rule_files
                    })
        except Exception:
            pass

    return sessions


def main():
    project_root = sys.argv[1] if len(sys.argv) > 1 else "."
    sessions = scan_codex_sessions(project_root)
    print(json.dumps(sessions, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
