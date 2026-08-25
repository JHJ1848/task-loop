#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Find Project Sessions (Universal Scanner & Introspection Entrypoint)
Aggregates sessions across Antigravity, Codex, and Claude Code.
Supports --inspect to extract recent user prompts and touched files for AI tagging.
"""

import sys
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


def find_sessions(project_root: str = ".", vendor: str = "Auto", inspect: bool = False) -> list:
    all_sessions = []
    vendor = vendor.lower()
    
    if vendor == "antigravity":
        all_sessions.extend(scan_agy_sessions(project_root, inspect_activity=inspect))
    elif vendor == "codex":
        all_sessions.extend(scan_codex_sessions(project_root))
    elif vendor == "claude":
        all_sessions.extend(scan_claude_sessions(project_root, inspect_activity=inspect))
    elif vendor == "all":
        all_sessions.extend(scan_agy_sessions(project_root, inspect_activity=inspect))
        all_sessions.extend(scan_codex_sessions(project_root))
        all_sessions.extend(scan_claude_sessions(project_root, inspect_activity=inspect))
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
                
        if active_vendor == "antigravity":
            agy = scan_agy_sessions(project_root, inspect_activity=inspect)
            all_sessions.extend(agy)
            if not agy:
                all_sessions.extend(scan_codex_sessions(project_root))
        elif active_vendor == "codex":
            codex = scan_codex_sessions(project_root)
            all_sessions.extend(codex)
            if not codex:
                all_sessions.extend(scan_agy_sessions(project_root, inspect_activity=inspect))
        elif active_vendor == "claude":
            all_sessions.extend(scan_claude_sessions(project_root, inspect_activity=inspect))
        else:
            all_sessions.extend(scan_agy_sessions(project_root, inspect_activity=inspect))
            
    return all_sessions


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Find & Inspect project sessions across AI agents.")
    parser.add_argument("--root", default=".", help="Project root path (default: current directory)")
    parser.add_argument("--vendor", default="Auto", choices=["Auto", "Antigravity", "Codex", "Claude", "All"], help="Vendor selector")
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
