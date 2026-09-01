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

# Import providers
script_dir = os.path.dirname(os.path.abspath(__file__))
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
    if env.get("ZCODE_SESSION_ID") or env.get("CLAUDE_SESSION_ID"):
        return "zcode"
    # 会话 ID 形状硬特征: sess_ 前缀为 ZCode 会话规范, 优先级高于其他宿主残留环境变量
    if current_session_id and str(current_session_id).lower().startswith("sess_"):
        return "zcode"
    if env.get("CODEX_THREAD_ID") or env.get("CODEX_SESSION_ID"):
        return "codex"
    if env.get("ANTIGRAVITY_CONVERSATION_ID"):
        return "antigravity"
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


def spawn_root_conversation(title, prompt, ws_root):
    env = dict(os.environ)
    for k in ["ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_SOURCE_METADATA", "ANTIGRAVITY_TRAJECTORY_ID"]:
        env.pop(k, None)

    cmd = ["agentapi.bat", "new-conversation", f"--title={title}", prompt]
    try:
        res = subprocess.run(cmd, env=env, cwd=ws_root, shell=True, capture_output=True, text=True, encoding="utf-8")
        if res.stdout:
            data = json.loads(res.stdout)
            return data.get("response", {}).get("newConversation", {}).get("conversationId")
    except Exception:
        pass
    return None


def resolve_module_assignments(suggestions, memory_docs=None):
    """单一事实源: 严格以 docs/memory/*.md 中的法定模块为准进行 1:1 对齐匹配。"""
    assignments = {}

    # 1. 先匹配 main
    main_cand = next((s for s in suggestions if s.get("is_main_candidate")), None) or next(
        (s for s in suggestions if s.get("suggested_module_key") == "main"), None
    )
    if main_cand:
        assignments["main"] = main_cand

    # 2. 为每个受控记忆文档匹配首个最合适的建议项
    for doc in (memory_docs or []):
        if doc["module_key"] == "main":
            continue
        matched = next((s for s in suggestions if s.get("suggested_module_key") == doc["module_key"]), None)
        if matched:
            assignments[doc["module_key"]] = matched

    return assignments


