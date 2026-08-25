#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Claude Code Project Session Provider
Scans ~/.claude/projects/<munged-cwd>/<session-id>.jsonl transcripts for sessions
matching the specified project root, mirroring the AGY provider's output schema.
"""

import sys
import re
import json
import time
from pathlib import Path
from datetime import datetime, timezone

ACTIVE_WINDOW_SECONDS = 30 * 60


def normalize_path(path_str: str) -> str:
    if not path_str:
        return ""
    return str(Path(path_str).resolve()).replace("\\", "/").rstrip("/").lower()


def munge_project_dir(path_str: str) -> str:
    # Claude Code encodes the cwd into the storage dir name:
    # "D:\jhj\projects\task-loop" -> "D--jhj-projects-task-loop"
    return re.sub(r'[^A-Za-z0-9-]', '-', str(Path(path_str).resolve()))


def scan_claude_sessions(project_root_str: str = ".", custom_claude_home: str = None, inspect_activity: bool = True) -> list:
    project_root = normalize_path(project_root_str)

    if custom_claude_home:
        projects_dir = Path(custom_claude_home) / "projects"
    else:
        projects_dir = Path.home() / ".claude" / "projects"

    if not projects_dir.is_dir():
        return []

    # Drive-letter case is preserved in the munged dir name; try both variants.
    munged = munge_project_dir(project_root_str)
    candidates = {munged, munged[:1].lower() + munged[1:], munged[:1].upper() + munged[1:]}

    sessions = []
    seen_ids = set()

    root_path = Path(project_root_str)
    claude_md = root_path / "CLAUDE.md"
    rule_files = [str(claude_md.resolve()).replace("\\", "/")] if claude_md.is_file() else []

    for candidate in sorted(candidates):
        target_dir = projects_dir / candidate
        if not target_dir.is_dir():
            continue

        for log_file in sorted(target_dir.glob("*.jsonl")):
            session_id = log_file.stem
            if session_id in seen_ids:
                continue

            parsed = _parse_transcript(log_file, project_root, inspect_activity)
            if parsed is not None:
                seen_ids.add(session_id)
                parsed["rule_files"] = rule_files
                sessions.append(parsed)

    sessions.sort(key=lambda s: s["last_active_at"], reverse=True)
    return sessions


def _parse_transcript(log_file: Path, project_root: str, inspect_activity: bool):
    stat = log_file.stat()
    last_active = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
    created = datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat()
    is_active = (time.time() - stat.st_mtime) < ACTIVE_WINDOW_SECONDS

    title = None
    user_prompts = []
    touched_files = set()
    cwd_confirmed = False
    cwd_seen = False
    first_timestamp = None
    line_budget = 200 if not inspect_activity else None

    try:
        with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line_budget is not None:
                    if line_budget <= 0:
                        break
                    line_budget -= 1

                if first_timestamp is None:
                    ts_match = re.search(r'"timestamp"\s*:\s*"([^"]+)"', line)
                    if ts_match:
                        first_timestamp = ts_match.group(1)

                cwd_match = re.search(r'"cwd"\s*:\s*"([^"]+)"', line)
                if cwd_match:
                    cwd_seen = True
                    if normalize_path(cwd_match.group(1)) == project_root:
                        cwd_confirmed = True

                summary_match = re.search(r'"type"\s*:\s*"summary"', line)
                if summary_match and title is None:
                    sum_match = re.search(r'"summary"\s*:\s*"([^"]+)"', line)
                    if sum_match:
                        title = sum_match.group(1)[:60]

                if ('"type":"user"' in line or '"type": "user"' in line or '"type":"queue-operation"' in line) and '"tool_result"' not in line:
                    content_match = re.search(r'"content"\s*:\s*"([^"]+)"', line)
                    if content_match:
                        raw = content_match.group(1)
                        clean = re.sub(r'<[^>]+>', '', raw).replace("\\n", " ").replace('\\"', '"').strip()
                        if clean and clean not in user_prompts:
                            user_prompts.append(clean[:150])

                if inspect_activity:
                    for fm in re.findall(r'"(?:file_path|notebook_path)"\s*:\s*"([^"]+)"', line):
                        clean_fm = fm.replace('\\\\', '/').replace('\\', '/')
                        if clean_fm.lower().startswith(project_root):
                            rel_path = clean_fm[len(project_root):].lstrip('/')
                            if rel_path:
                                touched_files.add(rel_path)
                        elif not clean_fm.startswith(('http://', 'https://')):
                            touched_files.add(clean_fm.split('/')[-1])
    except Exception:
        return None

    # The munged dir already binds the session to this project; a cwd mismatch
    # (session resumed from another workspace) is the only reason to reject.
    if cwd_seen and not cwd_confirmed:
        return None

    if first_timestamp:
        created = first_timestamp

    if title is None and user_prompts:
        title = user_prompts[0][:57] + "..." if len(user_prompts[0]) > 60 else user_prompts[0]

    result = {
        "vendor": "claude",
        "session_id": log_file.stem,
        "title": title or f"Session {log_file.stem}",
        "project_root": project_root,
        "is_active": is_active,
        "created_at": created,
        "last_active_at": last_active,
        "log_path": str(log_file.resolve()).replace("\\", "/")
    }

    if inspect_activity:
        result["recent_prompts"] = user_prompts[-5:]
        result["recent_touched_files"] = sorted(touched_files)[:15]

    return result


def main():
    project_root = sys.argv[1] if len(sys.argv) > 1 else "."
    inspect = "--inspect" in sys.argv or "-i" in sys.argv
    sessions = scan_claude_sessions(project_root, inspect_activity=inspect)
    print(json.dumps(sessions, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
