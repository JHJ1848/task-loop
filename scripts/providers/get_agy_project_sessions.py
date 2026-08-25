#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Antigravity (AGY) Project Session Provider
Scans ~/.gemini/antigravity/brain for sessions matching the specified project root,
extracting recent activities, touched files, and candidate functional tags.
"""

import sys
import os
import json
import re
from pathlib import Path
from datetime import datetime, timezone


def normalize_path(path_str: str) -> str:
    if not path_str:
        return ""
    return str(Path(path_str).resolve()).replace("\\", "/").rstrip("/").lower()


def scan_agy_sessions(project_root_str: str = ".", custom_brain_path: str = None, inspect_activity: bool = True) -> list:
    project_root = normalize_path(project_root_str)
    
    if custom_brain_path:
        brain_dir = Path(custom_brain_path)
    else:
        brain_dir = Path.home() / ".gemini" / "antigravity" / "brain"
        
    if not brain_dir.is_dir():
        return []

    sessions = []
    
    for entry in brain_dir.iterdir():
        if not entry.is_dir():
            continue
        conv_id = entry.name
        
        # Check transcript log
        log_file = entry / ".system_generated" / "logs" / "transcript.jsonl"
        if not log_file.is_file():
            log_file = entry / ".system_generated" / "logs" / "transcript_full.jsonl"
            if not log_file.is_file():
                continue

        try:
            stat = log_file.stat()
            last_modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
            created = datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat()
        except Exception:
            last_modified = ""
            created = ""

        is_match = False
        title = f"Session {conv_id}"
        user_prompts = []
        touched_files = set()

        try:
            with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line_lower = line.lower()
                    if not is_match and (project_root in line_lower or project_root.replace(":", "%3a") in line_lower):
                        is_match = True
                    
                    # Extract user input prompts
                    if '"type":"USER_INPUT"' in line or '"type": "USER_INPUT"' in line:
                        match = re.search(r'"content"\s*:\s*"([^"]+)"', line)
                        if match:
                            raw_content = match.group(1)
                            clean_content = re.sub(r'<[^>]+>', '', raw_content)
                            clean_content = clean_content.replace("\\n", " ").replace('\\"', '"').strip()
                            if clean_content and clean_content not in user_prompts:
                                user_prompts.append(clean_content[:150])
                    
                    # Extract touched files from tool calls if inspect_activity enabled
                    if inspect_activity:
                        file_matches = re.findall(r'"(?:AbsolutePath|TargetFile|SearchPath)"\s*:\s*"([^"]+)"', line)
                        for fm in file_matches:
                            clean_fm = fm.replace('\\\\', '/').replace('\\', '/')
                            if clean_fm.lower().startswith(project_root):
                                rel_path = clean_fm[len(project_root):].lstrip('/')
                                if rel_path:
                                    touched_files.add(rel_path)
                            elif not clean_fm.startswith(('http://', 'https://')):
                                touched_files.add(clean_fm.split('/')[-1])
        except Exception:
            pass

        if is_match:
            if user_prompts:
                title = user_prompts[0]
                if len(title) > 60:
                    title = title[:57] + "..."

            agents_md = Path(project_root_str) / "AGENTS.md"
            rule_files = [str(agents_md.resolve()).replace("\\", "/")] if agents_md.is_file() else []
            
            session_data = {
                "vendor": "antigravity",
                "session_id": conv_id,
                "title": title,
                "project_root": project_root,
                "is_active": True,
                "created_at": created,
                "last_active_at": last_modified,
                "log_path": str(log_file.resolve()).replace("\\", "/"),
                "rule_files": rule_files
            }

            if inspect_activity:
                session_data["recent_prompts"] = user_prompts[-5:] if len(user_prompts) > 5 else user_prompts
                session_data["recent_touched_files"] = sorted(list(touched_files))[:15]

            sessions.append(session_data)

    # Sort by last_active_at descending
    sessions.sort(key=lambda s: s["last_active_at"], reverse=True)
    return sessions


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    project_root = sys.argv[1] if len(sys.argv) > 1 else "."
    inspect = "--inspect" in sys.argv or "-i" in sys.argv
    sessions = scan_agy_sessions(project_root, inspect_activity=inspect)
    print(json.dumps(sessions, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
