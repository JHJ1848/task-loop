#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Invoke Task Loop Tick
Executes a single tick of topic reconcile and queue preflight.
"""

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime, timezone

from reconcile_task_loop_topics import reconcile_topics
from test_task_loop_preflight import preflight


def invoke_tick(project_root: str = ".") -> dict:
    root = Path(project_root).resolve()
    runtime = root / ".agents" / "task-loop"
    if not runtime.is_dir():
        runtime = root / ".codex" / "task-loop"

    manifest_file = runtime / "topics.json"
    registry_file = runtime / "sessions.json"

    reconcile_result = None
    if manifest_file.is_file() and registry_file.is_file():
        reconcile_result = reconcile_topics(str(root), str(manifest_file), str(registry_file))

    preflight_result = preflight(project_root=str(root))

    return {
        "tick_at": datetime.now(timezone.utc).isoformat(),
        "reconcile": reconcile_result,
        "preflight": preflight_result
    }


def main():
    parser = argparse.ArgumentParser(description="Invoke Task Loop Tick")
    parser.add_argument("--root", default=".", help="Project root")
    args = parser.parse_args()

    result = invoke_tick(args.root)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
