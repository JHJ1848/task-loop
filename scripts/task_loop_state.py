#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[State Store] task-loop 状态机厂商分区存储 (Schema v5)

存储形态: sessions.json / topics.json 顶层即为厂商分区, 动态扩展, 各工具只读写自身厂商分区,
结构上杜绝跨厂商覆写:

  {
    "schema_version": 5,
    "revision": 1,
    "updated_at": "ISO",
    "vendors": {
      "zcode":       { "vendor": "zcode", "main_thread_id": "...", "updated_at": "...", "modules": {...}, "sessions": [...] },
      "antigravity": { ... }, "codex": { ... }, "claude": { ... }
    }
  }

topics.json 同构, 分区内为 { vendor, updated_at, topics: [...] }。

特性支持:
1. 事实源驱动: 从 contracts/ 读取 vendor-aliases, capabilities, error-codes;
2. 乐观并发控制 (OCC): write_partition 支持 expected_revision 校验, 冲突时抛出 TL_STATE_REVISION_CONFLICT;
3. 强原子写入: 写入同目录临时文件后通过 os.replace 原子替换;
4. 兼容读取顺序: v5 vendors[v] -> v4 vendors[v] -> v3 vendors[v] -> v3 顶层 -> v2 顶层。
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 5


def _load_json_contract(rel_path, fallback):
    script_dir = Path(__file__).resolve().parent
    roots = [script_dir.parent, Path.cwd()]
    for r in roots:
        p = r / rel_path
        if p.exists():
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    return json.load(fh)
            except Exception:
                pass
    return fallback


DEFAULT_VENDOR_ALIASES = {
    "agy": "antigravity",
    "antigravity": "antigravity",
    "zcode": "zcode",
    "z-code": "zcode",
    "codex": "codex",
    "claude": "claude",
    "claude-code": "claude",
    "claudecode": "claude",
}

_aliases_contract = _load_json_contract("contracts/vendor-aliases.json", {"aliases": DEFAULT_VENDOR_ALIASES})
VENDOR_ALIASES = dict(DEFAULT_VENDOR_ALIASES)
if isinstance(_aliases_contract, dict) and "aliases" in _aliases_contract:
    VENDOR_ALIASES.update(_aliases_contract["aliases"])

DEFAULT_ERROR_CODES = {
    "TL_STATE_INVALID_JSON": "状态文件 JSON 格式损坏无法解析",
    "TL_STATE_INVALID_SCHEMA": "状态文件 Schema 校验未通过",
    "TL_STATE_REVISION_CONFLICT": "状态文件写入乐观锁版本冲突 (Revision Conflict)",
    "TL_STATE_FILE_NOT_FOUND": "状态文件不存在",
    "TL_VENDOR_UNSUPPORTED": "不支持的目标宿主厂商",
    "TL_VENDOR_UNAUTHENTICATED": "宿主厂商尚未完成前置登录认证",
    "TL_SESSION_NOT_FOUND": "目标专题物理会话不存在",
    "TL_SESSION_CREATION_FAILED": "物理会话拉起执行失败",
    "TL_SESSION_PENDING_HOST": "会话依赖外部宿主手工拉起 (Pending Creation)",
    "TL_SECURITY_ALLOWLIST_VIOLATION": "PreToolUse 物理白名单拦截拒绝",
    "TL_PROVIDER_CLI_MISSING": "宿主 Provider CLI 二进制缺失",
    "TL_DISPATCH_TIMEOUT": "派单监控超时未激活",
    "TL_VENDOR_AMBIGUOUS": "宿主厂商环境变量或上下文存在冲突歧义无法自动裁决",
}
ERROR_CODES = dict(DEFAULT_ERROR_CODES)
_err_contract = _load_json_contract("contracts/error-codes.json", {})
if isinstance(_err_contract, dict):
    ERROR_CODES.update(_err_contract)

CAPABILITIES = _load_json_contract("contracts/capabilities.json", {"matrix": {}})

