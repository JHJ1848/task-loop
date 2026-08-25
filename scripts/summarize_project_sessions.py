#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Summarize Project Sessions & Topic Recommendation Utility
Aggregates sessions across Antigravity, Codex, and Claude Code,
providing structured Markdown reports, activity analysis, and topic tagging recommendations.
"""

import sys
import json
import argparse
from pathlib import Path
from typing import List, Dict, Any, Optional

# Ensure UTF-8 output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Add scripts directory to sys.path
script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

from find_project_sessions import find_sessions


def infer_suggested_module(session: Dict[str, Any]) -> str:
    """
    Infer candidate module_key from touched files and prompt keywords.
    """
    touched = session.get("recent_touched_files", [])
    title = (session.get("title") or "").lower()
    prompts = " ".join(session.get("recent_prompts", [])).lower()

    # Heuristic matching based on project paths and keywords
    path_str = " ".join(touched).lower()

    if any(k in path_str or k in title or k in prompts for k in ["session", "provider", "get_agy", "get_codex", "get_claude"]):
        return "session_control"
    if any(k in path_str or k in title or k in prompts for k in ["dispatch", "packet", "123", "complexity"]):
        return "dispatch_engine"
    if any(k in path_str or k in title or k in prompts for k in ["lease", "lock"]):
        return "lease_manager"
    if any(k in path_str or k in title or k in prompts for k in ["reconcile", "topic", "registry"]):
        return "topic_registry"
    if any(k in path_str or k in title or k in prompts for k in ["test", "preflight", "check"]):
        return "verification_gate"

    # Default based on first top directory
    for f in touched:
        parts = Path(f).parts
        if len(parts) > 1:
            return parts[0]

    return "general"


def format_markdown_table(sessions: List[Dict[str, Any]], limit: int = 20, suggest_topics: bool = True) -> str:
    """
    Format discovered sessions into a structured Markdown table.
    """
    if not sessions:
        return "未发现属于当前工程的有效会话记录 (No active or historical sessions discovered)."

    lines = []
    lines.append("| 厂商 (Vendor) | 会话标识 (Session ID) | 最近活跃 (Last Active UTC) | 状态 | 标题 / 意图摘要 | 触达文件数 | 建议专题 (Suggested Topic) |")
    lines.append("|---|---|---|---|---|---|---|")

    for s in sessions[:limit]:
        vendor = s.get("vendor", "unknown").upper()
        sid = s.get("session_id", "unknown")
        # Shorten UUID for table display if too long
        sid_display = f"`{sid[:8]}...`" if len(sid) > 16 else f"`{sid}`"
        
        last_active = s.get("last_active_at", "")
        if last_active and "T" in last_active:
            last_active_clean = last_active.split("T")[0] + " " + last_active.split("T")[1][:8]
        else:
            last_active_clean = last_active or "-"

        is_active = s.get("is_active")
        if is_active is True:
            status = "活动 (Active)"
        elif is_active is False:
            status = "离线 (Idle)"
        else:
            status = "已登记 (Registered)"

        title = s.get("title", f"Session {sid}")
        # Clean title: remove backslashes, normalize spaces and escape pipes
        title_clean = title.replace("\\", " ").replace("|", "/").replace("\n", " ").strip()
        while "  " in title_clean:
            title_clean = title_clean.replace("  ", " ")
        if len(title_clean) > 40:
            title_clean = title_clean[:37] + "..."

        touched_files = s.get("recent_touched_files", [])
        touched_count = str(len(touched_files)) if touched_files else "0"

        suggested = infer_suggested_module(s) if suggest_topics else "-"

        lines.append(f"| {vendor} | {sid_display} | {last_active_clean} | {status} | {title_clean} | {touched_count} | `{suggested}` |")

    return "\n".join(lines)


def summarize_project_sessions(
    project_root: str = ".",
    vendor: str = "Auto",
    active_only: bool = False,
    limit: int = 20,
    output_format: str = "markdown",
    suggest_topics: bool = True
) -> Any:
    """
    Main function to aggregate and summarize project sessions.
    """
    sessions = find_sessions(project_root=project_root, vendor=vendor, inspect=True)

    if active_only:
        sessions = [s for s in sessions if s.get("is_active") is True]

    if output_format == "json":
        return json.dumps(sessions[:limit], ensure_ascii=False, indent=2)
    elif output_format == "tsv":
        out_lines = ["vendor\tsession_id\tlast_active_at\tis_active\ttitle\tsuggested_module"]
        for s in sessions[:limit]:
            out_lines.append(f"{s.get('vendor')}\t{s.get('session_id')}\t{s.get('last_active_at')}\t{s.get('is_active')}\t{s.get('title')}\t{infer_suggested_module(s)}")
        return "\n".join(out_lines)
    else:  # markdown
        return format_markdown_table(sessions, limit=limit, suggest_topics=suggest_topics)


def main():
    parser = argparse.ArgumentParser(description="Summarize project sessions across AI agents & recommend topic bindings.")
    parser.add_argument("--root", default=".", help="Project root path (default: .)")
    parser.add_argument("--vendor", default="Auto", choices=["Auto", "Antigravity", "Codex", "Claude", "All"], help="Vendor selector")
    parser.add_argument("--format", default="markdown", choices=["markdown", "json", "tsv"], help="Output format")
    parser.add_argument("--active-only", action="store_true", help="Filter active sessions only")
    parser.add_argument("--limit", type=int, default=20, help="Maximum number of sessions to display (default: 20)")
    parser.add_argument("--no-suggest", action="store_true", help="Disable topic inference")
    args = parser.parse_args()

    output = summarize_project_sessions(
        project_root=args.root,
        vendor=args.vendor,
        active_only=args.active_only,
        limit=args.limit,
        output_format=args.format,
        suggest_topics=not args.no_suggest
    )
    print(output)


if __name__ == "__main__":
    main()
