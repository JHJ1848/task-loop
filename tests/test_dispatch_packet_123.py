#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for 1/2/3 Complexity Dispatch Packet
"""

import sys
import json
import uuid
import tempfile
import shutil
from pathlib import Path

scripts_dir = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(scripts_dir))

from initialize_task_loop_state import init_state
from new_task_loop_dispatch_packet import create_dispatch_packet
from release_task_loop_lease import release_lease


def test_complexity_dispatch():
    temp_dir = tempfile.mkdtemp(prefix="test_dispatch_")
    try:
        runtime = Path(temp_dir) / ".agents" / "task-loop"
        init_state(str(runtime))

        todo_file = runtime / "todo.json"
        sessions_file = runtime / "sessions.json"
        lease_file = runtime / "lease.json"

        target_thread = str(uuid.uuid4())
        sessions_data = {
            "schema_version": 1,
            "main_thread_id": str(uuid.uuid4()),
            "modules": {
                "workflow": {
                    "thread_id": target_thread,
                    "title": "workflow-WorkflowModule"
                }
            }
        }
        with open(sessions_file, "w", encoding="utf-8") as f:
            json.dump(sessions_data, f, indent=2)

        for c in (1, 2, 3):
            run_id = str(uuid.uuid4())
            todo_data = {
                "schema_version": 2,
                "items": [
                    {
                        "id": f"LOOP-00{c}",
                        "state": "ready",
                        "confirmation": "approved",
                        "user_description": [{"text": f"Test requirement {c}"}],
                        "agent_goal": {
                            "complexity": c,
                            "module_keys": ["workflow"],
                            "objective": f"Objective for level {c}",
                            "allowlist": ["src/*"]
                        }
                    }
                ]
            }
            with open(todo_file, "w", encoding="utf-8") as f:
                json.dump(todo_data, f, indent=2)

            res = create_dispatch_packet(temp_dir, run_id, target_thread)
            assert res["action"] == "PREPARED", f"Failed on level {c}: {res}"
            assert res["complexity"] == c, f"Complexity mismatch on level {c}: {res}"

            expected_policy = {1: "none", 2: "optional", 3: "mandatory"}[c]
            assert res["subagent_policy"] == expected_policy

            packet_file = Path(temp_dir) / res["packet_path"]
            with open(packet_file, "r", encoding="utf-8") as f:
                packet = json.load(f)
            assert packet["subagent_policy"] == expected_policy

            # Release lease for next test item
            rel = release_lease(str(lease_file), run_id)
            assert rel["action"] == "RELEASED"

            print(f"Python Complexity Level {c} ({expected_policy}) Dispatch Test PASSED!")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    test_complexity_dispatch()