SESSION_STATUS = {
    "DISCOVERED": "DISCOVERED",
    "BOUND": "BOUND",
    "PENDING_CREATION": "PENDING_CREATION",
    "CREATION_FAILED": "CREATION_FAILED",
    "UNSUPPORTED": "UNSUPPORTED",
}


class RevisionConflictError(RuntimeError):
    def __init__(self, message="StateStore revision conflict"):
        super().__init__(message)
        self.code = "TL_STATE_REVISION_CONFLICT"


class VendorAmbiguousError(RuntimeError):
    def __init__(self, message="Ambiguous vendor environment: multiple vendors detected"):
        super().__init__(message)
        self.code = "TL_VENDOR_AMBIGUOUS"


def detect_vendor(env=None, options=None):
    env = env if env is not None else os.environ
    options = options or {}
    if options.get("strict"):
        detected = []
        if env.get("CODEX_THREAD_ID") or env.get("CODEX_SESSION_ID"):
            detected.append("codex")
        if env.get("ZCODE_SESSION_ID"):
            detected.append("zcode")
        if env.get("ANTIGRAVITY_CONVERSATION_ID"):
            detected.append("antigravity")
        if env.get("CLAUDE_CONVERSATION_ID") or env.get("CLAUDE_SESSION_ID") or env.get("CLAUDE_CODE_SESSION_ID"):
            detected.append("claude")
        if len(detected) > 1:
            raise VendorAmbiguousError(f"Ambiguous vendor environment: multiple vendors detected {detected}")
        return detected[0] if detected else None

    if env.get("CODEX_THREAD_ID") or env.get("CODEX_SESSION_ID"):
        return "codex"
    if env.get("ZCODE_SESSION_ID"):
        return "zcode"
    if env.get("ANTIGRAVITY_CONVERSATION_ID"):
        return "antigravity"
    if env.get("CLAUDE_CONVERSATION_ID") or env.get("CLAUDE_SESSION_ID") or env.get("CLAUDE_CODE_SESSION_ID"):
        return "claude"
    return None


def find_registered_vendor_by_session_id(session_id, project_root=None):
    if not session_id:
        return None
    root = Path(project_root) if project_root else Path(__file__).resolve().parent.parent
    candidates = [
        root / ".agents" / "task-loop" / "sessions.json",
        root / ".agents" / "task-loop" / "topics.json",
    ]
    for c in candidates:
        raw = read_json(c)
        if not isinstance(raw, dict):
            continue
        vendors = raw.get("vendors")
        if not isinstance(vendors, dict):
            continue
        for vendor, part in vendors.items():
            if not isinstance(part, dict):
                continue
            if part.get("main_thread_id") == session_id:
                return normalize_vendor(vendor)
            modules = part.get("modules")
            if isinstance(modules, dict):
                for m in modules.values():
                    if isinstance(m, dict) and (m.get("session_id") == session_id or m.get("sessionId") == session_id):
                        return normalize_vendor(vendor)
            sessions = part.get("sessions")
            if isinstance(sessions, list):
                for s in sessions:
                    if isinstance(s, dict) and (s.get("session_id") == session_id or s.get("id") == session_id or s.get("sessionId") == session_id):
                        return normalize_vendor(vendor)
            topics = part.get("topics")
            if isinstance(topics, list):
                for t in topics:
                    if isinstance(t, dict) and (t.get("session_id") == session_id or t.get("id") == session_id):
                        return normalize_vendor(vendor)
    return None


