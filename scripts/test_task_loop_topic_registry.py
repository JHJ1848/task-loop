#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test Task Loop Topic Registry Preflight
Validates whether declared topics match sessions.json registry.
"""

import sys
import json
import argparse
from pathlib import Path


def test_registry(project_root: str, manifest_path: str, registry_path: str) -> dict:
    root = Path(project_root).resolve()
    manifest_file = Path(manifest_path) if Path(manifest_path).is_absolute() else root / manifest_path
    registry_file = Path(registry_path) if Path(registry_path).is_absolute() else root / registry_path

    if not manifest_file.is_file():
        return {"action": "INVALID", "reason": f"Manifest file not found: {manifest_file}"}
    if not registry_file.is_file():
        return {"action": "INVALID", "reason": f"Registry file not found: {registry_file}"}

    try:
        with open(manifest_file, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        with open(registry_file, "r", encoding="utf-8") as f:
            registry = json.load(f)
    except Exception as e:
        return {"action": "INVALID", "reason": f"JSON parse error: {e}"}

    modules = registry.get("modules", {})
    unregistered = []

    for topic in manifest.get("topics", []):
        if not topic or topic.get("enabled") is False:
            continue
        mod_key = topic.get("module_key")
        if not mod_key:
            continue
        reg_mod = modules.get(mod_key)
        if not reg_mod or not reg_mod.get("thread_id"):
            unregistered.append(topic)

    if unregistered:
        return {
            "action": "RECONCILE",
            "reason": "topics_unregistered",
            "unregistered_topics": unregistered
        }

    return {
        "action": "NOOP",
        "reason": "registry_matched"
    }


def main():
    parser = argparse.ArgumentParser(description="Test Topic Registry Preflight")
    parser.add_argument("--root", default=".", help="Project root")
    parser.add_argument("--manifest", required=True, help="topics.json path")
    parser.add_argument("--registry", required=True, help="sessions.json path")
    args = parser.parse_args()

    result = test_registry(args.root, args.manifest, args.registry)
    print(json.dumps(result, ensure_ascii=False))
    if result["action"] == "INVALID":
        sys.exit(2)


if __name__ == "__main__":
    main()
