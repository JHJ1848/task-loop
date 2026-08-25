#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Initialize Task Loop State
Initializes project task-loop state files (.agents/task-loop/) with UTF-8 encoding.
Supports auto-scanning project sessions, standardized title generation ([具体专题] 功能点1 & 功能点2),
and managing main_thread_id selection.
"""

import sys
import json
import uuid
import re
import argparse
from pathlib import Path
from typing import List, Dict, Any, Optional

# Ensure UTF-8 stdout
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

from find_project_sessions import find_sessions


def generate_standard_title(session: Dict[str, Any]) -> str:
    """
    Generate a standardized title formatted as [具体专题] 功能点1 & 功能点2.
    """
    prompts = " ".join(session.get("recent_prompts", [])).lower()
    touched = " ".join(session.get("recent_touched_files", [])).lower()
    combined = f"{prompts} {touched}"

    # Determine topic category
    if "主会话" in combined or "skill的开发仓库" in combined or "任务编排" in combined:
        category = "主会话"
        func1 = "任务编排"
        func2 = "治理中枢"
    elif "会话" in combined or "session" in combined or "sdk" in combined:
        category = "会话专题"
        func1 = "SDK接口封装"
        func2 = "会话管理"
    elif "memory" in combined or "记忆" in combined:
        category = "记忆专题"
        func1 = "记忆文档维护"
        func2 = "经验沉淀"
    elif "dispatch" in combined or "123" in combined or "complexity" in combined:
        category = "调度专题"
        func1 = "复杂度裁决"
        func2 = "派单协议"
    elif "lease" in combined or "lock" in combined:
        category = "租约专题"
        func1 = "原子锁控制"
        func2 = "并发防护"
    elif "test" in combined or "preflight" in combined:
        category = "测试专题"
        func1 = "门禁验证"
        func2 = "自动化回归"
    else:
        category = "通用专题"
        # Extract first 2 meaningful verbs/nouns from prompt
        raw_prompt = session.get("recent_prompts", [""])[0] if session.get("recent_prompts") else ""
        cleaned = re.sub(r'[^\w\s\u4e00-\u9fa5]', ' ', raw_prompt)
        words = [w for w in cleaned.split() if len(w) >= 2][:2]
        func1 = words[0] if len(words) > 0 else "功能开发"
        func2 = words[1] if len(words) > 1 else "自测验证"

    return f"[{category}] {func1} & {func2}"


def init_state(
    root_path_str: str = ".agents/task-loop",
    project_root_str: str = ".",
    main_thread_id: Optional[str] = None,
    active_vendor: str = "antigravity",
    scan_sessions: bool = True,
    clear_main: bool = False
) -> dict:
    root = Path(root_path_str).resolve()
    root.mkdir(parents=True, exist_ok=True)
    
    sessions_file = root / "sessions.json"
    existing_sessions_data = {}
    if sessions_file.is_file():
        try:
            with open(sessions_file, "r", encoding="utf-8") as f:
                existing_sessions_data = json.load(f)
        except Exception:
            existing_sessions_data = {}

    if clear_main:
        main_thread_id = None
    elif main_thread_id is None:
        main_thread_id = existing_sessions_data.get("main_thread_id")

    # Discover sessions if requested
    discovered_sessions = []
    if scan_sessions:
        raw_sessions = find_sessions(project_root=project_root_str, vendor=active_vendor, inspect=True)
        for s in raw_sessions:
            sid = s.get("session_id")
            title = generate_standard_title(s)
            is_main = (sid == main_thread_id) if main_thread_id else False
            discovered_sessions.append({
                "session_id": sid,
                "vendor": s.get("vendor", active_vendor),
                "title": title,
                "is_main": is_main,
                "created_at": s.get("created_at"),
                "last_active_at": s.get("last_active_at"),
                "log_path": s.get("log_path"),
                "recent_prompts": s.get("recent_prompts", [])
            })

    # Prepare sessions.json content
    sessions_content = {
        "schema_version": 1,
        "main_thread_id": main_thread_id,
        "sessions": discovered_sessions if discovered_sessions else existing_sessions_data.get("sessions", []),
        "modules": existing_sessions_data.get("modules", {})
    }

    # Write sessions.json
    with open(sessions_file, "w", encoding="utf-8") as f:
        json.dump(sessions_content, f, ensure_ascii=False, indent=2)

    # Initialize other runtime files
    files_to_create = {
        "todo.json": {
            "schema_version": 2,
            "items": []
        },
        "topics.json": {
            "schema_version": 1,
            "ignored_memory_docs": [],
            "topics": []
        },
        "policy.json": {
            "schema_version": 1,
            "active_vendor": active_vendor,
            "lease_minutes": 25,
            "allow_remote_push": False,
            "model_profiles": {
                "simple": "gpt-5.6-luna",
                "standard": "gpt-5.6-terra",
                "complex": "gpt-5.6-sol"
            }
        }
    }

    for fname, content in files_to_create.items():
        fpath = root / fname
        if not fpath.is_file():
            with open(fpath, "w", encoding="utf-8") as f:
                json.dump(content, f, ensure_ascii=False, indent=2)

    journal = root / "run-journal.jsonl"
    if not journal.is_file():
        journal.touch()

    return {
        "action": "INITIALIZED",
        "root": str(root).replace("\\", "/"),
        "main_thread_id": main_thread_id,
        "active_vendor": active_vendor,
        "discovered_sessions_count": len(discovered_sessions)
    }


def main():
    parser = argparse.ArgumentParser(description="Initialize Task Loop State & Discover Sessions")
    parser.add_argument("--root", default=".agents/task-loop", help="State root directory")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--main-thread-id", default=None, help="Main thread ID")
    parser.add_argument("--clear-main", action="store_true", help="Clear main thread ID to trigger selection")
    parser.add_argument("--vendor", default="antigravity", help="Active vendor")
    parser.add_argument("--no-scan", action="store_true", help="Disable auto scanning of existing sessions")
    args = parser.parse_args()

    result = init_state(
        root_path_str=args.root,
        project_root_str=args.project_root,
        main_thread_id=args.main_thread_id,
        active_vendor=args.vendor,
        scan_sessions=not args.no_scan,
        clear_main=args.clear_main
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
