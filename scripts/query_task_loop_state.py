#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[Query CLI] 快速获取 task-loop 状态机 (sessions.json / topics.json) 中指定厂商分区的 key/value

用法:
  python scripts/query_task_loop_state.py [--file sessions|topics] --vendor <v> --key <dot.path> [--workspace <dir>]
  python scripts/query_task_loop_state.py --vendor <v> --all                       # 输出整个分区
  python scripts/query_task_loop_state.py vendors                                  # 列出全部厂商分区键
  python scripts/query_task_loop_state.py migrate [--vendor <默认厂商>]            # 旧格式迁移为 v4

退出码: 0 命中; 1 未命中/参数错误。输出恒为该 key 的 JSON 值。
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import task_loop_state as store  # noqa: E402


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)

    def opt(name):
        if name in args:
            i = args.index(name)
            if i + 1 < len(args):
                return args[i + 1]
        return None

    ws_root = Path(opt("--workspace") or os.getcwd()).resolve()
    sessions_file = str(ws_root / ".agents" / "task-loop" / "sessions.json")
    topics_file = str(ws_root / ".agents" / "task-loop" / "topics.json")

    if args and args[0] == "vendors":
        kind_file = topics_file if opt("--file") == "topics" else sessions_file
        raw = store.read_json(kind_file)
        if not raw:
            print("[]")
            return 0
        if raw.get("schema_version") == 4:
            keys = list(raw.get("vendors", {}).keys())
        elif isinstance(raw.get("vendors"), dict):
            keys = list(raw["vendors"].keys())
        else:
            keys = [raw.get("current_vendor") or "antigravity"]
        print(json.dumps(keys, ensure_ascii=False, indent=2))
        return 0

    if args and args[0] == "migrate":
        is_topics = opt("--file") == "topics"
        file = topics_file if is_topics else sessions_file
        vendor = store.normalize_vendor(opt("--vendor")) or store.detect_vendor() or "antigravity"
        doc = store.write_partition(file, vendor, {}, {"kind": "topics" if is_topics else "sessions"})
        print(json.dumps({
            "migrated": True,
            "schema_version": doc["schema_version"],
            "file": file,
            "vendors": list(doc["vendors"].keys()),
        }, ensure_ascii=False, indent=2))
        return 0

    vendor = opt("--vendor") or store.detect_vendor()
    key = opt("--key")
    show_all = "--all" in args
    is_topics = opt("--file") == "topics"

    if not vendor or (not key and not show_all):
        print("用法: query_task_loop_state [--file sessions|topics] --vendor <v> (--key <dot.path> | --all) | vendors | migrate", file=sys.stderr)
        return 1

    file = topics_file if is_topics else sessions_file
    partition = store.get_partition(file, vendor)
    if not partition:
        print(f"未找到厂商分区: {vendor} ({file})", file=sys.stderr)
        return 1

    if show_all:
        print(json.dumps(partition, ensure_ascii=False, indent=2))
        return 0

    value = store.get_dot_path(partition, key)
    if value is None:
        print(f"key 未命中: {key} (vendor={vendor})", file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    sys.exit(main())
