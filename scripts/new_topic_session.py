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
import uuid
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "providers"))
import spawn_zcode_session as zcode_spawn
import task_loop_state as state_store
from codex_model_policy import apply_initial_model_config, build_create_thread_request
import codex_session_provider as codex_session_provider


def detect_topic_vendor(env=None, explicit_vendor=None):
    env = env if env is not None else os.environ
    return state_store.normalize_vendor(explicit_vendor) or state_store.normalize_vendor(state_store.detect_vendor(env))


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
    initial_prompt_lines.append("【工作流规范】: 遵循专题会话标准工作流（边界锁定 -> 白名单精准实施 -> 本地自测 -> 记忆回写 -> 结构化交付）。")

    return {
        "module_key": base_name,
        "memory_doc": rel_path,
        "title": standardized_title,
        "initialPrompt": "\n".join(initial_prompt_lines),
        "allowlist": allowlist
    }


def create_status(status, vendor, reason, **extra):
    result = {
        "status": status,
        "vendor": vendor,
        "submitted": False,
        "bound": False,
        "resumable": False,
        "physical_session": False,
        "reason": reason,
    }
    result.update(extra)
    return result


def created_status(vendor, session_id, id_kind, **extra):
    result = {
        "status": "CREATED",
        "vendor": vendor,
        "id": session_id,
        "id_kind": id_kind,
        "resumable": True,
        "physical_session": True,
    }
    result.update(extra)
    return result


def _formal_claude_session_id(result):
    if not isinstance(result, dict):
        return None
    value = result.get("session_id") or result.get("sessionId")
    return str(value).strip() if value is not None and str(value).strip() else None


def _spawn_claude_conversation(title, prompt, ws_root, env):
    requested_session_id = str(uuid.uuid4())
    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--session-id", requested_session_id, "--output-format", "json"],
            env=env,
            cwd=ws_root,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except FileNotFoundError:
        return create_status("UNSUPPORTED", "claude", "Claude CLI is unavailable; no physical session was created")
    except Exception as error:
        return create_status("CREATION_FAILED", "claude", f"Claude CLI launch failed: {error}")
    if result.returncode != 0:
        return create_status("CREATION_FAILED", "claude", f"Claude CLI exited {result.returncode}")
    try:
        data = json.loads(result.stdout or "")
    except json.JSONDecodeError:
        return create_status("CREATION_FAILED", "claude", "Claude CLI returned non-JSON output; no physical session ID was confirmed")
    session_id = _formal_claude_session_id(data)
    if not session_id:
        return create_status("CREATION_FAILED", "claude", "Claude CLI did not return a formal session_id")
    return created_status("claude", session_id, "sessionId", title=title)


