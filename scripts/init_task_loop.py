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
from datetime import datetime

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


def infer_topic_mapping(session):
    raw_title = re.sub(r"\[[^\]]+\]\([^\)]+\)", "", (session.get("title") or "")).strip()
    title_lower = raw_title.lower()
    summary_lower = (session.get("summary") or "").lower()
    prompts_lower = " ".join(session.get("recent_prompts") or []).lower()
    touched_lower = " ".join(session.get("recent_touched_files") or []).lower()
    full_text = f"{title_lower} {summary_lower} {prompts_lower} {touched_lower}"

    category = ""
    func1 = ""
    func2 = ""
    module_key = ""

    if session.get("is_main") or "main" in title_lower or (session.get("session_id") == "ee94b2c5-c0c2-473f-8f71-213250ba5295") or any(k in full_text for k in ["治理中枢", "开发仓库"]):
        category = "主会话"
        func1 = "任务编排"
        func2 = "治理中枢"
        module_key = "main"
    elif any(k in full_text for k in ["topic: hook", "钩子专题"]) or ("hook" in title_lower and "main" not in title_lower):
        category = "钩子专题"
        func1 = "生命周期"
        func2 = "安全门禁"
        module_key = "hook"
    elif any(k in full_text for k in ["topic: subagent", "子代理专题"]) or ("subagent" in title_lower and "main" not in title_lower):
        category = "子代理专题"
        func1 = "动态模板"
        func2 = "编排治理"
        module_key = "subagent"
    elif any(k in full_text for k in ["topic: session_control", "session_control", "会话专题", "会话"]) or ("session" in title_lower and "main" not in title_lower):
        category = "会话控制专题"
        func1 = "跨厂商内省"
        func2 = "会话管理"
        module_key = "session_control"
    elif any(k in full_text for k in ["topic: memory", "记忆专题"]) or "memory" in title_lower:
        category = "受控记忆专题"
        func1 = "文档维护"
        func2 = "经验沉淀"
        module_key = "memory"
    elif any(k in full_text for k in ["code review", "代码审查", "高级代码审查员", "走查"]):
        category = "代码审查专题"
        func1 = "质量走查"
        func2 = "门禁核验"
        module_key = "code_review"
    elif any(k in full_text for k in ["debug", "排障", "卡顿", "故障", "报错"]):
        category = "排障诊断专题"
        func1 = "缺陷定位"
        func2 = "故障分析"
        module_key = "debug"
    elif any(k in full_text for k in ["claude code", "claude sdk"]) or ("claude" in title_lower and "main" not in title_lower):
        category = "Claude协同专题"
        func1 = "SDK适配"
        func2 = "跨平台支持"
        module_key = "claude_sdk"
    elif any(k in full_text for k in ["topic: codex"]) or ("codex" in title_lower and "main" not in title_lower):
        category = "Codex协同专题"
        func1 = "跨端同步"
        func2 = "会话管理"
        module_key = "codex_sync"
    elif any(k in full_text for k in ["topic: plugin", "plugin规范"]) or ("plugin" in title_lower and "main" not in title_lower):
        category = "Plugin规范专题"
        func1 = "接口定义"
        func2 = "插件集成"
        module_key = "plugin_spec"
    elif any(k in full_text for k in ["topic: dispatch", "调度专题"]):
        category = "任务循环调度专题"
        func1 = "任务分发"
        func2 = "状态机管理"
        module_key = "task_loop"
    else:
        clean_text = re.sub(r"[^\w\s\u4e00-\u9fa5]", " ", raw_title)
        stop_words = {"请你", "一个", "当前", "这个", "作为", "可以", "需要", "进行", "如何", "为什么", "是否", "实现", "相关", "检查", "项目"}
        words = [w for w in clean_text.split() if len(w) >= 2 and w not in stop_words]

        kw1 = words[0] if len(words) > 0 else "核心业务"
        kw2 = words[1] if len(words) > 1 else "功能实现"
        category = f"{kw1}专题"
        func1 = kw1
        func2 = kw2
        raw_key = words[0] if len(words) > 0 else "custom_topic"
        module_key = re.sub(r"[^\w\u4e00-\u9fa5]", "_", raw_key)
        module_key = re.sub(r"_+", "_", module_key).strip("_")[:25]
        if not module_key or module_key == "_":
            module_key = f"topic_{(session.get('session_id') or '')[:8]}"

    standardized_title = f"[{category}] {func1} & {func2}"
    return {
        "module_key": module_key,
        "topic_name": standardized_title,
        "tags": [module_key, "topic"],
        "memory_doc": f"docs/memory/{module_key}.md"
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


def survey_existing_sessions(ws_root, options=None):
    if options is None:
        options = {}
    caller_session_id = options.get("current_session") or options.get("current_session_id") or options.get("currentSessionId") or os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
    explicit_main_session_id = options.get("main_session") or options.get("main_session_id") or options.get("mainSessionId")

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
        unique_map[caller_session_id] = {
            "session_id": caller_session_id,
            "vendor": "antigravity",
            "title": "[主会话] 任务编排 & 治理中枢",
            "is_main": True,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "last_active_at": datetime.utcnow().isoformat() + "Z"
        }

    # 主会话选定优先级:
    # 1) --main-session <id> (用户显式指定)
    # 2) --current-session 或环境变量读取到的当前活跃会话 ID (推荐当前发起会话为主会话)
    # 3) 历史扫描中明确带 [主会话] 标签或 is_main 的会话
    # 4) suggestions 列表中的第一项
    chosen_main_id = None
    if explicit_main_session_id and explicit_main_session_id in unique_map:
        chosen_main_id = explicit_main_session_id
    elif caller_session_id and caller_session_id in unique_map:
        chosen_main_id = caller_session_id
    else:
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
        is_main_candidate = (s_id == chosen_main_id)
        is_current_session = (s_id == caller_session_id)

        if is_main_candidate:
            inferred = {
                "module_key": "main",
                "topic_name": s.get("title") if (s.get("title") and "[主会话]" in s.get("title")) else "[主会话] 任务编排 & 治理中枢",
                "tags": ["main", "orchestrator"],
                "memory_doc": "docs/memory/main.md"
            }
        else:
            inferred = infer_topic_mapping(s)
            if inferred["module_key"] == "main":
                short_id = (s_id or "")[:8]
                inferred["module_key"] = f"topic_{short_id}"
                inferred["topic_name"] = f"[业务专题] {s.get('title') or '通用开发'}"
                inferred["tags"] = [inferred["module_key"], "topic"]
                inferred["memory_doc"] = f"docs/memory/{inferred['module_key']}.md"

        suggestions.append({
            "session_id": s_id,
            "vendor": s.get("vendor", "antigravity"),
            "original_title": s.get("title") or "(无标题)",
            "suggested_module_key": inferred["module_key"],
            "suggested_topic_name": inferred["topic_name"],
            "suggested_tags": inferred["tags"],
            "suggested_memory_doc": inferred["memory_doc"],
            "is_main_candidate": is_main_candidate,
            "is_current_session": is_current_session
        })

    # 让 is_main_candidate 的项排在最前
    suggestions.sort(key=lambda x: 0 if x.get("is_main_candidate") else 1)

    memory_docs = scan_existing_memory_docs(ws_root)
    memory_alignment = []
    for doc in memory_docs:
        matched = next((s for s in suggestions if s["suggested_module_key"] == doc["module_key"]), None)
        memory_alignment.append({
            "module_key": doc["module_key"],
            "memory_doc": doc["relative_path"],
            "matched_session_id": matched["session_id"] if matched else None,
            "matched_topic_name": matched["suggested_topic_name"] if matched else f"[{doc['module_key']}专题] 核心功能维护 & 记忆沉淀",
            "status": "ALIGNED" if matched else "MISSING_SESSION"
        })

    return suggestions, memory_docs, memory_alignment, chosen_main_id, caller_session_id


def init_task_loop(options=None):
    if options is None:
        options = {}
    ws_root = options.get("ws_root") or options.get("wsRoot") or os.getcwd()
    dry_run = options.get("dry_run") or options.get("dryRun") or False
    create_missing = options.get("create_missing") or options.get("createMissing") or False

    task_loop_dir = os.path.join(ws_root, ".agents", "task-loop")
    sessions_path = os.path.join(task_loop_dir, "sessions.json")
    topics_path = os.path.join(task_loop_dir, "topics.json")
    todo_path = os.path.join(task_loop_dir, "todo.json")
    policy_path = os.path.join(task_loop_dir, "policy.json")

    suggestions, memory_docs, memory_alignment, chosen_main_id, caller_session_id = survey_existing_sessions(ws_root, options)

    result = {
        "workspace_root": normalize_path(ws_root),
        "storage_directory": normalize_path(task_loop_dir),
        "storage_files": {
            "sessions_json": normalize_path(sessions_path),
            "topics_json": normalize_path(topics_path),
            "todo_json": normalize_path(todo_path),
            "policy_json": normalize_path(policy_path)
        },
        "discovered_sessions_count": len(suggestions),
        "existing_memory_docs_count": len(memory_docs),
        "chosen_main_session_id": chosen_main_id,
        "caller_session_id": caller_session_id,
        "memory_alignment": memory_alignment,
        "topic_mapping_suggestions": suggestions,
        "created_sessions": []
    }

    if dry_run:
        return result

    # 实际写入
    os.makedirs(task_loop_dir, exist_ok=True)

    if create_missing:
        for align in memory_alignment:
            if align["status"] == "MISSING_SESSION":
                title = align["matched_topic_name"]
                prompt = f"[{align['module_key']}专题初始化] 你是 task-loop 项目的【{align['module_key']}专题负责人】。你负责维护本专题代码与记忆文档 {align['memory_doc']}。"
                new_id = spawn_root_conversation(title, prompt, ws_root)
                if new_id:
                    align["matched_session_id"] = new_id
                    align["status"] = "CREATED_AND_ALIGNED"
                    result["created_sessions"].append({"module_key": align["module_key"], "session_id": new_id, "title": title})
                    suggestions.append({
                        "session_id": new_id,
                        "vendor": "antigravity",
                        "original_title": title,
                        "suggested_module_key": align["module_key"],
                        "suggested_topic_name": title,
                        "suggested_tags": [align["module_key"], "topic"],
                        "suggested_memory_doc": align["memory_doc"],
                        "is_main_candidate": False,
                        "is_current_session": False
                    })

    main_thread_id = chosen_main_id or (suggestions[0]["session_id"] if suggestions else None)
    modules = {}
    sessions_list = []

    for item in suggestions:
        m_key = item["suggested_module_key"]
        modules[m_key] = {
            "session_id": item["session_id"],
            "title": item["suggested_topic_name"],
            "tags": item["suggested_tags"],
            "memory_doc": item["suggested_memory_doc"],
            "summary": f"专题模块: {item['suggested_topic_name']}"
        }
        sessions_list.append({
            "session_id": item["session_id"],
            "vendor": item["vendor"],
            "title": item["suggested_topic_name"],
            "is_main": (item["session_id"] == main_thread_id),
            "module_key": m_key,
            "summary": f"专题模块: {item['suggested_topic_name']}",
            "memory_docs": [item["suggested_memory_doc"]]
        })

    sessions_data = {
        "schema_version": 2,
        "main_thread_id": main_thread_id,
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "modules": modules,
        "sessions": sessions_list
    }

    with open(sessions_path, "w", encoding="utf-8") as f:
        json.dump(sessions_data, f, indent=2, ensure_ascii=False)

    if not os.path.exists(topics_path) or create_missing:
        topics_data = {
            "schema_version": 2,
            "topics": [
                {
                    "topic_key": k,
                    "name": v["title"],
                    "session_id": v["session_id"],
                    "tags": v["tags"],
                    "memory_doc": v["memory_doc"]
                }
                for k, v in modules.items()
            ]
        }
        with open(topics_path, "w", encoding="utf-8") as f:
            json.dump(topics_data, f, indent=2, ensure_ascii=False)

    if not os.path.exists(todo_path):
        with open(todo_path, "w", encoding="utf-8") as f:
            json.dump({"schema_version": 2, "items": []}, f, indent=2, ensure_ascii=False)

    if not os.path.exists(policy_path):
        with open(policy_path, "w", encoding="utf-8") as f:
            json.dump({
                "schema_version": 2,
                "active_vendor": "antigravity",
                "default_lease_timeout_sec": 1800,
                "enable_file_state_machine": False
            }, f, indent=2, ensure_ascii=False)

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

    res = init_task_loop({
        "ws_root": ws_root,
        "dry_run": dry_run,
        "create_missing": create_missing,
        "current_session": current_session,
        "main_session": main_session
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
        print(f"    建议模块Key: {s['suggested_module_key']}")
        print(f"    关联受控记忆: {s['suggested_memory_doc']}")
        if s.get("is_current_session") and s.get("is_main_candidate"):
            print("    [Current Session & Main Candidate] 当前发起会话 (推荐为主治理中枢)")
        elif s.get("is_main_candidate"):
            print("    [Main Candidate] 候选为主会话 (Main Thread)")
        elif s.get("is_current_session"):
            print("    [Current Session] 当前发起会话")

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
