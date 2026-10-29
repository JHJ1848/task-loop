#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Claude Code Session Provider (Python).

Reads the Claude Desktop session registry (~/.claude/sessions/<pid>.json) and
reports whether a live App session attachment currently exists for a session.

Measurement scope: the registry only lists running/attachable processes, and an
entry disappears once that process exits. The App session index has no readable
on-disk source, so this tool can never tell whether an idle session is still
listed in the sidebar. Every verdict is therefore scoped to
`verdict_scope: live_registry_presence`:
  - true  -> an interactive App session with a hostSessionId is attached now
  - false -> no live attachment right now (pid_dead / not_registered), which
             does NOT mean the session is missing from the sidebar list

App ids (local_xxx) and CLI/hook ids (bare UUID) are two namespaces; topic
binding must always use the bare UUID, resolved from hostSessionId via
`resolve`.
"""

from __future__ import print_function

import json
import os
import sys
from datetime import datetime, timezone

VERDICT_SCOPE = "live_registry_presence"

REASON = {
    "VISIBLE": "interactive_app_session",
    "NO_HOST_SESSION_ID": "no_host_session_id",
    "KIND_BG": "kind_bg",
    "PID_DEAD": "pid_dead",
    "NOT_REGISTERED": "not_registered",
}

COMMANDS = ("list", "verify", "resolve")

USAGE = "\n".join([
    "Usage:",
    "  python claude_session_provider.py list [--cwd <path>] [--all] [--claude-home <dir>]",
    "  python claude_session_provider.py verify --session <uuid|local_xxx> [--claude-home <dir>]",
    "  python claude_session_provider.py resolve --host <local_xxx> [--claude-home <dir>]",
    "",
    "Reasons: interactive_app_session | no_host_session_id | kind_bg | pid_dead | not_registered",
    "",
    "Scope: verdict_scope is always live_registry_presence. reason=not_registered or",
    "pid_dead means no live process is attached right now; it does NOT mean the",
    "session is absent from the App sidebar list - idle App sessions stay listed.",
])


def default_claude_home():
    return os.path.join(os.path.expanduser("~"), ".claude")


def sessions_dir(claude_home):
    return os.path.join(os.path.abspath(claude_home or default_claude_home()), "sessions")


def normalize_value(value):
    return value.strip() if isinstance(value, str) else ""


def normalize_path(p):
    if not p:
        return ""
    normalized = os.path.abspath(p).replace("\\", "/")
    return normalized.rstrip("/").lower()


def is_host_session_id(value):
    return normalize_value(value).startswith("local_")


def is_pid_alive(pid):
    try:
        value = int(pid)
    except (TypeError, ValueError):
        return False
    if value <= 0:
        return False

    if os.name == "nt":
        import ctypes

        # PROCESS_QUERY_LIMITED_INFORMATION; OpenProcess fails for a pid that is
        # gone or out of range, which is exactly the staleness signal we want.
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, 0, value)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True

    try:
        os.kill(value, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def format_timestamp(ms):
    if not ms:
        return None
    try:
        moment = datetime.fromtimestamp(float(ms) / 1000.0, timezone.utc)
    except (TypeError, ValueError, OSError, OverflowError):
        return None
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_registry_file(file_path):
    try:
        with open(file_path, "r", encoding="utf-8") as handle:
            raw = handle.read()
    except OSError as error:
        print("[claude-provider] unreadable registry entry %s: %s" % (os.path.basename(file_path), error), file=sys.stderr)
        return None

    try:
        parsed = json.loads(raw)
    except ValueError as error:
        print("[claude-provider] invalid registry entry %s: %s" % (os.path.basename(file_path), error), file=sys.stderr)
        return None
    if not isinstance(parsed, dict):
        return None

    file_pid = os.path.splitext(os.path.basename(file_path))[0]
    try:
        file_pid = int(file_pid)
    except ValueError:
        file_pid = None

    entry_pid = parsed.get("pid")
    try:
        entry_pid = int(entry_pid)
    except (TypeError, ValueError):
        entry_pid = None
    if entry_pid is not None and entry_pid <= 0:
        entry_pid = None

    updated_at = parsed.get("updatedAt") or parsed.get("statusUpdatedAt")
    try:
        updated_at = int(updated_at)
    except (TypeError, ValueError):
        updated_at = None

    return {
        "pid": entry_pid if entry_pid is not None else file_pid,
        "session_id": normalize_value(parsed.get("sessionId")),
        "host_session_id": normalize_value(parsed.get("hostSessionId")),
        "kind": normalize_value(parsed.get("kind")),
        "entrypoint": normalize_value(parsed.get("entrypoint")),
        "cwd": normalize_value(parsed.get("cwd")),
        "name": normalize_value(parsed.get("name")),
        "status": normalize_value(parsed.get("status")),
        "updated_at": format_timestamp(updated_at),
        "registry_path": os.path.abspath(file_path).replace("\\", "/"),
    }


def load_registry(claude_home):
    directory = sessions_dir(claude_home)
    if not os.path.isdir(directory):
        return []

    entries = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        entry = read_registry_file(os.path.join(directory, name))
        if entry:
            entries.append(entry)
    return entries


def classify_entry(entry):
    """Reason precedence follows reachability: a bg session never carries a
    hostSessionId, so the kind gate has to answer before the id gate.

    The verdict answers "is a live App session attached right now?", not "is
    this session a member of the sidebar list?" - see VERDICT_SCOPE.
    """
    if not entry or not entry.get("session_id"):
        return {"sidebar_visible": False, "reason": REASON["NOT_REGISTERED"]}
    if entry.get("kind") != "interactive":
        return {"sidebar_visible": False, "reason": REASON["KIND_BG"]}
    if not entry.get("host_session_id"):
        return {"sidebar_visible": False, "reason": REASON["NO_HOST_SESSION_ID"]}
    if not is_pid_alive(entry.get("pid")):
        return {"sidebar_visible": False, "reason": REASON["PID_DEAD"]}
    return {"sidebar_visible": True, "reason": REASON["VISIBLE"]}


def describe_entry(entry):
    verdict = classify_entry(entry)
    return {
        "session_id": entry["session_id"],
        "host_session_id": entry["host_session_id"],
        "pid": entry["pid"],
        "kind": entry["kind"],
        "entrypoint": entry["entrypoint"],
        "cwd": entry["cwd"],
        "name": entry["name"],
        "status": entry["status"],
        "updated_at": entry["updated_at"],
        "registry_path": entry["registry_path"],
        "sidebar_visible": verdict["sidebar_visible"],
        "reason": verdict["reason"],
        "verdict_scope": VERDICT_SCOPE,
    }


def find_by_session_id(entries, session_id):
    target = normalize_value(session_id)
    if not target:
        return None
    for entry in entries:
        if entry["session_id"] == target:
            return entry
    return None


def find_by_host_session_id(entries, host_session_id):
    target = normalize_value(host_session_id)
    if not target:
        return None
    for entry in entries:
        if entry["host_session_id"] == target:
            return entry
    return None


def list_sessions(options=None):
    options = options or {}
    claude_home = os.path.abspath(options.get("claude_home") or default_claude_home())
    cwd_filter = normalize_path(options.get("cwd")) if options.get("cwd") else ""
    include_all = bool(options.get("all"))

    entries = [describe_entry(entry) for entry in load_registry(claude_home)]
    if cwd_filter:
        entries = [entry for entry in entries if normalize_path(entry["cwd"]) == cwd_filter]
    if not include_all:
        entries = [entry for entry in entries if entry["sidebar_visible"]]

    entries.sort(key=lambda entry: entry["session_id"])
    entries.sort(key=lambda entry: entry["updated_at"] or "", reverse=True)

    return {
        "vendor": "claude",
        "claude_home": claude_home.replace("\\", "/"),
        "cwd_filter": options.get("cwd"),
        "sidebar_visible_only": not include_all,
        "count": len(entries),
        "sessions": entries,
    }


def verify_session(session_ref, options=None):
    options = options or {}
    claude_home = os.path.abspath(options.get("claude_home") or default_claude_home())
    query = normalize_value(session_ref)
    query_kind = "host_session_id" if is_host_session_id(query) else "session_id"
    entries = load_registry(claude_home)
    entry = (find_by_host_session_id(entries, query) if query_kind == "host_session_id"
             else find_by_session_id(entries, query))

    if not entry:
        return {
            "vendor": "claude",
            "query": query,
            "query_kind": query_kind,
            "found": False,
            "session_id": None,
            "host_session_id": query if query_kind == "host_session_id" else None,
            "sidebar_visible": False,
            "reason": REASON["NOT_REGISTERED"],
            "verdict_scope": VERDICT_SCOPE,
        }

    result = {"vendor": "claude", "query": query, "query_kind": query_kind, "found": True}
    result.update(describe_entry(entry))
    return result


def resolve_host_session(host_session_id, options=None):
    options = options or {}
    claude_home = os.path.abspath(options.get("claude_home") or default_claude_home())
    query = normalize_value(host_session_id)
    entry = find_by_host_session_id(load_registry(claude_home), query)
    if not entry:
        return {
            "vendor": "claude",
            "host_session_id": query,
            "resolved": False,
            "session_id": None,
            "reason": REASON["NOT_REGISTERED"],
            "verdict_scope": VERDICT_SCOPE,
        }
    verdict = classify_entry(entry)
    return {
        "vendor": "claude",
        "host_session_id": query,
        "resolved": True,
        "session_id": entry["session_id"],
        "cwd": entry["cwd"],
        "registry_path": entry["registry_path"],
        "sidebar_visible": verdict["sidebar_visible"],
        "reason": verdict["reason"],
        "verdict_scope": VERDICT_SCOPE,
    }


def parse_args(argv):
    options = {"all": False, "cwd": None, "claude_home": None, "session": None, "host": None, "help": False}
    index = 0
    while index < len(argv):
        arg = argv[index]
        key, separator, inline = arg.partition("=")
        if not separator:
            inline = None

        if key in ("--all", "-a"):
            options["all"] = True
            index += 1
            continue
        if key in ("--help", "-h"):
            options["help"] = True
            index += 1
            continue
        if key not in ("--cwd", "--claude-home", "--session", "--host"):
            return None, "unknown option: %s" % arg

        if inline is not None:
            value = inline
        else:
            index += 1
            if index >= len(argv):
                return None, "missing value for %s" % key
            value = argv[index]
        options[key.lstrip("-").replace("-", "_")] = value
        index += 1
    return options, None


def run(argv):
    command = argv[0] if argv else None
    if not command or command in ("--help", "-h"):
        print(USAGE)
        return 0
    if command not in COMMANDS:
        print("[claude-provider] unknown command: %s" % command, file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    options, error = parse_args(argv[1:])
    if error:
        print("[claude-provider] %s" % error, file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2
    if options["help"]:
        print(USAGE)
        return 0

    if command == "list":
        print(json.dumps(list_sessions(options), indent=2, ensure_ascii=False))
        return 0
    if command == "verify":
        if not options["session"]:
            print("[claude-provider] verify requires --session <uuid|local_xxx>", file=sys.stderr)
            return 2
        result = verify_session(options["session"], options)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0 if result["sidebar_visible"] else 1
    if not options["host"]:
        print("[claude-provider] resolve requires --host <local_xxx>", file=sys.stderr)
        return 2
    result = resolve_host_session(options["host"], options)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["resolved"] else 1


def main():
    # Session names carry non-ASCII text; keep the CLI byte-compatible with the
    # Node implementation instead of the console code page.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
