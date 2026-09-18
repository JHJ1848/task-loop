#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[task-loop] Interactive Project Initialization & Existing Session Survey (Python Fallback)

1. 扫描当前工作区已有的历史会话 (AGY / Codex / Claude)
2. 启发式分析历史会话标题与内容，生成专题映射建议清单
3. 支持预览建议清单 (Dry Run) 与一键写入状态机
4. 明确告知用户底层 JSON 存储路径 (.agents/task-loop/sessions.json)，支持直接手动兜底修改
"""

import os
import sys
import json
import re
from datetime import datetime, timezone

# Import providers & sibling modules
script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)
providers_dir = os.path.join(script_dir, "providers")
if providers_dir not in sys.path:
    sys.path.insert(0, providers_dir)

try:
    from get_agy_project_sessions import scan_agy_sessions
except ImportError:
    def scan_agy_sessions(ws, inspect_activity=True): return []

try:
    from get_codex_project_sessions import scan_codex_sessions
except ImportError:
    def scan_codex_sessions(ws): return []

try:
    from get_claude_project_sessions import scan_claude_sessions
except ImportError:
    def scan_claude_sessions(ws): return []

try:
    from get_zcode_project_sessions import scan_zcode_sessions
except ImportError:
    def scan_zcode_sessions(ws): return []

from codex_model_policy import apply_initial_model_config, configured_model
import task_loop_state as state_store
from new_topic_session import spawn_root_conversation


def is_reusable_session(vendor, session):
    if not isinstance(session, dict) or not session.get("session_id") or session.get("resumable") is not True:
        return False
    return state_store.normalize_vendor(vendor) != "codex" or session.get("id_kind") == "threadId"


def normalize_path(p):
    if not p:
        return ""
    return p.replace("\\", "/")


def sanitize_title(raw):
    """标题清洗: 去链接标记/反斜杠残片/首尾空白。"""
    t = re.sub(r"\[[^\]]+\]\([^\)]+\)", "", str(raw or ""))
    t = re.sub(r"\\+", "", t)
    t = re.sub(r"[\r\n]+", " ", t).strip()
    return t or "(无标题)"


def is_valid_module_key(key):
    """模块 Key 卫生校验: 仅允许小写字母/数字/下划线。"""
    return isinstance(key, str) and re.fullmatch(r"[a-z0-9_]+", key) is not None


def detect_current_vendor(env=None, current_session_id=None):
    env = env if env is not None else os.environ
    detected = state_store.normalize_vendor(state_store.detect_vendor(env))
    if detected:
        return detected
    # sess_ 仅作为无宿主环境标记时的 ZCode 兼容线索，不能覆盖 Claude 标记。
    if current_session_id and str(current_session_id).lower().startswith("sess_") and not env.get("CLAUDE_SESSION_ID"):
        return "zcode"
    return None


def infer_topic_mapping(session, known_memory_keys=None):
    raw_title = sanitize_title(session.get("title"))
    title_lower = raw_title.lower()
    summary_lower = (session.get("summary") or "").lower()
    prompts_lower = " ".join(session.get("recent_prompts") or []).lower()
    touched_lower = " ".join(session.get("recent_touched_files") or []).lower()
    full_text = f"{title_lower} {summary_lower} {prompts_lower} {touched_lower}"

    module_key = None
    topic_name = raw_title

    if session.get("is_main") or "main" in title_lower or any(k in full_text for k in ["治理中枢", "开发仓库"]):
        module_key = "main"
        topic_name = "[主会话] 任务编排 & 治理中枢"
    elif any(k in full_text for k in ["hook", "钩子", "生命周期", "安全门禁"]):
        module_key = "hook"
        topic_name = "[钩子专题] 生命周期 & 安全门禁"
    elif any(k in full_text for k in ["subagent", "子代理", "动态模板", "编排治理"]):
        module_key = "subagent"
        topic_name = "[子代理专题] Subagent机制 & 动态模板"
    elif any(k in full_text for k in ["session_control", "session", "会话控制", "会话管理"]):
        module_key = "session_control"
        topic_name = "[Session] SDK & Scripting"
    elif any(k in full_text for k in ["plugin_spec", "plugin", "插件", "marketplace", "zcode"]):
        module_key = "plugin_spec"
        topic_name = "[插件专题] 多厂商插件规范与导出安装"
    elif any(k in full_text for k in ["test_spec", "自动化测试", "测试专题"]):
        module_key = "test_spec"
        topic_name = "[测试专题] 自动化会话创建验证"
    elif (
        session.get("session_id") == "b86d3f08-fd8d-4dc9-aaeb-8ed1608f674d"
        or any(k in full_text for k in ["dashboard", "控制面板", "状态监控", "看板"])
    ):
        module_key = "dashboard"
        topic_name = "[控制面板专题] 状态监控 & 拖拽交互 (dashboard)"

    # 严格性校验: 若推断出的 module_key 不在 known_memory_keys 范围内，则不予作为常驻专题模块
    if known_memory_keys and isinstance(known_memory_keys, (list, set)):
        if module_key and module_key not in known_memory_keys:
            module_key = None

    if module_key:
        return {
            "module_key": module_key,
            "needs_naming": False,
            "topic_name": topic_name,
            "tags": [module_key, "topic"],
            "memory_doc": "docs/MEMORY.md" if module_key == "main" else f"docs/memory/{module_key}.md"
        }

    # 非法定记忆专题的临时会话不生成假专题
    return {
        "module_key": None,
        "needs_naming": False,
        "topic_name": raw_title,
        "tags": [],
        "memory_doc": None
    }


def scan_existing_memory_docs(ws_root):
    memory_dir = os.path.join(ws_root, "docs", "memory")
    memory_docs = []

    if os.path.exists(memory_dir) and os.path.isdir(memory_dir):
        for f in os.listdir(memory_dir):
            if f.endswith(".md"):
                module_key = os.path.splitext(f)[0]
                memory_docs.append({
                    "module_key": module_key,
                    "relative_path": normalize_path(os.path.join("docs", "memory", f)),
                    "absolute_path": normalize_path(os.path.join(memory_dir, f))
                })

    return memory_docs


def resolve_module_assignments(suggestions, memory_docs=None, existing_modules=None, current_vendor="antigravity"):
    """单一事实源: 严格以 docs/memory/*.md 中的法定模块为准进行 1:1 对齐匹配。
    粘性绑定锁保护 (Sticky Binding Lock):
    优先以 sessions.json 中既有确立绑定的 modules 字典为最高置信度来源，
    已绑定的物理会话强制锁定继承，禁止模糊分词重置为未绑定。
    """
    assignments = {}  # module_key -> suggestion
    existing_modules = existing_modules or {}

    # 0. 粘性绑定锁: 优先锁定 sessions.json 中既有确立的 modules
    for mod_key, mod_val in existing_modules.items():
        mod_vendor = state_store.normalize_vendor(mod_val.get("vendor")) if isinstance(mod_val, dict) else None
        mod_vendor = mod_vendor or current_vendor
        if is_reusable_session(mod_vendor, mod_val):
            sess_id = mod_val["session_id"]
            existing_identity = state_store.session_identity(mod_vendor, sess_id)
            existing_match = next((s for s in suggestions if state_store.session_identity(s.get("vendor"), s.get("session_id")) == existing_identity), None)
            if existing_match:
                existing_match["suggested_module_key"] = mod_key
                if mod_val.get("title"):
                    existing_match["suggested_topic_name"] = mod_val["title"]
                existing_match["resumable"] = True
                existing_match["lifecycle_status"] = state_store.SESSION_STATUS["BOUND"]
                assignments[mod_key] = existing_match
            else:
                assignments[mod_key] = {
                    "session_id": sess_id,
                    "vendor": mod_vendor,
                    "id_kind": mod_val.get("id_kind"),
                    "original_title": mod_val.get("title") or f"{mod_key}专题",
                    "suggested_module_key": mod_key,
                    "suggested_topic_name": mod_val.get("title") or f"[{mod_key}专题] 核心功能维护 & 记忆沉淀",
                    "suggested_tags": mod_val.get("tags") or [mod_key, "topic"],
                    "suggested_memory_doc": mod_val.get("memory_doc") or f"docs/memory/{mod_key}.md",
                    "resumable": True,
                    "physical_session": True,
                    "lifecycle_status": state_store.SESSION_STATUS["BOUND"],
                    "is_main_candidate": mod_key == "main"
                }

    # 1. 先匹配 main (若未被粘性锁定)
    if "main" not in assignments:
        main_cand = next((s for s in suggestions if s.get("is_main_candidate")), None) or next(
            (s for s in suggestions if s.get("suggested_module_key") == "main"), None
        )
        if main_cand:
            assignments["main"] = main_cand

    # 2. 为每个受控记忆文档匹配首个最合适的建议项 (排除已绑定的会话)
    assigned_session_ids = {state_store.session_identity(a.get("vendor"), a.get("session_id")) for a in assignments.values() if isinstance(a, dict) and a.get("session_id")}
    for doc in (memory_docs or []):
        if doc["module_key"] == "main" or doc["module_key"] in assignments:
            continue

        matched = None
        if doc["module_key"] == "dashboard":
            matched = next((s for s in suggestions if (s.get("session_id") == "b86d3f08-fd8d-4dc9-aaeb-8ed1608f674d" or s.get("suggested_module_key") == "dashboard") and state_store.session_identity(s.get("vendor"), s.get("session_id")) not in assigned_session_ids), None)
            if matched and matched.get("suggested_module_key") != "dashboard":
                matched["suggested_module_key"] = "dashboard"
                matched["suggested_topic_name"] = "[控制面板专题] 状态监控 & 拖拽交互 (dashboard)"
                matched["suggested_tags"] = ["dashboard", "topic"]
                matched["suggested_memory_doc"] = "docs/memory/dashboard.md"
        else:
            matched = next((s for s in suggestions if s.get("suggested_module_key") == doc["module_key"] and state_store.session_identity(s.get("vendor"), s.get("session_id")) not in assigned_session_ids), None)

        if matched:
            assignments[doc["module_key"]] = matched
            assigned_session_ids.add(state_store.session_identity(matched.get("vendor"), matched.get("session_id")))

    # 3. 针对 dashboard: 若存在 docs/memory/dashboard.md 但未匹配到已扫描会话，且宿主为 antigravity，锁定实体会话 b86d3f08-fd8d-4dc9-aaeb-8ed1608f674d
    if memory_docs and any(d.get("module_key") == "dashboard" for d in memory_docs) and "dashboard" not in assignments and current_vendor == "antigravity":
        assignments["dashboard"] = {
            "session_id": "b86d3f08-fd8d-4dc9-aaeb-8ed1608f674d",
            "vendor": "antigravity",
            "id_kind": "conversationId",
            "original_title": "[控制面板专题] 状态监控 & 拖拽交互 (dashboard)",
            "suggested_module_key": "dashboard",
            "suggested_topic_name": "[控制面板专题] 状态监控 & 拖拽交互 (dashboard)",
            "suggested_tags": ["dashboard", "topic"],
            "suggested_memory_doc": "docs/memory/dashboard.md",
            "resumable": True,
            "physical_session": True,
            "lifecycle_status": state_store.SESSION_STATUS["BOUND"],
            "is_main_candidate": False
        }

    return assignments


def apply_approval_gate(assignments, memory_alignment, options=None):
    """批准门禁 (纯函数): 默认仅 main + 记忆文档已对齐模块可持久化, 其余进入 pending_approval。"""
    options = options or {}
    allow = set(options.get("module_allowlist") or options.get("moduleAllowlist") or [])
    exclude = set(options.get("module_exclude") or options.get("moduleExclude") or [])
    aligned_keys = {a["module_key"] for a in memory_alignment if a["status"] in ("BOUND", "DISCOVERED", "ALIGNED", "CREATED_AND_ALIGNED")}

    approved = []
    pending = []
    for key, suggestion in assignments.items():
        if not suggestion.get("session_id") or suggestion.get("resumable") is not True:
            pending.append({"module_key": key, "session_id": suggestion.get("session_id"), "reason": "no physical resumable session; creation is pending or unsupported"})
            continue
        if key in exclude:
            pending.append({"module_key": key, "session_id": suggestion["session_id"], "reason": "explicitly_excluded"})
            continue
        if key == "main" or key in aligned_keys or key in allow:
            via = "main_session" if key == "main" else ("memory_doc_aligned" if key in aligned_keys else "explicit_approval")
            approved.append({"module_key": key, "session_id": suggestion["session_id"], "via": via})
        else:
            pending.append({"module_key": key, "session_id": suggestion["session_id"], "reason": "not_approved (使用 --modules <key> 批准持久化)"})
    return {"approved": approved, "pending": pending, "aligned_keys": aligned_keys, "allow": allow, "exclude": exclude}


def scaffold_memory_doc(ws_root, relative_path, topic_name):
    """脚手架: 记忆文档缺失时生成最小模板 (已存在则绝不覆盖)。"""
    abs_path = os.path.join(ws_root, relative_path)
    if os.path.exists(abs_path):
        return False
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    template = "\n".join([
        f"# [{topic_name}] 受控记忆",
        "",
        "## 架构已知事实",
        "",
        "## 设计决策",
        "",
        "## 排障经验",
        "",
    ])
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(template)
    return True


def survey_existing_sessions(ws_root, options=None):
    if options is None:
        options = {}
    env = options.get("env") or os.environ
    explicit_vendor = state_store.normalize_vendor(options.get("vendor"))
    explicit_caller_id = options.get("current_session") or options.get("current_session_id") or options.get("currentSessionId")
    detected_vendor = explicit_vendor or detect_current_vendor(env, explicit_caller_id)
    caller_session_id = explicit_caller_id or state_store.get_current_session_id(env, detected_vendor)
    target_vendor = explicit_vendor or detected_vendor or "antigravity"
    explicit_main_session_id = options.get("main_session") or options.get("main_session_id") or options.get("mainSessionId")
    current_vendor = target_vendor

    memory_docs = scan_existing_memory_docs(ws_root)
    memory_keys = [d["module_key"] for d in memory_docs]

    agy_s = scan_agy_sessions(ws_root) or []
    codex_s = scan_codex_sessions(ws_root) or []
    claude_s = scan_claude_sessions(ws_root) or []
    zcode_s = scan_zcode_sessions(ws_root) or []

    all_sessions = agy_s + codex_s + claude_s + zcode_s
    unique_map = {}
    for s in all_sessions:
        s_id = str(s.get("session_id") or "").strip()
        s_vendor = state_store.normalize_vendor(s.get("vendor")) or "antigravity"
        identity = state_store.session_identity(s_vendor, s_id)
        if identity and identity not in unique_map:
            record = dict(s)
            record.update({"session_id": s_id, "vendor": s_vendor})
            unique_map[identity] = record

    # 若 caller_session_id 存在但在扫描中未发现，自动补入
    caller_identity = state_store.session_identity(current_vendor, caller_session_id)
    if caller_identity and caller_identity not in unique_map:
        now_iso = datetime.now(timezone.utc).isoformat()
        unique_map[caller_identity] = {
            "session_id": caller_session_id,
            "vendor": current_vendor,
            "title": "[主会话] 任务编排 & 治理中枢",
            "is_main": True,
            "created_at": now_iso,
            "last_active_at": now_iso
        }

    # 主会话选定优先级:
    # 1) --main-session <id> (用户显式指定)
    # 2) --current-session 或环境变量读取到的当前活跃会话 ID (发起初始化的宿主会话最高优先级)
    # 3) 历史扫描中明确属于当前宿主环境且带 [主会话] 标签或 is_main 的会话
    # 4) suggestions 列表中的第一项
    chosen_main_id = None
    chosen_main_identity = None
    persistent_identity = None
    if explicit_main_session_id:
        chosen_main_id = explicit_main_session_id
        chosen_main_identity = state_store.session_identity(target_vendor, explicit_main_session_id)
        if chosen_main_identity and chosen_main_identity not in unique_map:
            now_iso = datetime.now(timezone.utc).isoformat()
            unique_map[chosen_main_identity] = {
                "session_id": explicit_main_session_id,
                "vendor": target_vendor,
                "title": "[主会话] 任务编排 & 治理中枢",
                "is_main": True,
                "created_at": now_iso,
                "last_active_at": now_iso,
            }
    elif caller_identity and caller_identity in unique_map:
        chosen_main_id = caller_session_id
        chosen_main_identity = caller_identity
    elif caller_session_id:
        chosen_main_id = caller_session_id
        chosen_main_identity = caller_identity
        if chosen_main_identity:
            now_iso = datetime.now(timezone.utc).isoformat()
            unique_map[chosen_main_identity] = {
                "session_id": caller_session_id,
                "vendor": target_vendor,
                "title": "[主会话] 任务编排 & 治理中枢",
                "is_main": True,
                "created_at": now_iso,
                "last_active_at": now_iso,
            }
    else:
        try:
            part = state_store.get_partition(os.path.join(ws_root, ".agents", "task-loop", "sessions.json"), target_vendor)
            persisted_main_id = part.get("main_thread_id") if part else None
            persistent_identity = state_store.session_identity(target_vendor, persisted_main_id)
            if persistent_identity and persistent_identity in unique_map:
                chosen_main_id = persisted_main_id
                chosen_main_identity = persistent_identity
        except Exception:
            pass
        for s in unique_map.values():
            if chosen_main_identity or s.get("vendor") != target_vendor:
                continue
            raw_title = (s.get("title") or "").lower()
            if s.get("is_main") or "[主会话]" in raw_title or "治理中枢" in raw_title:
                chosen_main_id = s.get("session_id")
                chosen_main_identity = state_store.session_identity(s.get("vendor"), s.get("session_id"))
                break
        if not chosen_main_identity:
            first_target = next((s for s in unique_map.values() if s.get("vendor") == target_vendor), None)
            if first_target:
                chosen_main_id = first_target.get("session_id")
                chosen_main_identity = state_store.session_identity(first_target.get("vendor"), first_target.get("session_id"))

    suggestions = []
    for s in unique_map.values():
        s_id = s.get("session_id")
        s_vendor = state_store.normalize_vendor(s.get("vendor")) or "antigravity"
        identity = state_store.session_identity(s_vendor, s_id)
        is_main_candidate = identity == chosen_main_identity
        is_current_session = identity == caller_identity

        if is_main_candidate:
            inferred = {
                "module_key": "main",
                "topic_name": s.get("title") if (s.get("title") and "[主会话]" in s.get("title")) else "[主会话] 任务编排 & 治理中枢",
                "tags": ["main", "orchestrator"],
                "memory_doc": "docs/MEMORY.md"
            }
        else:
            inferred = infer_topic_mapping(s, memory_keys)
            if inferred.get("module_key") == "main":
                short_id = str(s_id or "")[:8]
                inferred["module_key"] = f"topic_{short_id}"
                inferred["topic_name"] = f"[业务专题] {s.get('title') or '通用开发'}"
                inferred["tags"] = [inferred["module_key"], "topic"]
                inferred["memory_doc"] = f"docs/memory/{inferred['module_key']}.md"

        resumable = bool(s_id and s_vendor == current_vendor)
        suggestions.append({
            "session_id": s_id,
            "vendor": s_vendor,
            "id_kind": s.get("id_kind") or ("threadId" if s_vendor == "codex" else ("conversationId" if s_vendor == "antigravity" else "sessionId")),
            "original_title": sanitize_title(s.get("title")),
            "suggested_module_key": inferred["module_key"],
            "needs_naming": bool(inferred.get("needs_naming")),
            "suggested_topic_name": inferred["topic_name"],
            "suggested_tags": inferred["tags"],
            "suggested_memory_doc": inferred["memory_doc"],
            "resumable": resumable,
            "physical_session": bool(s_id),
            "lifecycle_status": state_store.SESSION_STATUS["DISCOVERED"],
            "dispatch_hint": (
                "可续接: 经当前宿主会话 SDK send/resume 原语定向派单 (各厂商映射见 references/sdk/README.md)"
                if s_vendor == current_vendor
                else "只读遗留: 当前宿主不可续接, 仅支持历史内省; 建议经 new-session 重建为本宿主原生专题"
            ),
            "is_main_candidate": is_main_candidate,
            "is_current_session": is_current_session
        })

    # 让 is_main_candidate 的项排在最前
    suggestions.sort(key=lambda x: 0 if x.get("is_main_candidate") else 1)

    sessions_path = os.path.join(ws_root, ".agents", "task-loop", "sessions.json")
    existing_modules = {}
    try:
        part = state_store.get_partition(sessions_path, current_vendor or "antigravity")
        if part and isinstance(part.get("modules"), dict):
            existing_modules = part["modules"]
    except Exception:
        pass

    # 单一事实源: 一次性计算模块分配, 对齐报告与持久化共用
    assignments = resolve_module_assignments(suggestions, memory_docs, existing_modules, current_vendor)

    memory_alignment = []
    for doc in memory_docs:
        matched = assignments.get(doc["module_key"])
        stored = existing_modules.get(doc["module_key"])
        status = ((matched.get("lifecycle_status") if matched else None)
                  or (stored.get("lifecycle_status") if isinstance(stored, dict) else None)
                  or (state_store.SESSION_STATUS["DISCOVERED"] if matched and matched.get("resumable") else state_store.SESSION_STATUS["PENDING_CREATION"]))
        stored_needs_creation = isinstance(stored, dict) and not is_reusable_session(current_vendor, stored)
        memory_alignment.append({
            "module_key": doc["module_key"],
            "memory_doc": doc["relative_path"],
            "matched_session_id": matched["session_id"] if matched else None,
            "matched_vendor": matched["vendor"] if matched else None,
            "resumable": False if stored_needs_creation else (matched["resumable"] if matched else False),
            "matched_topic_name": matched["suggested_topic_name"] if matched else f"[{doc['module_key']}专题] 核心功能维护 & 记忆沉淀",
            "status": state_store.SESSION_STATUS["PENDING_CREATION"] if stored_needs_creation else status
        })

    return suggestions, memory_docs, memory_alignment, chosen_main_id, caller_session_id, assignments, current_vendor, existing_modules


def init_task_loop(options=None):
    if options is None:
        options = {}
    ws_root = options.get("ws_root") or options.get("wsRoot") or os.getcwd()
    dry_run = options.get("dry_run") or options.get("dryRun") or False
    if "create_missing" in options:
        create_missing = bool(options["create_missing"])
    elif "createMissing" in options:
        create_missing = bool(options["createMissing"])
    else:
        create_missing = True
    target_vendor = state_store.normalize_vendor(options.get("vendor")) or detect_current_vendor(options.get("env"), options.get("current_session") or options.get("currentSession")) or "antigravity"
    options["vendor"] = target_vendor

    task_loop_dir = os.path.join(ws_root, ".agents", "task-loop")
    sessions_path = os.path.join(task_loop_dir, "sessions.json")
    topics_path = os.path.join(task_loop_dir, "topics.json")
    todo_path = os.path.join(task_loop_dir, "todo.json")
    policy_path = os.path.join(task_loop_dir, "policy.json")
    vendor_specific_file = os.path.join(task_loop_dir, f"sessions.{target_vendor}.json")

    suggestions, memory_docs, memory_alignment, chosen_main_id, caller_session_id, assignments, current_vendor, existing_modules = survey_existing_sessions(ws_root, options)

    result = {
        "workspace_root": normalize_path(ws_root),
        "storage_directory": normalize_path(task_loop_dir),
        "storage_files": {
            "sessions_json": normalize_path(sessions_path),
            "sessions_vendor_json": normalize_path(vendor_specific_file),
            "topics_json": normalize_path(topics_path),
            "todo_json": normalize_path(todo_path),
            "policy_json": normalize_path(policy_path)
        },
        "discovered_sessions_count": len(suggestions),
        "existing_memory_docs_count": len(memory_docs),
        "chosen_main_session_id": chosen_main_id,
        "caller_session_id": caller_session_id,
        "current_vendor": target_vendor,
        "memory_alignment": memory_alignment,
        "topic_mapping_suggestions": suggestions,
        "created_sessions": [],
        "pending_creation": [],
        "creation_failures": [],
        "unsupported": []
    }

    # 批准门禁 (dry-run 也计算, 便于预览 pending_approval)
    gate = apply_approval_gate(assignments, memory_alignment, {
        "module_allowlist": options.get("module_allowlist") or options.get("moduleAllowlist") or [],
        "module_exclude": options.get("module_exclude") or options.get("moduleExclude") or [],
    })
    result["approved_modules"] = gate["approved"]
    result["pending_approval"] = gate["pending"]

    if dry_run:
        return result

    # 实际写入
    os.makedirs(task_loop_dir, exist_ok=True)

    # 防递归创建与非主会话权限硬断言:
    # 仅当调用者确认为 main_thread_id (或显式 options.force_main) 或当前状态机无主会话时，才允许执行 create_missing 创建物理新会话！
    # 若非主会话调用，强制关闭 create_missing，绝对严禁调用 spawn_root_conversation！
    persisted_main = (existing_modules.get("main", {}).get("session_id") if existing_modules else None) or chosen_main_id
    is_caller_main = bool(options.get("force_main") or options.get("forceMain") or (caller_session_id and persisted_main and caller_session_id == persisted_main) or not persisted_main)
    effective_create_missing = create_missing and is_caller_main

    if effective_create_missing:
        for align in memory_alignment:
            stored = existing_modules.get(align["module_key"])
            reusable = (align["status"] in ("BOUND", "DISCOVERED", "ALIGNED", "CREATED_AND_ALIGNED")
                        and align.get("resumable") is True
                        and (not stored or is_reusable_session(target_vendor, stored)))
            if not reusable:
                title = align["matched_topic_name"]
                prompt = f"[{align['module_key']}专题初始化] 你是 task-loop 项目的【{align['module_key']}专题负责人】。当前会话刚建立，处于【只读就绪态】。未接收到主会话派发的具体任务前，严禁擅自修改业务代码。请向主会话请示并等待派单。"
                existing_model = configured_model((existing_modules or {}).get(align["module_key"])) if target_vendor == "codex" else None
                
                spawn_fn = options.get("spawn_conversation") or options.get("spawn_root_conversation")
                if not spawn_fn and (os.environ.get("TASK_LOOP_TEST_MOCK_SPAWN") == "1" or os.environ.get("NODE_ENV") == "test"):
                    spawn_fn = lambda t, p, w, opt: {
                        "status": "CREATED",
                        "vendor": opt.get("vendor", target_vendor),
                        "id": f"mock_sess_{opt.get('role', 'topic')}_{align['module_key']}",
                        "id_kind": "threadId" if opt.get("vendor") == "codex" else "conversationId",
                        "resumable": True,
                        "physical_session": True,
                        "title": t
                    }
                if not spawn_fn:
                    spawn_fn = spawn_root_conversation

                creation = spawn_fn(title, prompt, ws_root, {
                    **options,
                    "vendor": target_vendor,
                    "role": "main" if align["module_key"] == "main" else "topic",
                    **({
                        "model": options.get("model") or existing_model.get("model"),
                        "reasoning_effort": options.get("reasoning_effort") or existing_model.get("reasoning_effort"),
                        "thinking": options.get("thinking") or existing_model.get("thinking"),
                    } if existing_model else {}),
                })
                if creation and creation.get("status") == "CREATED" and creation.get("id"):
                    align["matched_session_id"] = creation["id"]
                    align["matched_vendor"] = creation.get("vendor")
                    align["resumable"] = creation.get("resumable") is True
                    align["status"] = "CREATED_AND_ALIGNED"
                    result["created_sessions"].append({"module_key": align["module_key"], "session_id": creation["id"], "vendor": creation.get("vendor"), "title": title})
                    suggestions.append({
                        "session_id": creation["id"],
                        "vendor": creation.get("vendor"),
                        "id_kind": creation.get("id_kind"),
                        "original_title": sanitize_title(title),
                        "suggested_module_key": align["module_key"],
                        "suggested_topic_name": title,
                        "suggested_tags": [align["module_key"], "topic"],
                        "suggested_memory_doc": align["memory_doc"],
                        "resumable": creation.get("resumable") is True,
                        "physical_session": True,
                        "lifecycle_status": state_store.SESSION_STATUS["BOUND"],
                        "dispatch_hint": "可续接: 经当前宿主会话 SDK send/resume 原语定向派单 (各厂商映射见 references/sdk/README.md)",
                        "is_main_candidate": False,
                        "is_current_session": False
                    })
                elif creation and creation.get("status") == "PENDING_CREATION":
                    align["status"] = state_store.SESSION_STATUS["PENDING_CREATION"]
                    result["pending_creation"].append({"module_key": align["module_key"], "vendor": target_vendor, "title": title, "creation_request": creation.get("creation_request") or creation.get("request"), "host_action": creation.get("host_action") or "create_thread", "reason": creation.get("reason")})
                elif creation and creation.get("status") == "UNSUPPORTED":
                    align["status"] = state_store.SESSION_STATUS["UNSUPPORTED"]
                    result["unsupported"].append({"module_key": align["module_key"], "vendor": target_vendor, "title": title, "reason": creation.get("reason")})
                else:
                    align["status"] = state_store.SESSION_STATUS["CREATION_FAILED"]
                    result["creation_failures"].append({"module_key": align["module_key"], "vendor": target_vendor, "title": title, "reason": creation.get("reason") if creation else "creation adapter returned no result"})
        # 新建会话后重算分配, 保证与落盘同源
        assignments = resolve_module_assignments(suggestions, memory_docs, existing_modules, target_vendor)

    # 仅持久化通过批准门禁的模块; 其余会话仅入清单不占绑定
    main_thread_id = next((s["session_id"] for s in suggestions if s.get("session_id") == chosen_main_id and s.get("vendor") == target_vendor), None)
    if not main_thread_id:
        sticky_main = existing_modules.get("main") if isinstance(existing_modules, dict) else None
        if is_reusable_session(target_vendor, sticky_main):
            main_thread_id = sticky_main["session_id"]
    approved_keys = {a["module_key"] for a in gate["approved"]}
    for align in memory_alignment:
        if align["status"] == "CREATED_AND_ALIGNED":
            approved_keys.add(align["module_key"])

    target_modules = {}

    # 粘性绑定保护: 当前厂商分区中已有的可续接绑定优先保留, 扫描重匹配不得覆盖 (防 re-init 污染)
    try:
        with open(sessions_path, "r", encoding="utf-8") as f:
            _existing_doc = json.load(f)
        _existing_part = (_existing_doc.get("vendors") or {}).get(target_vendor)
        if _existing_part and isinstance(_existing_part.get("modules"), dict):
            for _k, _mod in _existing_part["modules"].items():
                _mod_vendor = state_store.normalize_vendor(_mod.get("vendor")) if isinstance(_mod, dict) else None
                if isinstance(_mod, dict) and (_mod_vendor or target_vendor) == target_vendor and is_reusable_session(target_vendor, _mod) and _k not in target_modules:
                    target_modules[_k] = {
                        **_mod,
                        "vendor": target_vendor,
                        "physical_session": True,
                        "lifecycle_status": _mod.get("lifecycle_status") or state_store.SESSION_STATUS["BOUND"],
                        "is_main": _k == "main" or _mod.get("session_id") == main_thread_id,
                    }
    except Exception:
        pass
    for key, item in assignments.items():
        if key in approved_keys and item.get("vendor") == target_vendor and is_reusable_session(target_vendor, item) and key not in target_modules:
            target_modules[key] = {
                "session_id": item["session_id"],
                "title": item["suggested_topic_name"],
                "tags": item["suggested_tags"],
                "memory_doc": item["suggested_memory_doc"],
                "vendor": item["vendor"],
                "id_kind": item.get("id_kind"),
                "resumable": True,
                "physical_session": True,
                "lifecycle_status": state_store.SESSION_STATUS["BOUND"],
                "is_main": key == "main" or item["session_id"] == main_thread_id,
                "dispatch_hint": item["dispatch_hint"],
                "summary": f"专题模块: {item['suggested_topic_name']}"
            }

    # Codex-only defaults are initialized once; existing per-session choices remain sticky.
    if target_vendor == "codex":
        for key, mod in list(target_modules.items()):
            mod_with_identity = dict(mod)
            mod_with_identity["vendor"] = mod.get("vendor") or target_vendor
            mod_with_identity["module_key"] = key
            mod_with_identity["is_main"] = key == "main"
            target_modules[key] = apply_initial_model_config(
                mod_with_identity,
                "main" if key == "main" else ("subagent" if key == "subagent" else mod.get("role", "topic")),
            )

    # sessions 列表严格仅由 target_modules 1:1 转换得到，彻底杜绝历史临时/瞬态子代理会话的污染与重复
    target_sessions_list = [
        {
            "session_id": mod["session_id"],
            "vendor": mod.get("vendor") or target_vendor,
            "title": mod["title"],
            "is_main": (key == "main" or mod["session_id"] == main_thread_id),
            "module_key": key,
            "id_kind": mod.get("id_kind"),
            "resumable": mod.get("resumable") is True and bool(mod.get("session_id")),
            "physical_session": bool(mod.get("session_id")),
            "lifecycle_status": mod.get("lifecycle_status") or (state_store.SESSION_STATUS["BOUND"] if mod.get("resumable") is True else state_store.SESSION_STATUS["PENDING_CREATION"]),
            "summary": mod.get("summary") or f"专题模块: {mod['title']}",
            "memory_docs": [mod["memory_doc"]] if mod.get("memory_doc") else [],
            **({"model_config": mod["model_config"]} if target_vendor == "codex" and mod.get("model_config") else {}),
        }
        for key, mod in target_modules.items()
    ]

    target_vendor_data = {
        "schema_version": 3,
        "vendor": target_vendor,
        "main_thread_id": main_thread_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "modules": target_modules,
        "sessions": target_sessions_list
    }

    # 3. 多厂商分区持久化与历史数据保护 (Schema v3 Namespaced Persistence)
    vendors = {}
    existing_sessions_data = None
    if os.path.exists(sessions_path):
        try:
            with open(sessions_path, "r", encoding="utf-8") as f:
                existing_sessions_data = json.load(f)
        except Exception:
            pass

    if existing_sessions_data and isinstance(existing_sessions_data.get("vendors"), dict):
        for v_key, v_data in existing_sessions_data["vendors"].items():
            vendors[v_key] = v_data
    elif existing_sessions_data and "modules" in existing_sessions_data:
        old_vendor = existing_sessions_data.get("current_vendor") or "antigravity"
        vendors[old_vendor] = {
            "schema_version": 3,
            "vendor": old_vendor,
            "main_thread_id": existing_sessions_data.get("main_thread_id"),
            "updated_at": existing_sessions_data.get("updated_at") or datetime.now(timezone.utc).isoformat(),
            "modules": existing_sessions_data.get("modules", {}),
            "sessions": existing_sessions_data.get("sessions", [])
        }

    # 检查磁盘既有独立物理文件
    for v in ["antigravity", "zcode", "codex", "claude"]:
        v_path = os.path.join(task_loop_dir, f"sessions.{v}.json")
        if v not in vendors and os.path.exists(v_path):
            try:
                with open(v_path, "r", encoding="utf-8") as f:
                    vendors[v] = json.load(f)
            except Exception:
                pass

    vendors[target_vendor] = target_vendor_data

    # 写入当前厂商独立物理文件
    with open(vendor_specific_file, "w", encoding="utf-8") as f:
        json.dump(target_vendor_data, f, indent=2, ensure_ascii=False)

    # 只写当前厂商镜像；其他厂商物理文件保持零写入，避免跨厂商污染。

    # 写入全量主 sessions.json (Schema v4: 顶层仅元数据 + vendors 厂商分区, 顶层冗余副本已废除以杜绝跨厂商覆写)
    master_sessions_data = {
        "schema_version": 4,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "vendors": vendors
    }

    with open(sessions_path, "w", encoding="utf-8") as f:
        json.dump(master_sessions_data, f, indent=2, ensure_ascii=False)

    # topics.json (Schema v4: 同样厂商顶层分区, 各厂商 topics 隔离, 动态扩展, 严禁互踩)
    existing_topics_data = None
    if os.path.exists(topics_path):
        try:
            with open(topics_path, "r", encoding="utf-8") as f:
                existing_topics_data = json.load(f)
        except Exception:
            existing_topics_data = None

    topics_vendors = {}
    if isinstance(existing_topics_data, dict) and isinstance(existing_topics_data.get("vendors"), dict):
        topics_vendors.update(existing_topics_data["vendors"])
    elif isinstance(existing_topics_data, dict) and isinstance(existing_topics_data.get("topics"), list):
        legacy_vendor = existing_topics_data.get("current_vendor") or target_vendor
        topics_vendors[legacy_vendor] = {
            "vendor": legacy_vendor,
            "updated_at": existing_topics_data.get("updated_at"),
            "topics": existing_topics_data["topics"],
        }

    target_topics_list = [
        {
            "topic_key": k,
            "name": v["title"],
            "session_id": v["session_id"],
            "vendor": v["vendor"],
            "resumable": v["resumable"],
            "lifecycle_status": v.get("lifecycle_status"),
            "is_main": v.get("is_main") is True,
            "id_kind": v.get("id_kind"),
            "tags": v["tags"],
            "memory_doc": v["memory_doc"]
        }
        for k, v in target_modules.items()
    ]
    target_topics = {
        "vendor": target_vendor,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "topics": target_topics_list,
    }
    topics_vendors[target_vendor] = target_topics

    # 目标厂商物理镜像 topics.<vendor>.json
    with open(os.path.join(task_loop_dir, f"topics.{target_vendor}.json"), "w", encoding="utf-8") as f:
        json.dump(dict({"schema_version": 3}, **target_topics), f, indent=2, ensure_ascii=False)

    topics_file_data = {
        "schema_version": 4,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "vendors": topics_vendors,
    }
    with open(topics_path, "w", encoding="utf-8") as f:
        json.dump(topics_file_data, f, indent=2, ensure_ascii=False)

    if not os.path.exists(todo_path):
        with open(todo_path, "w", encoding="utf-8") as f:
            json.dump({"schema_version": 3, "items": []}, f, indent=2, ensure_ascii=False)

    if not os.path.exists(policy_path):
        with open(policy_path, "w", encoding="utf-8") as f:
            json.dump({
                "schema_version": 3,
                "active_vendor": target_vendor,
                "default_lease_timeout_sec": 1800,
                "enable_file_state_machine": False
            }, f, indent=2, ensure_ascii=False)

    # 主会话记忆文档脚手架 (存在则不覆盖)
    if main_thread_id:
        result["scaffolded_memory_docs"] = []
        main_doc = "docs/MEMORY.md"
        if scaffold_memory_doc(ws_root, main_doc, "[主会话] 任务编排 & 治理中枢"):
            result["scaffolded_memory_docs"].append(main_doc)

    # 会话工具优先指引 (核心思想: 基于会话 SDK 的长期会话编排)
    result["session_tools"] = {
        "philosophy": "task-loop 以会话为一等公民: 主会话的角色是需求加工与派单, 实施必须派发至专题会话/子代理",
        "dispatch_order": [
            f"1. 查 .agents/task-loop/sessions.{target_vendor}.json (或 sessions.json vendors.{target_vendor}) 寻找匹配专题, 优先复用",
            "2. 可续接专题 (resumable: true): 经当前宿主 SessionProvider send/resume 原语定向派单",
            "3. 不可续接专题 (resumable: false): 仅只读内省参考; 需要实施时经 new-session 重建本宿主原生专题",
            "4. 无匹配专题: /init 经 new-session / spawn Provider 主动拉起; Codex 无原生工具时保留 PENDING_CREATION 请求, 取得 formal threadId 后再 bind",
        ],
        "vendor_mapping_doc": "references/sdk/README.md",
    }

    return result


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args or "-d" in args
    create_missing = not dry_run
    ws_root = os.getcwd()
    if "--workspace" in args:
        idx = args.index("--workspace")
        if idx + 1 < len(args):
            ws_root = args[idx + 1]

    vendor = None
    if "--vendor" in args:
        idx = args.index("--vendor")
        if idx + 1 < len(args):
            vendor = args[idx + 1].lower()

    current_session = None
    if "--current-session" in args:
        idx = args.index("--current-session")
        if idx + 1 < len(args):
            current_session = args[idx + 1]

    main_session = None
    if "--main-session" in args:
        idx = args.index("--main-session")
        if idx + 1 < len(args):
            main_session = args[idx + 1]

    def parse_list(flag):
        if flag in args:
            idx = args.index(flag)
            if idx + 1 < len(args):
                return [s.strip() for s in args[idx + 1].split(",") if s.strip()]
        return []

    res = init_task_loop({
        "ws_root": ws_root,
        "dry_run": dry_run,
        "create_missing": create_missing,
        "vendor": vendor,
        "current_session": current_session,
        "main_session": main_session,
        "module_allowlist": parse_list("--modules"),
        "module_exclude": parse_list("--exclude"),
    })

    print("================================================================================")
    print(" [task-loop] 项目初始化与已有会话调查")
    print("================================================================================")
    print(f"工作区根路径: {res['workspace_root']}")
    print(f"状态机存储目录: {res['storage_directory']}")
    print(f"核心配置文件: {res['storage_files']['sessions_json']}")
    print(f"已发现已有历史会话数量: {res['discovered_sessions_count']}")
    if res.get("chosen_main_session_id"):
        print(f"选定主会话 ID: {res['chosen_main_session_id']}")
    print("--------------------------------------------------------------------------------")
    print("受控记忆文档 1:1 专题会话匹配状态 (Memory Docs 1:1 Alignment):")
    for idx, item in enumerate(res["memory_alignment"]):
        status = item.get("status")
        status_tag = ("[✔ 已匹配]" if status in ("ALIGNED", state_store.SESSION_STATUS["BOUND"])
                      else ("[✔ 已自动创建顶层会话并绑定]" if status == "CREATED_AND_ALIGNED" else "[⚠ 本次主动补齐中/等待 formal ID]"))
        resume_tag = " [可续接]" if item.get("matched_session_id") and item.get("resumable") else (" [只读遗留]" if item.get("matched_session_id") else "")
        print(f"\n[M{idx + 1}] 记忆文档: {item['memory_doc']}")
        print(f"     模块 Key: {item['module_key']}")
        print(f"     专题名称: {item['matched_topic_name']}")
        print(f"     绑定会话: {item.get('matched_session_id') or '(未绑定)'} {status_tag}{resume_tag}")
    print("--------------------------------------------------------------------------------")

    if res.get("created_sessions"):
        print("【已自动创建的新独立顶层根会话 (nestingDepth = 0)】:")
        for index, created in enumerate(res["created_sessions"], 1):
            print(f"  {index}. [{created['module_key']}] {created['title']} -> {created['session_id']}")
        print("--------------------------------------------------------------------------------")

    print("建议专题映射清单 (Topic Mapping Recommendations):")

    for idx, s in enumerate(res["topic_mapping_suggestions"]):
        print(f"\n[{idx + 1}] 会话 ID: {s['session_id']}")
        print(f"    原标题: {s['original_title']} ({s['vendor']})")
        print(f"    建议专题名: {s['suggested_topic_name']}")
        print(f"    建议模块Key: {s['suggested_module_key']}{' [需人工命名]' if s.get('needs_naming') else ''}")
        print(f"    可续接: {'是' if s.get('resumable') else '否 (只读遗留)'}")
        print(f"    派单提示: {s.get('dispatch_hint', '')}")
        print(f"    关联受控记忆: {s['suggested_memory_doc']}")
        if s.get("is_current_session") and s.get("is_main_candidate"):
            print("    [Current Session & Main Candidate] 当前发起会话 (推荐为主治理中枢)")
        elif s.get("is_main_candidate"):
            print("    [Main Candidate] 候选为主会话 (Main Thread)")
        elif s.get("is_current_session"):
            print("    [Current Session] 当前发起会话")

    if res.get("pending_approval"):
        print("\n--------------------------------------------------------------------------------")
        print("【待批准模块 (pending_approval)】以下建议默认不落盘, 确需持久化请追加: --modules <key1,key2>")
        for i, p in enumerate(res["pending_approval"], 1):
            print(f"  {i}. [{p['module_key']}] {p['session_id']} ({p['reason']})")

    if res.get("pending_creation"):
        print("\n--------------------------------------------------------------------------------")
        print("【待原生宿主创建 (PENDING_CREATION)】:")
        for i, pending in enumerate(res["pending_creation"], 1):
            print(f"  {i}. [{pending['module_key']}] {pending['title']} -> {pending.get('host_action') or 'create_thread'}")
            print(f"     creation_request: {json.dumps(pending.get('creation_request') or {}, ensure_ascii=False)}")
            print(f"     reason: {pending.get('reason') or 'formal threadId 尚未返回'}")

    if res.get("session_tools"):
        print("\n--------------------------------------------------------------------------------")
        print("【会话工具优先指引 (Session-First)】")
        for line in res["session_tools"]["dispatch_order"]:
            print(f"  {line}")
        print(f"  厂商原语映射: {res['session_tools']['vendor_mapping_doc']}")

    print("\n================================================================================")
    if dry_run:
        print("【预览模式 (Dry-Run)】未实际写入文件。确认上述建议后，去掉 --dry-run 参数执行即可。")
    else:
        print("【初始化完成】已将配置保存至:")
        print(f"  - sessions.json: {res['storage_files']['sessions_json']}")
        print(f"  - topics.json:   {res['storage_files']['topics_json']}")
        print("\n【用户兜底修改提示】:")
        print("若上述专题划分、命名或 ID 需要调整，您随时可以直接打开并手动编辑:")
        print(f"  >> {res['storage_files']['sessions_json']}")
        print("插件与 Hook 均实时读取该文件，改动即刻生效！")
    print("================================================================================\n")


if __name__ == "__main__":
    main()