def spawn_root_conversation(title, prompt, ws_root, options=None):
    """按明确厂商创建根会话；失败、待宿主创建和不支持均不写入绑定状态。"""
    options = options or {}
    env = dict(os.environ)
    current_vendor = detect_topic_vendor(env, options.get("vendor"))
    if not current_vendor:
        return create_status("UNSUPPORTED", None, "No supported host vendor was identified")

    if current_vendor == "codex":
        request = build_create_thread_request(
            project_id=options.get("project_id"),
            is_git_repository=options.get("is_git_repository"),
            environment=options.get("environment"),
            title=title,
            prompt=prompt,
            role=options.get("role") or "topic",
            model=options.get("model"),
            reasoning_effort=options.get("reasoning_effort"),
            thinking=options.get("thinking"),
        )
        result = codex_session_provider.create(request, options.get("capabilities"), dry_run=options.get("dry_run", False))
        if result.get("status") == "PENDING_CREATION":
            pending = dict(result)
            pending.update({"vendor": "codex", "creation_request": request})
            print(json.dumps(pending, ensure_ascii=False, indent=2), file=sys.stderr)
            return pending
        if result.get("status") == "READY" and result.get("threadId"):
            return created_status("codex", result["threadId"], "threadId", creation_result=result, model_config=request)
        return create_status(
            "CREATION_FAILED" if result.get("status") == "CREATION_FAILED" else "UNSUPPORTED",
            "codex",
            result.get("reason"),
            creation_request=request,
            creation_result=result,
        )

    for k in ["ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_SOURCE_METADATA", "ANTIGRAVITY_TRAJECTORY_ID"]:
        env.pop(k, None)

    if current_vendor == "claude":
        return _spawn_claude_conversation(title, prompt, ws_root, env)

    if current_vendor == "antigravity":
        agentapi = _find_agentapi(env)
        if not agentapi:
            return create_status("UNSUPPORTED", "antigravity", "agentapi is unavailable; no physical session was created")
        is_win = sys.platform == "win32"
        safe_title = f'"{str(title or "").replace(chr(34), chr(34)*2)}"' if is_win else title
        safe_prompt = f'"{str(prompt or "").replace(chr(34), chr(34)*2)}"' if is_win else prompt
        title_arg = f"--title={safe_title}" if is_win else f"--title={title}"
        cmd = [agentapi, "new-conversation", title_arg, safe_prompt]
        try:
            res = subprocess.run(cmd, env=env, cwd=ws_root, shell=True, capture_output=True, text=True, encoding="utf-8")
            if res.returncode != 0:
                return create_status("CREATION_FAILED", "antigravity", f"agentapi exited {res.returncode}")
            data = json.loads(res.stdout or "")
            cid = data.get("response", {}).get("newConversation", {}).get("conversationId")
            if cid:
                return created_status("antigravity", str(cid), "conversationId", title=title)
            return create_status("CREATION_FAILED", "antigravity", "agentapi returned no formal conversationId")
        except json.JSONDecodeError:
            return create_status("CREATION_FAILED", "antigravity", "agentapi returned non-JSON output")
        except Exception as error:
            return create_status("CREATION_FAILED", "antigravity", f"agentapi creation failed: {error}")

    if current_vendor == "zcode":
        cli = zcode_spawn.discover_zcode_cli(env)
        if not cli:
            return create_status("UNSUPPORTED", "zcode", "ZCode CLI is unavailable; no physical session was created")
        auth = zcode_spawn.auth_state(env)
        if not auth["logged_in"]:
            return create_status("UNSUPPORTED", "zcode", "ZCode CLI is not authenticated; no physical session was created")
        try:
            out = zcode_spawn.run_cli(cli, ["--cwd", ws_root, "-p", prompt], 600, env)
            sid = zcode_spawn.extract_session_id(out)
            if sid:
                return created_status("zcode", sid, "sessionId", title=title)
            return create_status("CREATION_FAILED", "zcode", "ZCode CLI returned no formal session ID")
        except Exception as err:
            return create_status("CREATION_FAILED", "zcode", f"ZCode CLI creation failed: {str(err).split(chr(10))[0]}")

    return create_status("UNSUPPORTED", current_vendor, f"No creation adapter is implemented for vendor {current_vendor}")


def _find_agentapi(env):
    override = env.get("AGENTAPI_PATH")
    if override is not None:
        return override if os.path.exists(override) else None
    home = os.path.expanduser("~")
    candidates = (
        os.path.join(home, ".gemini", "antigravity", "bin", "agentapi.bat"),
        os.path.join(home, ".gemini", "antigravity", "bin", "agentapi.cmd"),
        os.path.join(home, ".gemini", "antigravity", "bin", "agentapi.exe"),
        os.path.join(home, ".gemini", "antigravity", "bin", "agentapi"),
        os.path.join(home, ".antigravity", "bin", "agentapi.bat"),
        os.path.join(home, ".antigravity", "bin", "agentapi.cmd"),
        os.path.join(home, ".antigravity", "bin", "agentapi.exe"),
        os.path.join(home, ".antigravity", "bin", "agentapi"),
    )
    for c in candidates:
        if os.path.exists(c):
            return c

    # Windows where / Unix which
    which_cmd = "where" if sys.platform == "win32" else "which"
    try:
        res = subprocess.run([which_cmd, "agentapi"], capture_output=True, text=True, encoding="utf-8")
        if res.stdout:
            first = res.stdout.strip().splitlines()[0].strip()
            if first and os.path.exists(first):
                return first
    except Exception:
        pass

    return None


