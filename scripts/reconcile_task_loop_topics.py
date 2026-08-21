#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Reconcile Task Loop Topics
Auto-provisions topic thread sessions for enabled topics declared in topics.json.
"""

import sys
import json
import uuid
import argparse
from pathlib import Path
from datetime import datetime, timezone


def reconcile_topics(project_root: str, manifest_path: str, registry_path: str) -> dict:
    root = Path(project_root).resolve()
    manifest_file = Path(manifest_path) if Path(manifest_path).is_absolute() else root / manifest_path
    registry_file = Path(registry_path) if Path(registry_path).is_absolute() else root / registry_path

    if not manifest_file.is_file():
        return {"action": "INVALID", "reason": f"Manifest file not found: {manifest_file}"}
    if not registry_file.is_file():
        return {"action": "INVALID", "reason": f"Registry file not found: {registry_file}"}

    with open(manifest_file, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    with open(registry_file, "r", encoding="utf-8") as f:
        registry = json.load(f)

    if "modules" not in registry:
        registry["modules"] = {}

    provisioned = []
    modified = False

    for topic in manifest.get("topics", []):
        if not topic or (topic.get("enabled") is False):
            continue

        mod_key = topic.get("module_key")
        if not mod_key:
            continue

        reg_mod = registry["modules"].get(mod_key)
        if not reg_mod or not reg_mod.get("thread_id"):
            new_thread_id = str(uuid.uuid4())
            registry["modules"][mod_key] = {
                "thread_id": new_thread_id,
                "title": topic.get("title", f"Topic {mod_key}"),
                "title_prefix": topic.get("title_prefix", f"{mod_key}-"),
                "memory_docs": topic.get("memory_docs", []),
                "auto_provisioned": True,
                "provisioned_at": datetime.now(timezone.utc).isoformat()
            }
            provisioned.append({
                "module_key": mod_key,
                "thread_id": new_thread_id,
                "title": topic.get("title")
            })
            modified = True

    if modified:
        with open(registry_file, "w", encoding="utf-8") as f:
            json.dump(registry, f, ensure_ascii=False, indent=2)
        return {
            "action": "RECONCILED",
            "reason": "topics_provisioned",
            "provisioned": provisioned
        }
    else:
        return {
            "action": "NOOP",
            "reason": "all_topics_registered"
        }


def main():
    parser = argparse.ArgumentParser(description="Reconcile Task Loop Topics")
    parser.add_argument("--root", default=".", help="Project root")
    parser.add_argument("--manifest", required=True, help="topics.json path")
    parser.add_argument("--registry", required=True, help="sessions.json path")
    args = parser.parse_args()

    result = reconcile_topics(args.root, args.manifest, args.registry)
    print(json.dumps(result, ensure_ascii=False))
    if result["action"] == "INVALID":
        sys.exit(2)


if __name__ == "__main__":
    main()