def resolve_vendor(input_data=None, options=None):
    """
    Vendor Resolution Policy (五级优先级解析):
    1. explicit vendor: 显式传入 vendor 参数
    2. explicit session payload: 会话/任务负载中声明的 vendor
    3. registered session identity: 通过 sessionId 从 sessions.json/topics.json 反查
    4. runtime-native environment: 环境变量判定 (若冲突且无法裁决统一返回/抛出 TL_VENDOR_AMBIGUOUS)
    5. UNKNOWN: 无法判定时回退到 UNKNOWN
    """
    options = options or {}
    explicit_vendor = None
    session_payload = None
    session_id = None
    env = None
    project_root = None

    if isinstance(input_data, str):
        explicit_vendor = input_data
    elif isinstance(input_data, dict):
        explicit_vendor = input_data.get("vendor")
        session_payload = input_data.get("session") or input_data.get("payload")
        session_id = input_data.get("sessionId") or input_data.get("session_id")
        if not session_id and isinstance(session_payload, dict):
            session_id = session_payload.get("session_id") or session_payload.get("id")
        env = input_data.get("env")
        project_root = input_data.get("projectRoot") or input_data.get("project_root")

    # 1. Explicit vendor
    if explicit_vendor:
        v = normalize_vendor(explicit_vendor)
        if v:
            return {"vendor": v, "precedence": 1, "matched_by": "explicit_vendor"}

    # 2. Explicit session payload
    if isinstance(session_payload, dict) and session_payload.get("vendor"):
        v = normalize_vendor(session_payload.get("vendor"))
        if v:
            return {"vendor": v, "precedence": 2, "matched_by": "explicit_session_payload"}

    # 3. Registered session identity
    if session_id:
        registered = find_registered_vendor_by_session_id(session_id, project_root)
        if registered:
            return {"vendor": registered, "precedence": 3, "matched_by": "registered_session_identity"}

    # 4. Runtime-native environment
    runtime_env = env if env is not None else (options.get("env") if options.get("env") is not None else os.environ)
    detected = []
    if runtime_env.get("CODEX_THREAD_ID") or runtime_env.get("CODEX_SESSION_ID"):
        detected.append("codex")
    if runtime_env.get("ZCODE_SESSION_ID"):
        detected.append("zcode")
    if runtime_env.get("ANTIGRAVITY_CONVERSATION_ID"):
        detected.append("antigravity")
    if runtime_env.get("CLAUDE_CONVERSATION_ID") or runtime_env.get("CLAUDE_SESSION_ID") or runtime_env.get("CLAUDE_CODE_SESSION_ID"):
        detected.append("claude")

    if len(detected) > 1:
        should_throw = options.get("throws", True)
        msg = f"Vendor resolution ambiguous: multiple runtime environments detected {detected}"
        if should_throw:
            raise VendorAmbiguousError(msg)
        return {
            "vendor": "UNKNOWN",
            "precedence": 4,
            "matched_by": "runtime_environment_ambiguous",
            "error": "TL_VENDOR_AMBIGUOUS",
            "message": msg,
        }

    if len(detected) == 1:
        return {"vendor": detected[0], "precedence": 4, "matched_by": "runtime_environment"}

    # 5. UNKNOWN
    return {"vendor": "UNKNOWN", "precedence": 5, "matched_by": "UNKNOWN"}


def normalize_vendor(name):
    if not name:
        return None
    key = str(name).strip().lower()
    if key in VENDOR_ALIASES:
        return VENDOR_ALIASES[key]
    if re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", key):
        return key
    return None


def capabilities_supports(vendor, capability):
    v = normalize_vendor(vendor)
    if not v or not isinstance(CAPABILITIES, dict):
        return False
    matrix = CAPABILITIES.get("matrix", {})
    if not isinstance(matrix, dict) or v not in matrix:
        return False
    return bool(matrix[v].get(capability))


def get_current_session_id(env=None, vendor=None):
    env = env if env is not None else os.environ
    current_vendor = normalize_vendor(vendor) or detect_vendor(env)
    if current_vendor == "codex":
        return env.get("CODEX_THREAD_ID") or env.get("CODEX_SESSION_ID")
    if current_vendor == "claude":
        return env.get("CLAUDE_CODE_SESSION_ID") or env.get("CLAUDE_CONVERSATION_ID") or env.get("CLAUDE_SESSION_ID")
    if current_vendor == "zcode":
        return env.get("ZCODE_SESSION_ID") or env.get("CLAUDE_SESSION_ID") or env.get("CLAUDE_CODE_SESSION_ID")
    if current_vendor == "antigravity":
        return env.get("ANTIGRAVITY_CONVERSATION_ID")
    return None


