#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Find Project Sessions (Universal Scanner & Introspection Entrypoint)
Aggregates sessions across Antigravity, Codex, and Claude Code.
Supports --inspect to extract recent user prompts and touched files for AI tagging.
"""

import sys
import os
import json
import argparse
from pathlib import Path

# Add providers directory to sys.path
script_dir = Path(__file__).resolve().parent
providers_dir = script_dir / "providers"
sys.path.insert(0, str(providers_dir))

from get_agy_project_sessions import scan_agy_sessions
from get_codex_project_sessions import get_current_session_metadata, scan_codex_sessions
from get_claude_project_sessions import scan_claude_sessions
from get_zcode_project_sessions import scan_zcode_sessions


def safe_scan(vendor_name: str, scan_fn) -> list:
    try:
        return scan_fn() or []
    except Exception as e:
        sys.stderr.write(f"[find-sessions] {vendor_name} provider error: {e}\n")
        return []


def find_sessions(project_root: str = ".", vendor: str = "Auto", inspect: bool = False) -> list:
    all_sessions = []
    vendor = vendor.lower()

    scan_agy = lambda: safe_scan("antigravity", lambda: scan_agy_sessions(project_root, inspect_activity=inspect))
    scan_codex = lambda: safe_scan("codex", lambda: scan_codex_sessions(project_root))
    scan_claude = lambda: safe_scan("claude", lambda: scan_claude_sessions(project_root, inspect_activity=inspect))
    scan_zcode = lambda: safe_scan("zcode", lambda: scan_zcode_sessions(project_root, inspect_activity=inspect))

    if vendor == "antigravity":
        all_sessions.extend(scan_agy())
    elif vendor == "codex":
        all_sessions.extend(scan_codex())
    elif vendor == "claude":
        all_sessions.extend(scan_claude())
    elif vendor == "zcode":
        all_sessions.extend(scan_zcode())
    elif vendor == "all":
        all_sessions.extend(scan_agy())
        all_sessions.extend(scan_codex())
        all_sessions.extend(scan_claude())
        all_sessions.extend(scan_zcode())
    else:  # "auto"
        root_path = Path(project_root)
        policy_file = root_path / ".agents" / "task-loop" / "policy.json"
        if not policy_file.is_file():
            policy_file = root_path / ".codex" / "task-loop" / "policy.json"

        active_vendor = "antigravity"
        if policy_file.is_file():
            try:
                with open(policy_file, "r", encoding="utf-8") as f:
                    p = json.load(f)
                    if p.get("active_vendor"):
                        active_vendor = str(p["active_vendor"]).lower()
            except Exception:
                pass
        if not policy_file.is_file():
            # No project policy: prefer the host this session is actually running in.
            if os.environ.get("ZCODE_SESSION_ID") or os.environ.get("CLAUDE_SESSION_ID"):
                active_vendor = "zcode"

        if active_vendor == "antigravity":
            agy = scan_agy()
            all_sessions.extend(agy)
            if not agy:
                all_sessions.extend(scan_codex())
                all_sessions.extend(scan_zcode())
        elif active_vendor == "codex":
            codex = scan_codex()
            all_sessions.extend(codex)
            if not codex:
                all_sessions.extend(scan_agy())
        elif active_vendor == "claude":
            all_sessions.extend(scan_claude())
        elif active_vendor == "zcode":
            zc = scan_zcode()
            all_sessions.extend(zc)
            if not zc:
                all_sessions.extend(scan_agy())
        else:
            all_sessions.extend(scan_agy())

    return all_sessions


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Find & Inspect project sessions across AI agents.")
    parser.add_argument("--root", default=".", help="Project root path (default: current directory)")
    parser.add_argument("--vendor", default="Auto", choices=["Auto", "Antigravity", "Codex", "Claude", "Zcode", "All"], help="Vendor selector")
    parser.add_argument("--inspect", "-i", action="store_true", help="Extract recent prompts and touched files for AI tagging")
    parser.add_argument("--current", action="store_true", help="Read the current Codex thread ID from host runtime metadata")
    args = parser.parse_args()

    if args.current:
        if args.vendor.lower() != "codex":
            parser.error("--current is currently supported only with --vendor Codex")
        print(json.dumps(get_current_session_metadata(), ensure_ascii=False, indent=2))
        return

    sessions = find_sessions(args.root, args.vendor, args.inspect)
    print(json.dumps(sessions, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