def load_sessions_state(ws_root, vendor_override=None):
    # Schema v4: 仅读取当前宿主厂商分区 (跨版本兼容读, 其余厂商分区零接触)
    vendor = detect_topic_vendor(os.environ, vendor_override) or "antigravity"
    sessions_path = os.path.join(ws_root, ".agents", "task-loop", "sessions.json")
    part = state_store.get_partition(sessions_path, vendor)
    base = {"schema_version": state_store.SCHEMA_VERSION, "vendor": vendor, "main_thread_id": None, "modules": {}, "sessions": []}
    if part:
        base.update(part)
    return base


def save_sessions_state(state, ws_root, vendor_override=None):
    # Schema v4: 只写当前宿主厂商分区 (读-改-写), 其余厂商分区零接触, 结构上杜绝跨厂商覆写
    task_loop_dir = os.path.join(ws_root, ".agents", "task-loop")
    os.makedirs(task_loop_dir, exist_ok=True)

    vendor = detect_topic_vendor(os.environ, vendor_override or state.get("vendor")) or "antigravity"
    sessions_path = os.path.join(task_loop_dir, "sessions.json")
    topics_path = os.path.join(task_loop_dir, "topics.json")

    modules = {}
    for key, value in (state.get("modules") or {}).items():
        module = dict(value) if isinstance(value, dict) else {}
        has_physical_id = bool(module.get("session_id") and str(module.get("session_id")).strip())
        resumable = module.get("resumable") is True and has_physical_id
        module.update({
            "vendor": vendor,
            "resumable": resumable,
            "lifecycle_status": module.get("lifecycle_status") or (state_store.SESSION_STATUS["BOUND"] if resumable else state_store.SESSION_STATUS["PENDING_CREATION"]),
            "is_main": module.get("is_main") is True or key == "main" or (state.get("main_thread_id") and module.get("session_id") == state.get("main_thread_id")),
        })
        modules[key] = module

    sessions = []
    for value in state.get("sessions") or []:
        session = dict(value) if isinstance(value, dict) else {}
        has_physical_id = bool(session.get("session_id") and str(session.get("session_id")).strip())
        resumable = session.get("resumable") is True and has_physical_id
        session.update({
            "vendor": vendor,
            "resumable": resumable,
            "lifecycle_status": session.get("lifecycle_status") or (state_store.SESSION_STATUS["BOUND"] if resumable else state_store.SESSION_STATUS["PENDING_CREATION"]),
        })
        sessions.append(session)

    partition_data = {
        "main_thread_id": state.get("main_thread_id"),
        "modules": modules,
        "sessions": sessions,
    }
    state_store.write_partition(sessions_path, vendor, partition_data, {"kind": "sessions"})

    topics = [{
            "topic_key": k,
            "name": v.get("title"),
            "session_id": v.get("session_id"),
            "vendor": vendor,
            "resumable": v.get("resumable") is True and bool(v.get("session_id")),
            "lifecycle_status": v.get("lifecycle_status"),
            "is_main": v.get("is_main") is True,
            "id_kind": v.get("id_kind"),
            "tags": v.get("tags", [k, "topic"]),
            "memory_doc": v.get("memory_doc"),
        }
        for k, v in modules.items()
    ]
    state_store.write_partition(topics_path, vendor, {"topics": topics}, {"kind": "topics"})

    # 兼容镜像: 物理分区文件供旧版宿主工具直读
    mirror = {"schema_version": 3, "vendor": vendor, "updated_at": datetime.utcnow().isoformat() + "Z"}
    mirror.update(json.loads(json.dumps(partition_data)))
    with open(os.path.join(task_loop_dir, f"sessions.{vendor}.json"), "w", encoding="utf-8") as f:
        json.dump(mirror, f, ensure_ascii=False, indent=2)
    topics_mirror = {"schema_version": 3, "vendor": vendor, "updated_at": datetime.utcnow().isoformat() + "Z", "topics": topics}
    with open(os.path.join(task_loop_dir, f"topics.{vendor}.json"), "w", encoding="utf-8") as f:
        json.dump(topics_mirror, f, ensure_ascii=False, indent=2)


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


