#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test Task Loop Preflight
Evaluates whether current queue item is eligible for dispatch (1/2/3 complexity aware).
"""

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime, timezone


def preflight(todo_path: str = None, registry_path: str = None, policy_path: str = None, lease_path: str = None, project_root: str = ".") -> dict:
    root = Path(project_root).resolve()
    
    if not todo_path:
        runtime = root / ".agents" / "task-loop"
        if not runtime.is_dir():
            runtime = root / ".codex" / "task-loop"
        todo_file = runtime / "todo.json"
        lease_file = runtime / "lease.json"
    else:
        todo_file = Path(todo_path) if Path(todo_path).is_absolute() else root / todo_path
        lease_file = Path(lease_path) if lease_path and Path(lease_path).is_absolute() else (root / lease_path if lease_path else None)

    if not todo_file.is_file():
        return {"action": "NOOP", "reason": "no_todo_items"}

    try:
        with open(todo_file, "r", encoding="utf-8") as f:
            todo = json.load(f)
    except Exception as e:
        return {"action": "INVALID", "reason": f"todo_parse_error: {e}"}

    # Check active lease
    if lease_file and lease_file.is_file():
        try:
            with open(lease_file, "r", encoding="utf-8") as f:
                lease = json.load(f)
            exp_str = lease.get("expires_at")
            if exp_str:
                exp_dt = datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
                if exp_dt > datetime.now(timezone.utc):
                    return {
                        "action": "NOOP",
                        "reason": "active_lease_held",
                        "active_task": lease.get("task_id"),
                        "run_id": lease.get("run_id")
                    }
        except Exception:
            pass

    items = todo.get("items", [])
    active_items = [i for i in items if i.get("state") not in ("done", "cancelled")]
    if not active_items:
        return {"action": "NOOP", "reason": "queue_empty"}

    first_item = active_items[0]
    state = first_item.get("state")
    confirmation = first_item.get("confirmation")

    if state == "ready" and confirmation == "approved":
        goal = first_item.get("agent_goal", {})
        return {
            "action": "DISPATCH",
            "reason": "eligible",
            "item_id": first_item.get("id"),
            "complexity": goal.get("complexity", 2)
        }
    elif state in ("needs_normalization", "planning", "awaiting_user_input", "awaiting_user_confirmation"):
        return {
            "action": "DISCUSS",
            "reason": "pending_discussion",
            "item_id": first_item.get("id"),
            "state": state
        }

    return {
        "action": "NOOP",
        "reason": "item_in_progress",
        "item_id": first_item.get("id"),
        "state": state
    }


def main():
    parser = argparse.ArgumentParser(description="Test Task Loop Preflight")
    parser.add_argument("--todo", default=None, help="todo.json path")
    parser.add_argument("--registry", default=None, help="sessions.json path")
    parser.add_argument("--policy", default=None, help="policy.json path")
    parser.add_argument("--lease", default=None, help="lease.json path")
    parser.add_argument("--root", default=".", help="Project root")
    args = parser.parse_args()

    result = preflight(args.todo, args.registry, args.policy, args.lease, args.root)
    print(json.dumps(result, ensure_ascii=False))
    if result["action"] == "INVALID":
        sys.exit(2)


if __name__ == "__main__":
    main()
