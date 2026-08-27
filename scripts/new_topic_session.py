#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
new_topic_session.py - 创建与初始化专题会话 (Python 标准库实现)

核心能力：
1. 手动指定某个专题记忆文档 (docs/memory/*.md)，主动读取其内容并建立独立顶层根会话 (nestingDepth: 0)；
2. 若未指定，自动扫描 docs/memory/*.md 找出所有未建立专题会话的受控记忆，批量补齐初始化；
3. 自动原子回写 .agents/task-loop/sessions.json 与 topics.json。
"""

import os
import sys
import json
import re
import subprocess
from datetime import datetime


def normalize_path(p):
    return p.replace("\\", "/") if p else ""


def parse_memory_doc(doc_path, ws_root):
    full_path = doc_path if os.path.isabs(doc_path) else os.path.join(ws_root, doc_path)
    if not os.path.exists(full_path):
        raise FileNotFoundError(f"记忆文档不存在: {full_path}")

    with open(full_path, "r", encoding="utf-8") as f:
        content = f.read()

    base_name = os.path.splitext(os.path.basename(full_path))[0]
    rel_path = normalize_path(os.path.relpath(full_path, ws_root))

    # 1. 提炼标题
    title = ""
    title_match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    if title_match:
        raw_t = title_match.group(1)
        clean_t = re.sub(r"\[.*?受控记忆.*?\]", "", raw_t)
        title = re.sub(r"[#\*`]", "", clean_t).strip()
    if not title:
        title = f"{base_name}专题"

    standardized_title = title
    if not re.match(r"^\[.+\]\s+.+\s+&\s+.+$", title):
        standardized_title = f"[{base_name}专题] 核心功能维护 & 记忆沉淀"

    # 2. 提炼物理白名单
    allowlist = ""
    allow_match = re.search(r"(?:物理白名单|白名单范围|物理范围)[*:\s]+([^\n\r]+)", content, re.IGNORECASE)
    if allow_match:
        allowlist = allow_match.group(1).strip()

    initial_prompt_lines = [
        f"[{base_name}专题初始化] 你是 task-loop 项目的【{base_name}专题负责人】。",
        f"你负责维护本专题专属代码域与受控记忆文档 `{rel_path}`。"
    ]
    if allowlist:
        initial_prompt_lines.append(f"【物理白名单范围】: {allowlist}")
    initial_prompt_lines.append("【工作流规范】: 遵循子会话标准工作流（边界锁定 -> 白名单精准实施 -> 本地自测 -> 记忆回写 -> 结构化交付）。")

    return {
        "module_key": base_name,
        "memory_doc": rel_path,
        "title": standardized_title,
        "initialPrompt": "\n".join(initial_prompt_lines),
        "allowlist": allowlist
    }


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


def load_sessions_state(ws_root):
    sessions_path = os.path.join(ws_root, ".agents", "task-loop", "sessions.json")
    if os.path.exists(sessions_path):
        try:
            with open(sessions_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"schema_version": 2, "main_thread_id": None, "modules": {}, "sessions": []}


def save_sessions_state(state, ws_root):
    task_loop_dir = os.path.join(ws_root, ".agents", "task-loop")
    os.makedirs(task_loop_dir, exist_ok=True)

    sessions_path = os.path.join(task_loop_dir, "sessions.json")
    topics_path = os.path.join(task_loop_dir, "topics.json")

    state["updated_at"] = datetime.utcnow().isoformat() + "Z"
    with open(sessions_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    topics_data = {
        "schema_version": 2,
        "topics": [
            {
                "topic_key": k,
                "name": v.get("title"),
                "session_id": v.get("session_id"),
                "tags": v.get("tags", [k, "topic"]),
                "memory_doc": v.get("memory_doc")
            }
            for k, v in (state.get("modules") or {}).items()
        ]
    }
    with open(topics_path, "w", encoding="utf-8") as f:
        json.dump(topics_data, f, ensure_ascii=False, indent=2)


def create_topic_memory_doc(module_key, topic_title=None, options=None):
    if options is None:
        options = {}
    ws_root = options.get("ws_root") or os.getcwd()
    memory_dir = os.path.join(ws_root, "docs", "memory")
    os.makedirs(memory_dir, exist_ok=True)

    doc_path = os.path.join(memory_dir, f"{module_key}.md")
    rel_path = normalize_path(os.path.join("docs", "memory", f"{module_key}.md"))

    if not os.path.exists(doc_path) or options.get("force"):
        clean_title = topic_title or f"[{module_key}专题] 核心功能维护 & 记忆沉淀"
        doc_content = f"""# [专题受控记忆] {clean_title} ({module_key})

本文档为 `{module_key}` 专题的受控记忆文档，记录本专题的架构设计、物理白名单、核心逻辑与已证实事实。

---

## 一、专题架构与职责 (Architecture & Scope)
* **模块 Key**: `{module_key}`
* **专题职责**: 负责 {module_key} 专属领域的业务实现、接口治理与质量保障。
* **物理白名单范围**: `src/{module_key}/**/*`, `tests/test_{module_key}/**/*`

---

## 二、架构已知事实与决策 (Architectural Facts & Decisions)
* **已证实事实 1**: 专题受控记忆初始化已建立。
"""
        with open(doc_path, "w", encoding="utf-8") as f:
            f.write(doc_content)

    return {"doc_path": doc_path, "rel_path": rel_path}


def create_topic_and_session(module_key, topic_title=None, ws_root=None, options=None):
    if options is None:
        options = {}
    if ws_root is None:
        ws_root = os.getcwd()
    doc_info = create_topic_memory_doc(module_key, topic_title, {"ws_root": ws_root, "force": options.get("force")})
    return provision_single_doc(doc_info["doc_path"], ws_root, options)


def provision_single_doc(doc_path, ws_root, options=None):
    if options is None:
        options = {}
    meta = parse_memory_doc(doc_path, ws_root)
    state = load_sessions_state(ws_root)
    existing_module = (state.get("modules") or {}).get(meta["module_key"])

    if existing_module and existing_module.get("session_id") and not options.get("force"):
        return {
            "status": "EXISTS",
            "module_key": meta["module_key"],
            "session_id": existing_module.get("session_id"),
            "title": existing_module.get("title"),
            "memory_doc": meta["memory_doc"],
            "message": f"专题会话已存在 (ID: {existing_module.get('session_id')})。如需重新创建请使用 --force 参数。"
        }

    if options.get("dry_run"):
        return {
            "status": "DRY_RUN",
            "module_key": meta["module_key"],
            "title": meta["title"],
            "memory_doc": meta["memory_doc"],
            "message": f"[预览模式] 将创建顶层会话: \"{meta['title']}\" 并绑定至 {meta['memory_doc']}"
        }

    new_id = spawn_root_conversation(meta["title"], meta["initialPrompt"], ws_root)
    if not new_id:
        raise RuntimeError("创建顶层会话失败: agentapi new-conversation 调用未返回有效会话 ID")

    if "modules" not in state or state["modules"] is None:
        state["modules"] = {}
    state["modules"][meta["module_key"]] = {
        "session_id": new_id,
        "title": meta["title"],
        "tags": [meta["module_key"], "topic"],
        "memory_doc": meta["memory_doc"],
        "summary": f"专题模块: {meta['title']}"
    }

    if "sessions" not in state or state["sessions"] is None:
        state["sessions"] = []

    session_item = {
        "session_id": new_id,
        "vendor": "antigravity",
        "title": meta["title"],
        "is_main": False,
        "module_key": meta["module_key"],
        "summary": f"专题模块: {meta['title']}",
        "memory_docs": [meta["memory_doc"]]
    }

    existing_idx = next((i for i, s in enumerate(state["sessions"]) if s.get("module_key") == meta["module_key"]), -1)
    if existing_idx != -1:
        state["sessions"][existing_idx] = session_item
    else:
        state["sessions"].append(session_item)

    save_sessions_state(state, ws_root)

    return {
        "status": "CREATED",
        "module_key": meta["module_key"],
        "session_id": new_id,
        "title": meta["title"],
        "memory_doc": meta["memory_doc"],
        "message": f"✔ 成功创建顶层专题根会话 (ID: {new_id}) 并与 {meta['memory_doc']} 完成 1:1 绑定！"
    }


def survey_memory_docs_status(ws_root):
    memory_dir = os.path.join(ws_root, "docs", "memory")
    state = load_sessions_state(ws_root)
    existing_modules = state.get("modules") or {}

    all_docs = []
    if os.path.exists(memory_dir):
        files = [f for f in os.listdir(memory_dir) if f.endswith(".md")]
        for f in files:
            key = os.path.splitext(f)[0]
            mod = existing_modules.get(key)
            all_docs.append({
                "module_key": key,
                "memory_doc": normalize_path(os.path.join("docs", "memory", f)),
                "session_id": mod.get("session_id") if mod else None,
                "title": mod.get("title") if mod else f"[{key}专题] 核心功能维护 & 记忆沉淀",
                "is_aligned": bool(mod and mod.get("session_id"))
            })

    aligned = [d for d in all_docs if d["is_aligned"]]
    missing = [d for d in all_docs if not d["is_aligned"]]

    return {"all_docs": all_docs, "aligned": aligned, "missing": missing}


def provision_all_missing(ws_root, options=None):
    if options is None:
        options = {}
    memory_dir = os.path.join(ws_root, "docs", "memory")
    if not os.path.exists(memory_dir):
        return {"count": 0, "results": [], "message": "未找到 docs/memory 目录。"}

    survey = survey_memory_docs_status(ws_root)
    missing = survey["missing"]

    if not missing:
        return {
            "count": 0,
            "results": [],
            "message": "所有受控记忆文档 (docs/memory/*.md) 均已存在对应的专题会话，无缺失项。"
        }

    results = []
    for item in missing:
        res = provision_single_doc(item["memory_doc"], ws_root, options)
        results.append(res)

    return {
        "count": len(missing),
        "results": results,
        "message": f"共发现 {len(missing)} 个缺失会话的记忆文档，已全部补齐创建完成。"
    }


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args or "-d" in args
    force = "--force" in args or "-f" in args
    batch_all = "--all" in args or "-a" in args or "-y" in args or "--yes" in args

    ws_root = os.getcwd()
    if "--workspace" in args:
        idx = args.index("--workspace")
        if idx + 1 < len(args):
            ws_root = args[idx + 1]

    create_new_topic_key = None
    custom_title = None
    if "--create-topic" in args:
        idx = args.index("--create-topic")
        if idx + 1 < len(args):
            create_new_topic_key = args[idx + 1]
    if "--topic-title" in args:
        idx = args.index("--topic-title")
        if idx + 1 < len(args):
            custom_title = args[idx + 1]

    target_doc = None
    if "--doc" in args:
        idx = args.index("--doc")
        if idx + 1 < len(args):
            target_doc = args[idx + 1]
    elif "--topic" in args:
        idx = args.index("--topic")
        if idx + 1 < len(args):
            target_doc = os.path.join("docs", "memory", f"{args[idx + 1]}.md")

    print("=" * 80)
    print(" [new-session] 专题会话主动创建与受控记忆初始化 (Python 版)")
    print("=" * 80)
    print(f"工作区根路径: {normalize_path(ws_root)}")
    if dry_run:
        print("运行模式: [预览模式 (Dry-Run)]")

    if create_new_topic_key:
        print("模式: [新建专题模式] 同步创建受控记忆文档与独立顶层根会话")
        print(f"模块 Key: {create_new_topic_key}")
        if custom_title:
            print(f"自定义标题: {custom_title}")
        print("-" * 80)
        try:
            res = create_topic_and_session(create_new_topic_key, custom_title, ws_root, {"dry_run": dry_run, "force": force})
            print(f"状态: [{res['status']}]")
            print(f"专题标题: {res['title']}")
            print(f"记忆文档: {res['memory_doc']}")
            if res.get("session_id"):
                print(f"会话 ID: {res['session_id']}")
            print(f"提示: {res['message']}")
        except Exception as e:
            print(f"❌ 执行失败: {e}", file=sys.stderr)
            sys.exit(1)
    elif target_doc:
        print("模式: [指定文档模式] 读取既有受控记忆文档并拉起对应会话")
        print(f"目标受控记忆: {target_doc}")
        print("-" * 80)
        try:
            res = provision_single_doc(target_doc, ws_root, {"dry_run": dry_run, "force": force})
            print(f"状态: [{res['status']}]")
            print(f"模块 Key: {res['module_key']}")
            print(f"专题标题: {res['title']}")
            if res.get("session_id"):
                print(f"会话 ID: {res['session_id']}")
            print(f"提示: {res['message']}")
        except Exception as e:
            print(f"❌ 执行失败: {e}", file=sys.stderr)
            sys.exit(1)
    elif batch_all:
        print("模式: [全量补齐模式] 为所有未建物理会话的记忆文档批量创建会话")
        print("-" * 80)
        res = provision_all_missing(ws_root, {"dry_run": dry_run, "force": force})
        print(res["message"])
        for idx, r in enumerate(res.get("results", [])):
            print(f"\n[{idx + 1}] 模块: {r['module_key']}")
            print(f"    记忆文档: {r['memory_doc']}")
            print(f"    专题标题: {r['title']}")
            if r.get("session_id"):
                print(f"    会话 ID: {r['session_id']}")
            print(f"    处理状态: {r['status']}")
    else:
        print("模式: [专题对齐调查模式] 检查当前受控记忆与专题会话对齐状态")
        print("-" * 80)
        survey = survey_memory_docs_status(ws_root)

        print(f"【已完成 1:1 绑定的专题会话 ({len(survey['aligned'])} 个)】:")
        if survey["aligned"]:
            for i, a in enumerate(survey["aligned"]):
                print(f"  {i + 1}. [{a['module_key']}] {a['title']}")
                print(f"     记忆文档: {a['memory_doc']}")
                print(f"     会话 ID:  {a['session_id']}")
        else:
            print("  (暂无已绑定的专题会话)")

        print(f"\n【尚未建立物理会话的记忆文档清单 ({len(survey['missing'])} 个)】:")
        if survey["missing"]:
            for i, m in enumerate(survey["missing"]):
                print(f"  {i + 1}. [{m['module_key']}] {m['title']}")
                print(f"     记忆文档: {m['memory_doc']}")
                print("     状态: [⚠ 待建会话]")
            print("\n" + "-" * 80)
            print("【用户交互操作指引】:")
            print("若需为上述某个记忆文档创建专属专题会话，请执行:")
            print("  >> python scripts/new_topic_session.py --doc <记忆文档路径>")
            print("若需批量为所有缺失文档建立会话，请执行:")
            print("  >> python scripts/new_topic_session.py --all")
        else:
            print("  ✔ 所有现有受控记忆文档均已 1:1 绑定专题会话，无遗留缺失项。")
            print("\n" + "-" * 80)
            print("【新建全新专题提示】:")
            print("若您需要开辟全新业务领域专题（联动创建 docs/memory/<key>.md 与物理会话），请执行:")
            print("  >> python scripts/new_topic_session.py --create-topic <模块Key> --topic-title \"<专题名称>\"")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()