def session_identity(vendor, session_id):
    normalized_vendor = normalize_vendor(vendor)
    normalized_id = "" if session_id is None else str(session_id).strip()
    if not normalized_vendor or not normalized_id:
        return None
    return f"{normalized_vendor}:{normalized_id}"


def empty_partition(vendor):
    return {"vendor": vendor, "main_thread_id": None, "updated_at": None, "modules": {}, "sessions": []}


def empty_topics_partition(vendor):
    return {"vendor": vendor, "updated_at": None, "topics": []}


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(file):
    for i in range(5):
        try:
            if not os.path.exists(file):
                return None
            with open(file, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (PermissionError, OSError, json.JSONDecodeError):
            if i == 4:
                return None
            time.sleep(0.005)
    return None


def validate_state_document(doc, kind=None):
    if not doc or not isinstance(doc, dict):
        return {"valid": False, "code": "TL_STATE_INVALID_SCHEMA", "reason": "根节点必须为字典对象"}
    if not isinstance(doc.get("schema_version"), int):
        return {"valid": False, "code": "TL_STATE_INVALID_SCHEMA", "reason": "缺少 schema_version 整数字段"}
    if doc.get("schema_version") >= 4 and not isinstance(doc.get("vendors"), dict):
        return {"valid": False, "code": "TL_STATE_INVALID_SCHEMA", "reason": "v4+ 格式必须包含 vendors 分区对象"}
    return {"valid": True, "code": None}


def atomic_write_json(file_path, data):
    dir_name = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(dir_name, exist_ok=True)
    tmp_path = os.path.join(dir_name, f".{os.path.basename(file_path)}.{uuid.uuid4().hex}.tmp")
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            fh.write(content)
        for i in range(10):
            try:
                os.replace(tmp_path, file_path)
                break
            except (PermissionError, OSError):
                if i == 9:
                    raise
                time.sleep(0.005 + random.uniform(0.002, 0.008))
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        raise


def get_dot_path(obj, dot_path):
    if not obj or not dot_path:
        return None
    cur = obj
    for part in dot_path.split("."):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list):
            try:
                idx = int(part)
                cur = cur[idx] if 0 <= idx < len(cur) else None
            except ValueError:
                return None
        else:
            return None
    return cur


def migrate_to_v5(raw, kind="sessions", default_vendor="antigravity"):
    if not raw or not isinstance(raw, dict):
        return {"schema_version": SCHEMA_VERSION, "revision": 1, "updated_at": now_iso(), "vendors": {}}

    if raw.get("schema_version") == SCHEMA_VERSION and isinstance(raw.get("vendors"), dict):
        if not isinstance(raw.get("revision"), int) or raw["revision"] < 1:
            raw["revision"] = 1
        return raw

    vendors = {}
    src_vendors = raw.get("vendors") if isinstance(raw.get("vendors"), dict) else {}
    for v, part in src_vendors.items():
        if isinstance(part, dict):
            item = dict(part)
            item["vendor"] = v
            vendors[v] = item

    target = normalize_vendor(raw.get("current_vendor")) or normalize_vendor(default_vendor) or "antigravity"
    has_any_partition = len(vendors) > 0
    top_level_has_content = (
        (isinstance(raw.get("sessions"), list) and len(raw["sessions"]) > 0)
        or (isinstance(raw.get("modules"), dict) and len(raw["modules"]) > 0)
        or (isinstance(raw.get("topics"), list) and len(raw["topics"]) > 0)
    )

    if top_level_has_content or not has_any_partition:
        if target not in vendors:
            vendors[target] = empty_topics_partition(target) if kind == "topics" else empty_partition(target)
        part = vendors[target]
        if kind == "topics":
            if (not isinstance(part.get("topics"), list) or len(part["topics"]) == 0) and isinstance(raw.get("topics"), list):
                part["topics"] = raw["topics"]
        else:
            if not part.get("main_thread_id") and raw.get("main_thread_id"):
                part["main_thread_id"] = raw["main_thread_id"]
            if (not part.get("modules") or len(part["modules"]) == 0) and isinstance(raw.get("modules"), dict):
                part["modules"] = raw["modules"]
            if (not isinstance(part.get("sessions"), list) or len(part["sessions"]) == 0) and isinstance(raw.get("sessions"), list):
                part["sessions"] = raw["sessions"]

    revision = raw.get("revision") if isinstance(raw.get("revision"), int) and raw["revision"] >= 1 else 1
    return {"schema_version": SCHEMA_VERSION, "revision": revision, "updated_at": now_iso(), "vendors": vendors}


