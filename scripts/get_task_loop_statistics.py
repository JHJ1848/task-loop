#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Get Task Loop Statistics
Calculates summary statistics of the task-loop queue and registered topics.
"""

import sys
import json
import argparse
from pathlib import Path


def get_statistics(project_root: str = ".") -> dict:
    root = Path(project_root).resolve()
    runtime = root / ".agents" / "task-loop"
    if not runtime.is_dir():
        runtime = root / ".codex" / "task-loop"

    todo_file = runtime / "todo.json"
    sessions_file = runtime / "sessions.json"

    stats = {
        "total_items": 0,
        "ready": 0,
        "in_progress": 0,
        "done": 0,
        "blocked": 0,
        "registered_modules": 0
    }

    if todo_file.is_file():
        try:
            with open(todo_file, "r", encoding="utf-8") as f:
                todo = json.load(f)
            items = todo.get("items", [])
            stats["total_items"] = len(items)
            stats["ready"] = len([i for i in items if i.get("state") == "ready"])
            stats["in_progress"] = len([i for i in items if i.get("state") in ("dispatched", "in_progress", "verifying")])
            stats["done"] = len([i for i in items if i.get("state") == "done"])
            stats["blocked"] = len([i for i in items if i.get("state") == "blocked"])
        except Exception:
            pass

    if sessions_file.is_file():
        try:
            with open(sessions_file, "r", encoding="utf-8") as f:
                sessions = json.load(f)
            modules = sessions.get("modules", {})
            stats["registered_modules"] = len(modules)
        except Exception:
            pass

    return stats


def main():
    parser = argparse.ArgumentParser(description="Get Task Loop Statistics")
    parser.add_argument("--root", default=".", help="Project root")
    args = parser.parse_args()

    stats = get_statistics(args.root)
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
