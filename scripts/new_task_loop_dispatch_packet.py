#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
New Task Loop Dispatch Packet
Generates 1/2/3 complexity-aware dispatch packets and safely acquires task lease.
"""

import sys
import json
import uuid
import argparse
from pathlib import Path
from datetime import datetime, timezone

from acquire_task_loop_lease import acquire_lease


def normalize_complexity(val) -> int:
    if val is None:
        return 2
    s = str(val).strip().lower()
    if s in ("1", "simple"):
        return 1
    elif s in ("3", "complex"):
        return 3
    else:
        return 2


def create_dispatch_packet(project_root: str, run_id: str, target_thread_id: str) -> dict:
    root = Path(project_root).resolve()
    
    runtime = root / ".agents" / "task-loop"
    if not runtime.is_dir():
        runtime = root / ".codex" / "task-loop"

    todo_file = runtime / "todo.json"
    registry_file = runtime / "sessions.json"
    policy_file = runtime / "policy.json"
    lease_file = runtime / "lease.json"

    if not todo_file.is_file() or not registry_file.is_file():
        return {"action": "INVALID", "reason": "required_state_files_missing"}

    with open(todo_file, "r", encoding="utf-8") as f:
        todo = json.load(f)

    items = todo.get("items", [])
    active = [i for i in items if i.get("state") not in ("done", "cancelled")]
    if not active:
        return {"action": "NOOP", "reason": "no_eligible_items"}

    item = active[0]
    goal = item.get("agent_goal", {})

    complexity = normalize_complexity(goal.get("complexity"))
    subagent_policy = {1: "none", 2: "optional", 3: "mandatory"}[complexity]
    execution_mode = {
        1: "single_thread_direct",
        2: "standard_topic",
        3: "subagent_orchestration_required"
    }[complexity]

    allowlist = goal.get("allowlist", ["*"])
    criteria = goal.get("acceptance_criteria", [])
    verification = goal.get("verification", [])

    created_at = datetime.now(timezone.utc).isoformat()
    packet = {
        "schema_version": 2,
        "task_id": item.get("id"),
        "run_id": run_id,
        "target_thread_id": target_thread_id,
        "complexity": complexity,
        "subagent_policy": subagent_policy,
        "execution_mode": execution_mode,
        "objective": goal.get("objective", ""),
        "allowlist": allowlist,
        "acceptance_criteria": criteria,
        "verification": verification,
        "authorization": {
            "change_intent": goal.get("change_intent", "change"),
            "commit_policy": goal.get("commit_policy", "local_commit"),
            "remote_push_allowed": False
        },
        "created_at": created_at
    }

    dispatch_dir = runtime / "dispatch"
    dispatch_dir.mkdir(parents=True, exist_ok=True)
    packet_path = dispatch_dir / f"{run_id}.json"

    # Acquire lease
    lease_res = acquire_lease(str(lease_file), item.get("id"), run_id, 25)
    if lease_res.get("action") == "NOOP":
        return lease_res

    with open(packet_path, "w", encoding="utf-8") as f:
        json.dump(packet, f, ensure_ascii=False, indent=2)

    return {
        "action": "PREPARED",
        "reason": "dispatch_packet_created",
        "run_id": run_id,
        "packet_path": str(packet_path.relative_to(root)).replace("\\", "/"),
        "complexity": complexity,
        "subagent_policy": subagent_policy
    }


def main():
    parser = argparse.ArgumentParser(description="Create Task Loop Dispatch Packet")
    parser.add_argument("--root", default=".", help="Project root")
    parser.add_argument("--run-id", required=True, help="Run ID (UUID)")
    parser.add_argument("--target-thread-id", required=True, help="Target topic thread ID")
    args = parser.parse_args()

    result = create_dispatch_packet(args.root, args.run_id, args.target_thread_id)
    print(json.dumps(result, ensure_ascii=False))
    if result["action"] == "INVALID":
        sys.exit(2)


if __name__ == "__main__":
    main()
