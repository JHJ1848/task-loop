#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Acquire Task Loop Lease
Safely acquires a time-bounded atomic lease lock for dispatching tasks.
"""

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta


def acquire_lease(lease_path_str: str, task_id: str, run_id: str, lease_minutes: int = 25) -> dict:
    lease_file = Path(lease_path_str).resolve()
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(minutes=lease_minutes)).isoformat()

    if lease_file.is_file():
        try:
            with open(lease_file, "r", encoding="utf-8") as f:
                existing = json.load(f)
            if existing.get("run_id") == run_id:
                return {"action": "LEASED", "reason": "lease_already_held", "run_id": run_id, "task_id": task_id}
            
            existing_exp = existing.get("expires_at")
            if existing_exp:
                exp_dt = datetime.fromisoformat(existing_exp.replace("Z", "+00:00"))
                if exp_dt > now:
                    return {
                        "action": "NOOP",
                        "reason": "lease_active_by_other",
                        "active_run_id": existing.get("run_id"),
                        "expires_at": existing_exp
                    }
        except Exception:
            pass

    lease_file.parent.mkdir(parents=True, exist_ok=True)
    lease_data = {
        "task_id": task_id,
        "run_id": run_id,
        "acquired_at": now.isoformat(),
        "expires_at": expires_at
    }

    with open(lease_file, "w", encoding="utf-8") as f:
        json.dump(lease_data, f, ensure_ascii=False, indent=2)

    return {"action": "LEASED", "reason": "lease_acquired", "run_id": run_id, "expires_at": expires_at}


def main():
    parser = argparse.ArgumentParser(description="Acquire Task Loop Lease")
    parser.add_argument("--lease", required=True, help="lease.json path")
    parser.add_argument("--task-id", required=True, help="Task ID")
    parser.add_argument("--run-id", required=True, help="Run ID")
    parser.add_argument("--minutes", type=int, default=25, help="Lease minutes")
    args = parser.parse_args()

    result = acquire_lease(args.lease, args.task_id, args.run_id, args.minutes)
    print(json.dumps(result, ensure_ascii=False))
    if result["action"] == "INVALID":
        sys.exit(2)


if __name__ == "__main__":
    main()