def migrate_to_v4(raw, kind="sessions", default_vendor="antigravity"):
    return migrate_to_v5(raw, kind, default_vendor)


def get_partition(file, vendor, options=None):
    options = options or {}
    v = normalize_vendor(vendor) or detect_vendor()
    if not v:
        return None
    raw = read_json(file)
    if not raw:
        return None

    # v5 或 v4 具有 vendors
    if (raw.get("schema_version") == 5 or raw.get("schema_version") == 4) and isinstance(raw.get("vendors"), dict):
        return raw["vendors"].get(v)

    # v3
    if isinstance(raw.get("vendors"), dict) and v in raw["vendors"]:
        return raw["vendors"][v]

    # v3 顶层 (当前厂商) / v2 顶层
    current = normalize_vendor(raw.get("current_vendor")) or detect_vendor() or "antigravity"
    if v == current or v == normalize_vendor(options.get("default_vendor") or options.get("defaultVendor")):
        part = empty_partition(v)
        has = False
        if raw.get("main_thread_id"):
            part["main_thread_id"] = raw["main_thread_id"]
            has = True
        if raw.get("modules"):
            part["modules"] = raw["modules"]
            has = True
        if isinstance(raw.get("sessions"), list) and len(raw["sessions"]):
            part["sessions"] = raw["sessions"]
            has = True
        if isinstance(raw.get("topics"), list) and len(raw["topics"]):
            part["topics"] = raw["topics"]
            has = True
        return part if has else None

    return None


def write_partition(file, vendor, partition_data, options=None):
    options = options or {}
    v = normalize_vendor(vendor) or detect_vendor()
    if not v:
        raise ValueError("vendor 无法判定: 请显式传入 vendor 或设置宿主环境变量")

    existing_raw = read_json(file)

    # 乐观锁 revision 校验
    expected_rev = options.get("expected_revision") if "expected_revision" in options else options.get("expectedRevision")
    if expected_rev is not None:
        current_rev = existing_raw.get("revision") if isinstance(existing_raw, dict) and isinstance(existing_raw.get("revision"), int) else None
        if current_rev is not None and current_rev != expected_rev:
            raise RevisionConflictError(f"StateStore revision conflict: file has revision {current_rev}, expected {expected_rev}")

    kind = options.get("kind", "sessions")
    doc = migrate_to_v5(existing_raw, kind, v)

    current_part = doc["vendors"].get(v)
    if not current_part:
        current_part = empty_topics_partition(v) if kind == "topics" else empty_partition(v)
    current_part.update(partition_data)
    current_part["vendor"] = v
    current_part["updated_at"] = now_iso()

    doc["vendors"][v] = current_part
    doc["updated_at"] = now_iso()

    # 递增 revision
    if isinstance(existing_raw, dict) and isinstance(existing_raw.get("revision"), int):
        doc["revision"] = existing_raw["revision"] + 1
    else:
        doc["revision"] = 1

    atomic_write_json(file, doc)
    return doc
