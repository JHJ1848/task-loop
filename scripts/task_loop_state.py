#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[State Store] task-loop 状态机厂商分区存储 (Schema v4)

存储形态: sessions.json / topics.json 顶层即为厂商分区, 动态扩展, 各工具只读写自身厂商分区,
结构上杜绝跨厂商覆写。兼容读取顺序: v4 vendors[v] -> v3 vendors[v] -> v3 顶层(当前厂商) -> v2 顶层。
首次写分区时自动把旧格式整体迁移为 v4, 其余厂商分区不受影响。
"""

import json
import os
from datetime import datetime, timezone

SCHEMA_VERSION = 4

VENDOR_ALIASES = {
    "agy": "antigravity",
    "antigravity": "antigravity",
    "zcode": "zcode",
    "z-code": "zcode",
    "codex": "codex",
    "claude": "claude",
    "claude-code": "claude",
    "claudecode": "claude",
}


def detect_vendor(env=None):
    env = env if env is not None else os.environ
    if env.get("ANTIGRAVITY_CONVERSATION_ID"):
        return "antigravity"
    if env.get("ZCODE_SESSION_ID") or env.get("CLAUDE_SESSION_ID"):
        return "zcode"
    if env.get("CODEX_THREAD_ID") or env.get("CODEX_SESSION_ID"):
        return "codex"
    return None


def normalize_vendor(name):
    if not name:
        return None
    key = str(name).strip().lower()
    if key in VENDOR_ALIASES:
        return VENDOR_ALIASES[key]
    import re
    if re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", key):
        return key
    return None


def empty_partition(vendor):
    return {"vendor": vendor, "main_thread_id": None, "updated_at": None, "modules": {}, "sessions": []}


def empty_topics_partition(vendor):
    return {"vendor": vendor, "updated_at": None, "topics": []}


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(file):
    try:
        with open(file, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def get_dot_path(obj, dot_path):
    if not obj or not dot_path:
        return None
    cur = obj
    for k in dot_path.split("."):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            try:
                cur = cur[int(k)]
            except (ValueError, TypeError, IndexError):
                return None
    return cur


def migrate_to_v4(raw, kind, default_vendor):
    if not isinstance(raw, dict):
        return {"schema_version": SCHEMA_VERSION, "updated_at": now_iso(), "vendors": {}}
    if raw.get("schema_version") == SCHEMA_VERSION and isinstance(raw.get("vendors"), dict):
        return raw

    vendors = {}
    src = raw.get("vendors")
    if isinstance(src, dict):
        for v, part in src.items():
            if isinstance(part, dict):
                merged = {"vendor": v}
                merged.update(part)
                vendors[v] = merged

    target = normalize_vendor(raw.get("current_vendor")) or normalize_vendor(default_vendor) or "antigravity"
    has_any_partition = len(vendors) > 0

    sessions = raw.get("sessions")
    modules = raw.get("modules")
    topics = raw.get("topics")
    top_has_content = (
        (isinstance(sessions, list) and len(sessions) > 0)
        or (isinstance(modules, dict) and len(modules) > 0)
        or (isinstance(topics, list) and len(topics) > 0)
    )

    if top_has_content or not has_any_partition:
        if target not in vendors:
            vendors[target] = empty_topics_partition(target) if kind == "topics" else empty_partition(target)
        part = vendors[target]
        if kind == "topics":
            if not part.get("topics") and isinstance(topics, list):
                part["topics"] = topics
        else:
            if not part.get("main_thread_id") and raw.get("main_thread_id"):
                part["main_thread_id"] = raw["main_thread_id"]
            if not part.get("modules") and isinstance(modules, dict):
                part["modules"] = modules
            if not part.get("sessions") and isinstance(sessions, list):
                part["sessions"] = sessions

    return {"schema_version": SCHEMA_VERSION, "updated_at": now_iso(), "vendors": vendors}


def get_partition(file, vendor, options=None):
    """读取某厂商分区 (跨版本兼容, 只读不回写)。不存在返回 None。"""
    options = options or {}
    v = normalize_vendor(vendor) or detect_vendor()
    if not v:
        return None
    raw = read_json(file)
    if not raw:
        return None

    if raw.get("schema_version") == SCHEMA_VERSION and isinstance(raw.get("vendors"), dict):
        return raw["vendors"].get(v)

    src = raw.get("vendors")
    if isinstance(src, dict) and isinstance(src.get(v), dict):
        return src[v]

    current = normalize_vendor(raw.get("current_vendor")) or detect_vendor() or "antigravity"
    if v == current or v == normalize_vendor(options.get("defaultVendor")):
        part = empty_partition(v)
        has = False
        if raw.get("main_thread_id"):
            part["main_thread_id"] = raw["main_thread_id"]
            has = True
        if isinstance(raw.get("modules"), dict) and raw["modules"]:
            part["modules"] = raw["modules"]
            has = True
        if isinstance(raw.get("sessions"), list) and raw["sessions"]:
            part["sessions"] = raw["sessions"]
            has = True
        if isinstance(raw.get("topics"), list) and raw["topics"]:
            part["topics"] = raw["topics"]
            has = True
        return part if has else None
    return None


def write_partition(file, vendor, partition_data, options=None):
    """写入某厂商分区 (读-改-写, 只动自身分区)。旧格式写入前整体迁移为 v4。返回完整 v4 文档。"""
    options = options or {}
    v = normalize_vendor(vendor) or detect_vendor()
    if not v:
        raise ValueError("vendor 无法判定: 请显式传入 vendor 或设置宿主环境变量")

    kind = options.get("kind")
    doc = migrate_to_v4(read_json(file), "topics" if kind == "topics" else "sessions", v)

    base = doc["vendors"].get(v) or (empty_topics_partition(v) if kind == "topics" else empty_partition(v))
    part = dict(base)
    part.update(partition_data or {})
    part["vendor"] = v
    part["updated_at"] = now_iso()
    doc["vendors"][v] = part
    doc["updated_at"] = now_iso()

    os.makedirs(os.path.dirname(os.path.abspath(file)), exist_ok=True)
    with open(file, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return doc
