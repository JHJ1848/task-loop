#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Codex session discovery for an outer task-loop controller."""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


ENVIRONMENT_ID_KEYS = ("CODEX_THREAD_ID", "CODEX_SESSION_ID")
SESSION_META_TYPE = "session_meta"
SUBAGENT_THREAD_SOURCE = "subagent"


def configure_utf8_stdout() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")


def normalize_path(path_str: str) -> str:
    if not path_str:
        return ""
    value = str(path_str).replace("\\", "/")
    if value.startswith("//?/"):
        value = value[4:]
    return str(Path(value).resolve()).replace("\\", "/").rstrip("/").lower()


def get_codex_home() -> Path:
    configured_home = os.environ.get("CODEX_HOME")
    return Path(configured_home) if configured_home else Path.home() / ".codex"


def get_current_session_id() -> Optional[str]:
    """Return the host-injected Codex thread ID without scanning history."""
    for key in ENVIRONMENT_ID_KEYS:
        value = os.environ.get(key)
        if value:
            return value
    return None


def get_current_session_metadata() -> dict:
    session_id = get_current_session_id()
    environment_key = next((key for key in ENVIRONMENT_ID_KEYS if os.environ.get(key)), None)
    return {
        "vendor": "codex",
        "session_id": session_id,
        "thread_id": session_id,
        "is_available": session_id is not None,
        "is_active": True if session_id else None,
        "activity_state": "current_process" if session_id else "unavailable",
        "discovery_source": "runtime_env" if session_id else "unavailable",
        "environment_key": environment_key,
    }


def read_session_meta(session_file: Path) -> Optional[dict]:
    try:
        with session_file.open("r", encoding="utf-8") as source:
            for line in source:
                line_str = line.strip()
                if not line_str:
                    continue
                try:
                    record = json.loads(line_str)
                    if record.get("type") == SESSION_META_TYPE and isinstance(record.get("payload"), dict):
                        return record["payload"]
                except json.JSONDecodeError as e:
                    sys.stderr.write(f"[codex-provider] schema mismatch in {session_file.name}: malformed json: {e}\n")
    except (OSError, UnicodeDecodeError) as e:
        sys.stderr.write(f"[codex-provider] schema mismatch in {session_file.name}: unreadable: {e}\n")
        return None
    return None


def build_log_record(metadata: dict, session_file: Path, project_root: str) -> dict:
    stat = session_file.stat()
    session_id = str(metadata.get("session_id") or metadata.get("parent_thread_id") or "")
    thread_source = metadata.get("thread_source", "unknown")
    title = metadata.get("title") or f"Session {session_id}"
    return {
        "vendor": "codex",
        "record_type": "subagent_transcript" if thread_source == SUBAGENT_THREAD_SOURCE else "session",
        "session_id": session_id,
        "thread_id": session_id,
        "title": title,
        "rollout_id": metadata.get("id"),
        "parent_thread_id": metadata.get("parent_thread_id"),
        "thread_source": thread_source,
        "agent_path": metadata.get("agent_path"),
        "project_root": project_root,
        "is_active": None,
        "activity_state": "unknown",
        "created_at": metadata.get("timestamp"),
        "last_active_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "log_path": str(session_file.resolve()).replace("\\", "/"),
        "discovery_source": "session_log",
    }


def scan_persisted_sessions(project_root: str, codex_home: Path, include_subagents: bool) -> list:
    sessions_dir = codex_home / "sessions"
    if not sessions_dir.is_dir():
        return []

    discovered = {}
    for session_file in sessions_dir.rglob("*.jsonl"):
        metadata = read_session_meta(session_file)
        cwd = metadata.get("cwd") if metadata else None
        if not isinstance(cwd, str) or not cwd.strip() or normalize_path(cwd) != project_root:
            continue
        if not include_subagents and metadata.get("thread_source") == SUBAGENT_THREAD_SOURCE:
            continue

        record = build_log_record(metadata, session_file, project_root)
        if not record["session_id"]:
            continue
        discovery_key = record["session_id"]
        if record["record_type"] == "subagent_transcript":
            discovery_key = (record["session_id"], record["rollout_id"])
        existing = discovered.get(discovery_key)
        if existing is None or record["last_active_at"] > existing["last_active_at"]:
            discovered[discovery_key] = record

    return sorted(discovered.values(), key=lambda item: item["last_active_at"], reverse=True)


def scan_task_loop_registries(root_path: Path, project_root: str) -> list:
    registries = (
        root_path / ".agents" / "task-loop" / "sessions.json",
        root_path / ".codex" / "task-loop" / "sessions.json",
    )
    records = []
    for registry_path in registries:
        if not registry_path.is_file():
            continue
        try:
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue

        registry_timestamp = datetime.fromtimestamp(registry_path.stat().st_mtime, tz=timezone.utc).isoformat()
        common = {
            "vendor": "codex",
            "record_type": "registration",
            "project_root": project_root,
            "is_active": None,
            "activity_state": "registered",
            "last_active_at": registry_timestamp,
            "log_path": str(registry_path.resolve()).replace("\\", "/"),
            "discovery_source": "task_loop_registry",
        }
        if registry.get("main_thread_id"):
            records.append({
                **common,
                "session_id": str(registry["main_thread_id"]),
                "thread_id": str(registry["main_thread_id"]),
                "title": "Codex Main Dispatcher",
            })
        for module_key, module in registry.get("modules", {}).items():
            if isinstance(module, dict) and module.get("thread_id"):
                records.append({
                    **common,
                    "session_id": str(module["thread_id"]),
                    "thread_id": str(module["thread_id"]),
                    "module_key": module_key,
                    "title": str(module.get("title", f"Codex Module {module_key}")),
                })
    return records


def scan_codex_sessions(
    project_root_str: str = ".",
    codex_home: Optional[Path] = None,
    include_subagents: bool = False,
    include_registry: bool = True,
) -> list:
    if not project_root_str or not project_root_str.strip():
        raise ValueError("project_root_str must not be empty")
    root_path = Path(project_root_str)
    project_root = normalize_path(project_root_str)
    records = scan_persisted_sessions(project_root, codex_home or get_codex_home(), include_subagents)
    if include_registry:
        records.extend(scan_task_loop_registries(root_path, project_root))
    return records


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser(description="Discover Codex runtime and project session metadata.")
    parser.add_argument("project_root", nargs="?", default=".", help="Project root path")
    parser.add_argument("--root", dest="root_option", help="Project root path (overrides positional root)")
    parser.add_argument("--current", action="store_true", help="Read only the host-injected current Codex thread ID")
    parser.add_argument("--include-subagents", action="store_true", help="Include non-routable child-agent transcripts")
    parser.add_argument("--exclude-registry", action="store_true", help="Exclude .agents/.codex task-loop registrations")
    args = parser.parse_args()

    if args.current:
        print(json.dumps(get_current_session_metadata(), ensure_ascii=False, indent=2))
        return

    root = args.root_option or args.project_root
    if not root.strip():
        parser.error("project root must not be empty")
    records = scan_codex_sessions(root, include_subagents=args.include_subagents, include_registry=not args.exclude_registry)
    print(json.dumps(records, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