def normalize_bound_session(vendor, session_id, options=None):
    options = options or {}
    if not session_id:
        raise ValueError(f"绑定失败: vendor={vendor} 未提供有效物理会话 ID")
    if vendor == "codex" and (options.get("clientThreadId") or options.get("client_thread_id") or options.get("id_kind") == "clientThreadId"):
        raise ValueError("绑定失败: Codex 只能绑定正式 threadId，不能绑定 clientThreadId")
    normalized_id = str(session_id).strip()
    if not normalized_id:
        raise ValueError(f"绑定失败: vendor={vendor} 未提供有效物理会话 ID")
    if vendor == "codex":
        declared_id_kind = options.get("id_kind") or options.get("idKind")
        provider_result = options.get("provider_result") or options.get("providerResult")
        provider_id = codex_session_provider.formal_create_thread_id(provider_result)
        if declared_id_kind != "threadId" and provider_id != normalized_id:
            raise ValueError("绑定失败: Codex 需要调用方明确声明 id_kind=threadId，或提供已确认 formal threadId 的 Provider 回执")
        if options.get("clientThreadId") or options.get("client_thread_id"):
            raise ValueError("绑定失败: Codex 只能绑定正式 threadId，不能绑定 clientThreadId")
    id_kind = "threadId" if vendor == "codex" else ("conversationId" if vendor == "antigravity" else "sessionId")
    return normalized_id, id_kind


def is_reusable_module(vendor, module):
    if not isinstance(module, dict) or not module.get("session_id") or module.get("resumable") is not True:
        return False
    return vendor != "codex" or module.get("id_kind") == "threadId"


