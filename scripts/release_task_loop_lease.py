#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Release Task Loop Lease
Safely releases a lease lock held by a specific run ID.
"""

import sys
import json
import argparse
from pathlib import Path


def release_lease(lease_path_str: str, run_id: str) -> dict:
    lease_file = Path(lease_path_str).resolve()
    if not lease_file.is_file():
        return {"action": "RELEASED", "reason": "lease_file_not_found"}

    try:
        with open(lease_file, "r", encoding="utf-8") as f:
            existing = json.load(f)
        if existing.get("run_id") == run_id:
            lease_file.unlink(missing_ok=True)
            return {"action": "RELEASED", "reason": "lease_released", "run_id": run_id}
        else:
            return {"action": "NOOP", "reason": "run_id_mismatch", "held_by": existing.get("run_id")}
    except Exception as e:
        return {"action": "INVALID", "reason": "release_error", "message": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Release Task Loop Lease")
    parser.add_argument("--lease", required=True, help="lease.json path")
    parser.add_argument("--run-id", required=True, help="Run ID")
    args = parser.parse_args()

    result = release_lease(args.lease, args.run_id)
    print(json.dumps(result, ensure_ascii=False))
    if result["action"] == "INVALID":
        sys.exit(2)


if __name__ == "__main__":
    main()
