#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for Topic Reconcile and Registry Preflight
"""

import sys
import json
import tempfile
import shutil
from pathlib import Path

scripts_dir = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(scripts_dir))

from reconcile_task_loop_topics import reconcile_topics
from test_task_loop_topic_registry import test_registry


def test_topic_lifecycle():
    temp_dir = tempfile.mkdtemp(prefix="test_reconcile_")
    try:
        root = Path(temp_dir)
        manifest_path = root / "topics.json"
        registry_path = root / "sessions.json"

        manifest_data = {
            "schema_version": 1,
            "topics": [
                {
                    "module_key": "auth",
                    "title": "auth-AuthModule",
                    "title_prefix": "auth-",
                    "memory_docs": ["docs/memory/auth.md"],
                    "enabled": True
                }
            ]
        }
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest_data, f, indent=2)

        registry_data = {
            "schema_version": 1,
            "main_thread_id": "test-main-id",
            "modules": {}
        }
        with open(registry_path, "w", encoding="utf-8") as f:
            json.dump(registry_data, f, indent=2)

        # 1. Test before reconcile -> should be RECONCILE
        pre = test_registry(temp_dir, str(manifest_path), str(registry_path))
        assert pre["action"] == "RECONCILE", f"Expected RECONCILE, got {pre}"

        # 2. Reconcile
        rec = reconcile_topics(temp_dir, str(manifest_path), str(registry_path))
        assert rec["action"] == "RECONCILED", f"Expected RECONCILED, got {rec}"
        assert len(rec["provisioned"]) == 1

        # 3. Test after reconcile -> should be NOOP
        post = test_registry(temp_dir, str(manifest_path), str(registry_path))
        assert post["action"] == "NOOP", f"Expected NOOP, got {post}"

        print("Python Topic Reconcile Test PASSED!")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    test_topic_lifecycle()
