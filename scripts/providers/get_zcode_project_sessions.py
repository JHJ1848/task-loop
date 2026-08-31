#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ZCode Project Session Provider (Python)
Reverse-introspects ZCode sessions for a project root.

ZCode persistence topology:
  - ~/.zcode/cli/db/db.sqlite: authoritative SQLite3 metadata store (mode=ro)
  - ~/.zcode/cli/rollout/model-io-sess_<uuid>.jsonl: model I/O transcripts (fallback)

Output contract aligns 1:1 with get_agy_project_sessions.py / get_codex_project_sessions.py:
  { vendor, session_id, title, project_root, is_active, created_at,
    last_active_at, log_path, rule_files[, recent_prompts, recent_touched_files] }
"""

import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

ROLLOUT_FILENAME_RE = re.compile(r"sess[_-]?([0-9a-fA-F-]{36})\.jsonl$", re.IGNORECASE)


def normalize_path(p):
    if not p:
        return ""
    return os.path.abspath(p).replace("\\", "/").rstrip("/").lower()


def resolve_db_path(options):
    opts = options or {}
    if opts.get("db_path"):
        return os.path.abspath(opts["db_path"])
    if os.environ.get("ZCODE_DB_PATH"):
        return os.path.abspath(os.environ["ZCODE_DB_PATH"])
    return os.path.join(os.path.expanduser("~"), ".zcode", "cli", "db", "db.sqlite")


def resolve_rollout_dir(options):
    opts = options or {}
    if opts.get("rollout_dir"):
        return os.path.abspath(opts["rollout_dir"])
    if os.environ.get("ZCODE_ROLLOUT_DIR"):
        return os.path.abspath(os.environ["ZCODE_ROLLOUT_DIR"])
    return os.path.join(os.path.expanduser("~"), ".zcode", "cli", "rollout")


def iso_from_epoch_ms(epoch_ms):
    try:
        return datetime.fromtimestamp(epoch_ms / 1000.0, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3] + "Z"
    except Exception:
        return ""


def find_rollout_for_session(session_id, rollout_dir):
    suffix = session_id.replace("sess_", "", 1).replace("sess-", "", 1)
    candidate = os.path.join(rollout_dir, f"model-io-sess_{suffix}.jsonl")
    if os.path.exists(candidate):
        return candidate.replace("\\", "/")
    return None


def scan_sessions_via_db(project_root_str, options=None, inspect_activity=True):
    """Read-only sqlite introspection over ~/.zcode/cli/db/db.sqlite."""
    project_root = normalize_path(project_root_str)
    db_path = resolve_db_path(options)
    rollout_dir = resolve_rollout_dir(options)

    if not os.path.exists(db_path):
        return []

    sessions = []
    con = None
    try:
        # mode=ro guarantees we never lock or mutate the host's session store.
        con = sqlite3.connect(f"file:{db_path.replace(chr(92), '/')}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        cur = con.cursor()

        rows = cur.execute(
            "SELECT id, parent_id, title, directory, path, time_created, time_updated "
            "FROM session ORDER BY time_updated DESC"
        ).fetchall()

        for row in rows:
            row_dir = normalize_path(row["path"] or row["directory"] or "")
            if not row_dir or not (row_dir == project_root or row_dir.startswith(project_root + "/")):
                continue

            prompts = []
            touched = set()
            if inspect_activity:
                try:
                    ih_rows = cur.execute(
                        "SELECT substr(text, 1, 150) AS snippet FROM input_history "
                        "WHERE session_id = ? AND kind = 'prompt' ORDER BY time_created ASC LIMIT 20",
                        (row["id"],),
                    ).fetchall()
                    seen = set()
                    for ih in ih_rows:
                        clean = (ih["snippet"] or "").strip().split("\n")[0].strip()
                        if clean and clean not in seen:
                            seen.add(clean)
                            prompts.append(clean[:150])
                except sqlite3.Error:
                    pass

            title = (row["title"] or "").strip() or (
                prompts[0][:60] + ("..." if len(prompts[0]) > 60 else "") if prompts else f"Session {row['id']}"
            )

            agents_md = os.path.join(os.path.abspath(project_root_str), "AGENTS.md")
            rule_files = [agents_md.replace("\\", "/")] if os.path.exists(agents_md) else []
            log_file = find_rollout_for_session(row["id"], rollout_dir) or ""

            item = {
                "vendor": "zcode",
                "session_id": row["id"],
                "title": title,
                "project_root": project_root,
                "is_active": True,
                "created_at": iso_from_epoch_ms(row["time_created"]),
                "last_active_at": iso_from_epoch_ms(row["time_updated"]),
                "log_path": log_file,
                "rule_files": rule_files,
            }
            if inspect_activity:
                item["recent_prompts"] = prompts[-5:]
                item["parent_session_id"] = row["parent_id"]
            sessions.append(item)
    except sqlite3.Error:
        return []
    finally:
        if con is not None:
            con.close()

    sessions.sort(key=lambda s: (s.get("last_active_at") or ""), reverse=True)
    return sessions


def scan_sessions_via_rollout(project_root_str, options=None, inspect_activity=True):
    """Fallback: line-scan model I/O transcripts (same algorithm as the JS twin)."""
    project_root = normalize_path(project_root_str)
    rollout_dir = resolve_rollout_dir(options)

    if not os.path.isdir(rollout_dir):
        return []

    sessions = []
    prompt_re = re.compile(r'"role"\s*:\s*"user".*?"text"\s*:\s*"((?:[^"\\]|\\.)*)"')
    file_re = re.compile(r'"(?:AbsolutePath|TargetFile|SearchPath)"\s*:\s*"([^"]+)"')

    for entry in sorted(os.listdir(rollout_dir)):
        m = ROLLOUT_FILENAME_RE.search(entry)
        if not m:
            continue
        session_id = f"sess_{m.group(1)}"
        log_file = os.path.join(rollout_dir, entry)

        try:
            stat = os.stat(log_file)
            created = datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat()
            last_modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        except OSError:
            created = ""
            last_modified = ""

        try:
            with open(log_file, "r", encoding="utf-8", errors="ignore") as fh:
                content = fh.read()
        except OSError:
            continue

        lowered = content.lower()
        escaped = project_root.replace(":", "%3a")
        if project_root not in lowered and escaped not in content:
            continue

        prompts = []
        touched = set()
        if inspect_activity:
            for fm in file_re.finditer(content):
                clean_fm = fm.group(1).replace("\\\\", "/").replace("\\", "/")
                low = clean_fm.lower()
                if low.startswith(project_root):
                    rel = clean_fm[len(project_root):].lstrip("/")
                    if rel:
                        touched.add("/".join(rel.split("/")[:4]))
                elif not low.startswith(("http://", "https://")):
                    touched.add(os.path.basename(clean_fm))

            for pm in prompt_re.finditer(content):
                clean = re.sub(r"<[^>]+>", "", pm.group(1))
                clean = clean.replace("\\n", " ").replace('\\"', '"').strip()
                if clean and clean not in prompts:
                    prompts.append(clean[:150])

        title = prompts[0][:60] + ("..." if len(prompts[0]) > 60 else "") if prompts else f"Session {session_id}"

        agents_md = os.path.join(os.path.abspath(project_root_str), "AGENTS.md")
        rule_files = [agents_md.replace("\\", "/")] if os.path.exists(agents_md) else []

        item = {
            "vendor": "zcode",
            "session_id": session_id,
            "title": title,
            "project_root": project_root,
            "is_active": True,
            "created_at": created,
            "last_active_at": last_modified,
            "log_path": log_file.replace("\\", "/"),
            "rule_files": rule_files,
        }
        if inspect_activity:
            item["recent_prompts"] = prompts[-5:]
            item["recent_touched_files"] = sorted(touched)[:15]
        sessions.append(item)

    sessions.sort(key=lambda s: (s.get("last_active_at") or ""), reverse=True)
    return sessions


def scan_zcode_sessions(project_root_str=".", options=None, inspect_activity=True):
    sessions = scan_sessions_via_db(project_root_str, options, inspect_activity)
    if sessions:
        return sessions
    return scan_sessions_via_rollout(project_root_str, options, inspect_activity)


def main():
    args = sys.argv[1:]
    positional = [a for a in args if not a.startswith("-")]
    project_root = positional[0] if positional else "."
    inspect = "--inspect" in args or "-i" in args

    options = {}
    if "--db-path" in args:
        idx = args.index("--db-path")
        if idx + 1 < len(args):
            options["db_path"] = args[idx + 1]
    if "--rollout-dir" in args:
        ridx = args.index("--rollout-dir")
        if ridx + 1 < len(args):
            options["rollout_dir"] = args[ridx + 1]

    sessions = scan_zcode_sessions(project_root, options, inspect)
    print(json.dumps(sessions, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
