#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Initialize Task Loop State
Initializes project task-loop state files (.agents/task-loop/) with UTF-8 encoding.
"""

import sys
import json
import uuid
import argparse
from pathlib import Path


def init_state(root_path_str: str = ".agents/task-loop", main_thread_id: str = None, active_vendor: str = "antigravity") -> dict:
    root = Path(root_path_str).resolve()
    root.mkdir(parents=True, exist_ok=True)
    
    if not main_thread_id:
        main_thread_id = str(uuid.uuid4())

    files_to_create = {
        "todo.json": {
            "schema_version": 2,
            "items": []
        },
        "sessions.json": {
            "schema_version": 1,
            "main_thread_id": main_thread_id,
            "modules": {}
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
        "active_vendor": active_vendor
    }


def main():
    parser = argparse.ArgumentParser(description="Initialize Task Loop State")
    parser.add_argument("--root", default=".agents/task-loop", help="State root directory")
    parser.add_argument("--main-thread-id", default=None, help="Main thread ID")
    parser.add_argument("--vendor", default="antigravity", help="Active vendor")
    args = parser.parse_args()

    result = init_state(args.root, args.main_thread_id, args.vendor)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
