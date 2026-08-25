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
    from get_agy_project_sessions import get_agy_project_sessions
except ImportError:
    def get_agy_project_sessions(ws): return []

try:
    from get_codex_project_sessions import get_codex_project_sessions
except ImportError:
    def get_codex_project_sessions(ws): return []

try:
    from get_claude_project_sessions import get_claude_project_sessions
except ImportError:
    def get_claude_project_sessions(ws): return []


def normalize_path(p):
    if not p:
        return ""
    return p.replace("\\", "/")


def infer_topic_mapping(session):
    title = (session.get("title") or "").lower()
    summary = (session.get("summary") or "").lower()
    full_text = f"{title} {summary}"

    if any(k in full_text for k in ["hook", "钩子", "拦截", "门禁"]):
        return {
            "module_key": "hook",
            "topic_name": "钩子体系与安全拦截专题",
            "tags": ["hook", "lifecycle", "safety_gate"],
            "memory_doc": "docs/memory/hook.md"
        }
    if any(k in full_text for k in ["subagent", "子代理", "并行", "worker"]):
        return {
            "module_key": "subagent",
            "topic_name": "子代理编排与动态模板专题",
            "tags": ["subagent", "orchestration", "workers"],
            "memory_doc": "docs/memory/subagent.md"
        }
    if any(k in full_text for k in ["session", "会话", "provider", "日志"]):
        return {
            "module_key": "session_control",
            "topic_name": "跨厂商会话控制与内省专题",
            "tags": ["session_control", "introspection", "provider"],
            "memory_doc": "docs/memory/session_control.md"
        }

    raw_title = session.get("title") or "custom_topic"
    cleaned_key = re.sub(r"[^\w\u4e00-\u9fa5]", "_", raw_title)
    cleaned_key = re.sub(r"_+", "_", cleaned_key).strip("_")[:30]
    if not cleaned_key:
        cleaned_key = f"topic_{(session.get('session_id') or '')[:8]}"

    return {
        "module_key": cleaned_key,
        "topic_name": session.get("title") or "自定义专题",
        "tags": ["topic", "custom"],
        "memory_doc": f"docs/memory/{cleaned_key}.md"
    }


def survey_existing_sessions(ws_root):
    agy_s = get_agy_project_sessions(ws_root) or []
    codex_s = get_codex_project_sessions(ws_root) or []
    claude_s = get_claude_project_sessions(ws_root) or []

    all_sessions = agy_s + codex_s + claude_s
    unique_map = {}
    for s in all_sessions:
        s_id = s.get("session_id")
        if s_id and s_id not in unique_map:
            unique_map[s_id] = s

    suggestions = []
    for s in unique_map.values():
        inferred = infer_topic_mapping(s)
        suggestions.append({
            "session_id": s.get("session_id"),
            "vendor": s.get("vendor"),
            "original_title": s.get("title") or "(无标题)",
            "suggested_module_key": inferred["module_key"],
            "suggested_topic_name": inferred["topic_name"],
            "suggested_tags": inferred["tags"],
            "suggested_memory_doc": inferred["memory_doc"],
            "is_main_candidate": s.get("is_main", False)
        })

    return suggestions


def init_task_loop(options=None):
    if options is None:
        options = {}
    ws_root = options.get("wsRoot") or os.getcwd()
    dry_run = options.get("dryRun", False)

    task_loop_dir = os.path.join(ws_root, ".agents", "task-loop")
    sessions_path = os.path.join(task_loop_dir, "sessions.json")
    topics_path = os.path.join(task_loop_dir, "topics.json")
    todo_path = os.path.join(task_loop_dir, "todo.json")
    policy_path = os.path.join(task_loop_dir, "policy.json")

    suggestions = survey_existing_sessions(ws_root)

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
        "topic_mapping_suggestions": suggestions
    }

    if dry_run:
        return result

    os.makedirs(task_loop_dir, exist_ok=True)

    main_thread_id = None
    modules = {}
    sessions_list = []

    for item in suggestions:
        if item.get("is_main_candidate") and not main_thread_id:
            main_thread_id = item.get("session_id")
        
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
        "main_thread_id": main_thread_id or (suggestions[0]["session_id"] if suggestions else None),
        "updated_at": datetime.now().isoformat(),
        "modules": modules,
        "sessions": sessions_list
    }

    with open(sessions_path, "w", encoding="utf-8") as f:
        json.dump(sessions_data, f, indent=2, ensure_ascii=False)

    if not os.path.exists(topics_path):
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
    ws_root = os.getcwd()
    if "--workspace" in args:
        idx = args.index("--workspace")
        if idx + 1 < len(args):
            ws_root = args[idx + 1]

    res = init_task_loop({"wsRoot": ws_root, "dryRun": dry_run})

    print("================================================================================")
    print(" [task-loop] 项目初始化与已有会话调查")
    print("================================================================================")
    print(f"工作区根路径: {res['workspace_root']}")
    print(f"状态机存储目录: {res['storage_directory']}")
    print(f"核心配置文件: {res['storage_files']['sessions_json']}")
    print(f"已发现已有历史会话数量: {res['discovered_sessions_count']}")
    print("--------------------------------------------------------------------------------")
    print("建议专题映射清单 (Topic Mapping Recommendations):")

    for idx, s in enumerate(res["topic_mapping_suggestions"]):
        print(f"\n[{idx + 1}] 会话 ID: {s['session_id']}")
        print(f"    原标题: {s['original_title']} ({s['vendor']})")
        print(f"    建议专题名: {s['suggested_topic_name']}")
        print(f"    建议模块Key: {s['suggested_module_key']}")
        print(f"    关联受控记忆: {s['suggested_memory_doc']}")
        if s.get("is_main_candidate"):
            print("    [Main Candidate] 候选为主会话 (Main Thread)")

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