def bind_current_session(module_key, topic_title=None, session_id=None, ws_root=None, options=None):
    """将当前物理会话就地注册并绑定为专题会话 (无需新建顶层会话)"""
    if options is None:
        options = {}
    if not session_id:
        raise ValueError("就地绑定专题失败: 必须提供有效的 session_id")
    if ws_root is None:
        ws_root = os.getcwd()

    vendor = detect_topic_vendor(os.environ, options.get("vendor")) or "antigravity"
    session_id, id_kind = normalize_bound_session(vendor, session_id, options)
    doc_info = create_topic_memory_doc(module_key, topic_title, {"ws_root": ws_root, "force": options.get("force")})
    meta = parse_memory_doc(doc_info["doc_path"], ws_root)
    state = load_sessions_state(ws_root, vendor)
    existing_module = (state.get("modules") or {}).get(meta["module_key"])
    existing_model_config = existing_module.get("model_config") if isinstance(existing_module, dict) else None
    is_main = meta["module_key"] == "main" or state.get("main_thread_id") == session_id

    if options.get("dry_run"):
        return {
            "status": "DRY_RUN",
            "module_key": meta["module_key"],
            "session_id": session_id,
            "title": meta["title"],
            "memory_doc": meta["memory_doc"],
            "message": f"[预览模式] 将把当前会话 (ID: {session_id}) 就地注册为专题 \"{meta['title']}\" 并绑定至 {meta['memory_doc']}"
        }

    if "modules" not in state or state["modules"] is None:
        state["modules"] = {}
    state["modules"][meta["module_key"]] = {
        "session_id": session_id,
        "vendor": vendor,
        "id_kind": id_kind,
        "resumable": True,
        "physical_session": True,
        "lifecycle_status": state_store.SESSION_STATUS["BOUND"],
        "is_main": is_main,
        "title": meta["title"],
        "tags": [meta["module_key"], "topic"],
        "memory_doc": meta["memory_doc"],
        "summary": f"专题模块: {meta['title']}",
        **({"model_config": existing_model_config or apply_initial_model_config({"module_key": meta["module_key"]}, "topic")["model_config"]} if vendor == "codex" else {}),
    }

    if "sessions" not in state or state["sessions"] is None:
        state["sessions"] = []

    session_item = {
        "session_id": session_id,
        "vendor": vendor,
        "id_kind": id_kind,
        "resumable": True,
        "physical_session": True,
        "lifecycle_status": state_store.SESSION_STATUS["BOUND"],
        "title": meta["title"],
        "is_main": is_main,
        "module_key": meta["module_key"],
        "summary": f"专题模块: {meta['title']}",
        "memory_docs": [meta["memory_doc"]],
        **({"model_config": existing_model_config or apply_initial_model_config({"module_key": meta["module_key"]}, "topic")["model_config"]} if vendor == "codex" else {}),
    }

    existing_idx = next((i for i, s in enumerate(state["sessions"]) if s.get("module_key") == meta["module_key"] or s.get("session_id") == session_id), -1)
    if existing_idx != -1:
        state["sessions"][existing_idx] = session_item
    else:
        state["sessions"].append(session_item)

    if is_main:
        state["main_thread_id"] = session_id
    save_sessions_state(state, ws_root, vendor)

    return {
        "status": "BOUND",
        "module_key": meta["module_key"],
        "session_id": session_id,
        "title": meta["title"],
        "memory_doc": meta["memory_doc"],
        "message": f"✔ 成功将当前物理会话 (vendor: {vendor}, ID: {session_id}) 就地注册为专题 \"{meta['title']}\" 并与 {meta['memory_doc']} 完成 1:1 绑定！"
    }


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
    vendor = detect_topic_vendor(os.environ, options.get("vendor")) or "antigravity"
    state = load_sessions_state(ws_root, vendor)
    existing_module = (state.get("modules") or {}).get(meta["module_key"])

    if is_reusable_module(vendor, existing_module) and not options.get("force"):
        return {
            "status": "EXISTS",
            "vendor": vendor,
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

    new_id = spawn_root_conversation(meta["title"], meta["initialPrompt"], ws_root, {
        **options,
        "vendor": vendor,
        "role": options.get("role") or ("main" if meta["module_key"] == "main" else "topic"),
        **({
            "model": options.get("model") or (existing_module.get("model_config") or {}).get("model"),
            "reasoning_effort": options.get("reasoning_effort") or (existing_module.get("model_config") or {}).get("reasoning_effort"),
            "thinking": options.get("thinking") or (existing_module.get("model_config") or {}).get("thinking"),
        } if existing_module and existing_module.get("model_config") else {}),
    })
    if not new_id or new_id.get("status") != "CREATED" or not new_id.get("id"):
        result = dict(new_id or create_status("CREATION_FAILED", vendor, "创建适配器未返回结果"))
        result.update({
            "module_key": meta["module_key"],
            "title": meta["title"],
            "memory_doc": meta["memory_doc"],
            "message": result.get("reason") or "未返回有效物理会话 ID；未写入绑定状态",
        })
        return result

    is_main = meta["module_key"] == "main" or state.get("main_thread_id") == new_id["id"]

    if "modules" not in state or state["modules"] is None:
        state["modules"] = {}
    state["modules"][meta["module_key"]] = {
        "session_id": new_id["id"],
        "vendor": new_id["vendor"],
        "id_kind": new_id.get("id_kind"),
        "resumable": True,
        "physical_session": True,
        "lifecycle_status": state_store.SESSION_STATUS["BOUND"],
        "is_main": is_main,
        "title": meta["title"],
        "tags": [meta["module_key"], "topic"],
        "memory_doc": meta["memory_doc"],
        "summary": f"专题模块: {meta['title']}",
        **({"model_config": new_id.get("model_config")} if new_id.get("model_config") else {}),
    }

    if "sessions" not in state or state["sessions"] is None:
        state["sessions"] = []

    session_item = {
        "session_id": new_id["id"],
        "vendor": new_id["vendor"],
        "id_kind": new_id.get("id_kind"),
        "resumable": True,
        "physical_session": True,
        "lifecycle_status": state_store.SESSION_STATUS["BOUND"],
        "title": meta["title"],
        "is_main": is_main,
        "module_key": meta["module_key"],
        "summary": f"专题模块: {meta['title']}",
        "memory_docs": [meta["memory_doc"]],
        **({"model_config": new_id.get("model_config")} if new_id.get("model_config") else {}),
    }

    existing_idx = next((i for i, s in enumerate(state["sessions"]) if s.get("module_key") == meta["module_key"]), -1)
    if existing_idx != -1:
        state["sessions"][existing_idx] = session_item
    else:
        state["sessions"].append(session_item)

    if is_main:
        state["main_thread_id"] = new_id["id"]
    save_sessions_state(state, ws_root, vendor)

    return {
        "status": "CREATED",
        "module_key": meta["module_key"],
        "session_id": new_id["id"],
        "title": meta["title"],
        "memory_doc": meta["memory_doc"],
        "message": f"✔ 成功创建顶层专题根会话 (vendor: {new_id['vendor']}, ID: {new_id['id']}) 并与 {meta['memory_doc']} 完成 1:1 绑定！"
    }


def survey_memory_docs_status(ws_root, options=None):
    options = options or {}
    memory_dir = os.path.join(ws_root, "docs", "memory")
    vendor = detect_topic_vendor(os.environ, options.get("vendor")) or "antigravity"
    state = load_sessions_state(ws_root, vendor)
    existing_modules = state.get("modules") or {}

    all_docs = []
    if os.path.exists(memory_dir):
        files = [f for f in os.listdir(memory_dir) if f.endswith(".md")]
        for f in files:
            key = os.path.splitext(f)[0]
            mod = existing_modules.get(key)
            is_bound = is_reusable_module(vendor, mod)
            lifecycle_status = (mod.get("lifecycle_status") if isinstance(mod, dict) else None) or (state_store.SESSION_STATUS["BOUND"] if is_bound else state_store.SESSION_STATUS["PENDING_CREATION"])
            all_docs.append({
                "module_key": key,
                "vendor": vendor,
                "memory_doc": normalize_path(os.path.join("docs", "memory", f)),
                "session_id": mod.get("session_id") if mod else None,
                "title": mod.get("title") if mod else f"[{key}专题] 核心功能维护 & 记忆沉淀",
                "lifecycle_status": lifecycle_status,
                "status": lifecycle_status,
                "is_aligned": is_bound,
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

    survey = survey_memory_docs_status(ws_root, options)
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
        "message": f"共发现 {len(missing)} 个未完成绑定的记忆文档，已按厂商能力返回创建结果。"
    }


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args or "-d" in args
    force = "--force" in args or "-f" in args
    batch_all = "--all" in args or "-a" in args or "-y" in args or "--yes" in args
    vendor = None
    if "--vendor" in args:
        idx = args.index("--vendor")
        if idx + 1 < len(args):
            vendor = state_store.normalize_vendor(args[idx + 1])
    vendor = vendor or detect_topic_vendor()

    ws_root = os.getcwd()
    if "--workspace" in args:
        idx = args.index("--workspace")
        if idx + 1 < len(args):
            ws_root = args[idx + 1]

    bind_current = "--bind-current" in args
    bind_current_session_id = None
    if bind_current:
        idx = args.index("--bind-current")
        if idx + 1 < len(args) and not args[idx + 1].startswith("-"):
            bind_current_session_id = args[idx + 1]

    if not bind_current_session_id and "--session" in args:
        idx = args.index("--session")
        if idx + 1 < len(args):
            bind_current_session_id = args[idx + 1]

    if not bind_current_session_id and "--session-id" in args:
        idx = args.index("--session-id")
        if idx + 1 < len(args):
            bind_current_session_id = args[idx + 1]

    if not bind_current_session_id and bind_current:
        bind_current_session_id = state_store.get_current_session_id(os.environ, vendor)
    bind_id_kind = None
    if "--id-kind" in args:
        idx = args.index("--id-kind")
        if idx + 1 < len(args):
            bind_id_kind = args[idx + 1]

    is_bind_current = bind_current or bool(bind_current_session_id)

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

    if is_bind_current:
        print("模式: [就地注册模式] 将当前/指定物理会话就地注册并绑定为专题会话")
        if not bind_current_session_id:
            print("❌ 执行失败: 必须指定 --bind-current <session_id> 或 --session-id <session_id>", file=sys.stderr)
            sys.exit(1)
        print(f"目标物理会话 ID: {bind_current_session_id}")
        target_key = create_new_topic_key or (os.path.splitext(os.path.basename(target_doc))[0] if target_doc else None)
        if not target_key:
            print("❌ 执行失败: 就地注册模式下必须指定 --create-topic <模块Key> 或 --doc <记忆文档路径>", file=sys.stderr)
            sys.exit(1)
        print(f"模块 Key: {target_key}")
        if custom_title:
            print(f"自定义标题: {custom_title}")
        print("-" * 80)
        try:
            res = bind_current_session(target_key, custom_title, bind_current_session_id, ws_root, {
                "dry_run": dry_run,
                "force": force,
                "vendor": vendor,
                "id_kind": bind_id_kind,
            })
            print(f"状态: [{res['status']}]")
            print(f"专题标题: {res['title']}")
            print(f"记忆文档: {res['memory_doc']}")
            print(f"会话 ID: {res['session_id']}")
            print(f"提示: {res['message']}")
        except Exception as e:
            print(f"❌ 执行失败: {e}", file=sys.stderr)
            sys.exit(1)
    elif create_new_topic_key:
        print("模式: [新建专题模式] 同步创建受控记忆文档与独立顶层根会话")
        print(f"模块 Key: {create_new_topic_key}")
        if custom_title:
            print(f"自定义标题: {custom_title}")
        print("-" * 80)
        try:
            res = create_topic_and_session(create_new_topic_key, custom_title, ws_root, {"dry_run": dry_run, "force": force, "vendor": vendor})
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
            res = provision_single_doc(target_doc, ws_root, {"dry_run": dry_run, "force": force, "vendor": vendor})
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
        res = provision_all_missing(ws_root, {"dry_run": dry_run, "force": force, "vendor": vendor})
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
        survey = survey_memory_docs_status(ws_root, {"vendor": vendor})

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
                print(f"     状态: [{m['status']}]")
            print("\n" + "-" * 80)
            print("【用户交互操作指引】:")
            print("若需为上述某个记忆文档创建专属专题会话，请执行:")
            print("  >> python scripts/new_topic_session.py --doc <记忆文档路径>")
            print("若需将当前非主会话直接就地注册绑定为该专题会话，请执行:")
            print("  >> python scripts/new_topic_session.py --doc <记忆文档路径> --bind-current <当前会话ID>")
            print("若需批量为所有缺失文档建立会话，请执行:")
            print("  >> python scripts/new_topic_session.py --all")
        else:
            print("  ✔ 所有现有受控记忆文档均已 1:1 绑定专题会话，无遗留缺失项。")
            print("\n" + "-" * 80)
            print("【新建全新专题提示】:")
            print("若您需要开辟全新业务领域专题（联动创建 docs/memory/<key>.md 与物理会话），请执行:")
            print("  >> python scripts/new_topic_session.py --create-topic <模块Key> --topic-title \"<专题名称>\"")
            print("若在当前会话中就地注册新专题，请执行:")
            print("  >> python scripts/new_topic_session.py --create-topic <模块Key> --topic-title \"<专题名称>\" --bind-current <当前会话ID>")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()