def apply_approval_gate(assignments, memory_alignment, options=None):
    """批准门禁 (纯函数): 默认仅 main + 记忆文档已对齐模块可持久化, 其余进入 pending_approval。"""
    options = options or {}
    allow = set(options.get("module_allowlist") or options.get("moduleAllowlist") or [])
    exclude = set(options.get("module_exclude") or options.get("moduleExclude") or [])
    aligned_keys = {a["module_key"] for a in memory_alignment if a["status"] in ("ALIGNED", "CREATED_AND_ALIGNED")}

    approved = []
    pending = []
    for key, suggestion in assignments.items():
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
    target_vendor = options.get("vendor") or detect_current_vendor(options.get("env"), options.get("current_session") or options.get("currentSession")) or "antigravity"
    caller_session_id = (
        options.get("current_session") or options.get("current_session_id") or options.get("currentSessionId")
        or os.environ.get("ANTIGRAVITY_CONVERSATION_ID") or os.environ.get("ZCODE_SESSION_ID") or os.environ.get("CLAUDE_SESSION_ID")
    )
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
        s_id = s.get("session_id")
        if s_id and s_id not in unique_map:
            unique_map[s_id] = s

    # 若 caller_session_id 存在但在扫描中未发现，自动补入
    if caller_session_id and caller_session_id not in unique_map:
        now_iso = datetime.now(timezone.utc).isoformat()
        unique_map[caller_session_id] = {
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
    if explicit_main_session_id:
        chosen_main_id = explicit_main_session_id
        if explicit_main_session_id not in unique_map:
            now_iso = datetime.now(timezone.utc).isoformat()
            unique_map[explicit_main_session_id] = {
                "session_id": explicit_main_session_id,
                "vendor": current_vendor,
                "title": "[主会话] 任务编排 & 治理中枢",
                "is_main": True,
                "created_at": now_iso,
                "last_active_at": now_iso
            }
    elif caller_session_id and caller_session_id in unique_map:
        chosen_main_id = caller_session_id
    elif caller_session_id:
        chosen_main_id = caller_session_id
        now_iso = datetime.now(timezone.utc).isoformat()
        unique_map[caller_session_id] = {
            "session_id": caller_session_id,
            "vendor": current_vendor,
            "title": "[主会话] 任务编排 & 治理中枢",
            "is_main": True,
            "created_at": now_iso,
            "last_active_at": now_iso
        }
    else:
        for s in unique_map.values():
            raw_title = (s.get("title") or "").lower()
            s_vendor = (s.get("vendor") or "antigravity").lower()
            if (s.get("is_main") or "[主会话]" in raw_title or "治理中枢" in raw_title) and (s_vendor == current_vendor):
                chosen_main_id = s.get("session_id")
                break
        if not chosen_main_id:
            for s in unique_map.values():
                raw_title = (s.get("title") or "").lower()
                if s.get("is_main") or "[主会话]" in raw_title or "治理中枢" in raw_title:
                    chosen_main_id = s.get("session_id")
                    break
        if not chosen_main_id and len(unique_map) > 0:
            chosen_main_id = next(iter(unique_map.keys()))

    suggestions = []
    for s in unique_map.values():
        s_id = s.get("session_id")
        s_vendor = s.get("vendor", "antigravity")
        is_main_candidate = (s_id == chosen_main_id and s_vendor == current_vendor)
        is_current_session = (s_id == caller_session_id)

        if is_main_candidate:
            inferred = {
                "module_key": "main",
                "topic_name": s.get("title") if (s.get("title") and "[主会话]" in s.get("title")) else "[主会话] 任务编排 & 治理中枢",
                "tags": ["main", "orchestrator"],
                "memory_doc": "docs/MEMORY.md"
            }
        else:
            inferred = infer_topic_mapping(s, memory_keys)

        suggestions.append({
            "session_id": s_id,
            "vendor": s_vendor,
            "original_title": sanitize_title(s.get("title")),
            "suggested_module_key": inferred["module_key"],
            "needs_naming": bool(inferred.get("needs_naming")),
            "suggested_topic_name": inferred["topic_name"],
            "suggested_tags": inferred["tags"],
            "suggested_memory_doc": inferred["memory_doc"],
            "resumable": s_vendor == current_vendor,
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

    # 单一事实源: 一次性计算模块分配, 对齐报告与持久化共用
    assignments = resolve_module_assignments(suggestions, memory_docs)

    memory_alignment = []
    for doc in memory_docs:
        matched = assignments.get(doc["module_key"])
        memory_alignment.append({
            "module_key": doc["module_key"],
            "memory_doc": doc["relative_path"],
            "matched_session_id": matched["session_id"] if matched else None,
            "matched_vendor": matched["vendor"] if matched else None,
            "resumable": matched["resumable"] if matched else False,
            "matched_topic_name": matched["suggested_topic_name"] if matched else f"[{doc['module_key']}专题] 核心功能维护 & 记忆沉淀",
            "status": "ALIGNED" if matched else "MISSING_SESSION"
        })

    return suggestions, memory_docs, memory_alignment, chosen_main_id, caller_session_id, assignments, current_vendor


def init_task_loop(options=None):
    if options is None:
        options = {}
    ws_root = options.get("ws_root") or options.get("wsRoot") or os.getcwd()
    dry_run = options.get("dry_run") or options.get("dryRun") or False
    create_missing = options.get("create_missing") or options.get("createMissing") or False
    target_vendor = options.get("vendor") or detect_current_vendor(options.get("env"), options.get("current_session") or options.get("currentSession")) or "antigravity"
    options["vendor"] = target_vendor

    task_loop_dir = os.path.join(ws_root, ".agents", "task-loop")
    sessions_path = os.path.join(task_loop_dir, "sessions.json")
    topics_path = os.path.join(task_loop_dir, "topics.json")
    todo_path = os.path.join(task_loop_dir, "todo.json")
    policy_path = os.path.join(task_loop_dir, "policy.json")
    vendor_specific_file = os.path.join(task_loop_dir, f"sessions.{target_vendor}.json")

    suggestions, memory_docs, memory_alignment, chosen_main_id, caller_session_id, assignments, current_vendor = survey_existing_sessions(ws_root, options)

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
        "created_sessions": []
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

    if create_missing and target_vendor == "antigravity":
        for align in memory_alignment:
            if align["status"] == "MISSING_SESSION":
                title = align["matched_topic_name"]
                prompt = f"[{align['module_key']}专题初始化] 你是 task-loop 项目的【${align['module_key']}专题负责人】。你负责维护本专题代码与记忆文档 {align['memory_doc']}。"
                new_id = spawn_root_conversation(title, prompt, ws_root)
                if new_id:
                    align["matched_session_id"] = new_id
                    align["status"] = "CREATED_AND_ALIGNED"
                    result["created_sessions"].append({"module_key": align["module_key"], "session_id": new_id, "title": title})
                    suggestions.append({
                        "session_id": new_id,
                        "vendor": target_vendor,
                        "original_title": sanitize_title(title),
                        "suggested_module_key": align["module_key"],
                        "suggested_topic_name": title,
                        "suggested_tags": [align["module_key"], "topic"],
                        "suggested_memory_doc": align["memory_doc"],
                        "resumable": True,
                        "dispatch_hint": "可续接: 经当前宿主会话 SDK send/resume 原语定向派单 (各厂商映射见 references/sdk/README.md)",
                        "is_main_candidate": False,
                        "is_current_session": False
                    })
        # 新建会话后重算分配, 保证与落盘同源
        assignments = resolve_module_assignments(suggestions, memory_docs)

    # 仅持久化通过批准门禁的模块; 其余会话仅入清单不占绑定
    main_thread_id = chosen_main_id or (suggestions[0]["session_id"] if suggestions else None)
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
                if isinstance(_mod, dict) and _mod.get("session_id") and _mod.get("resumable") is not False and _k not in target_modules:
                    target_modules[_k] = _mod
    except Exception:
        pass
    for key, item in assignments.items():
        if key in approved_keys and item.get("vendor") == target_vendor:
            target_modules[key] = {
                "session_id": item["session_id"],
                "title": item["suggested_topic_name"],
                "tags": item["suggested_tags"],
                "memory_doc": item["suggested_memory_doc"],
                "vendor": item["vendor"],
                "resumable": True,
                "dispatch_hint": item["dispatch_hint"],
                "summary": f"专题模块: {item['suggested_topic_name']}"
            }

    # sessions 列表严格仅由 target_modules 1:1 转换得到，彻底杜绝历史临时/瞬态子代理会话的污染与重复
    target_sessions_list = [
        {
            "session_id": mod["session_id"],
            "vendor": mod["vendor"],
            "title": mod["title"],
            "is_main": (key == "main" or mod["session_id"] == main_thread_id),
            "module_key": key,
            "resumable": True,
            "summary": mod.get("summary") or f"专题模块: {mod['title']}",
            "memory_docs": [mod["memory_doc"]] if mod.get("memory_doc") else []
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

    # 若其他已知厂商在 vendors 中有数据，也确保其物理文件同步更新/落盘
    for v_key, v_data in vendors.items():
        v_file = os.path.join(task_loop_dir, f"sessions.{v_key}.json")
        if not os.path.exists(v_file) or v_key == target_vendor:
            try:
                with open(v_file, "w", encoding="utf-8") as f:
                    json.dump(v_data, f, indent=2, ensure_ascii=False)
            except Exception:
                pass

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
        json.dump(dict({"schema_version": 4}, **target_topics), f, indent=2, ensure_ascii=False)

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
            "4. 无匹配专题: 经 new-session / spawn Provider 拉起新顶层会话后登记, 严禁退化为人肉 UI 操作",
        ],
        "vendor_mapping_doc": "references/sdk/README.md",
    }

    return result


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args or "-d" in args
    create_missing = "--create-missing" in args or "-c" in args
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
