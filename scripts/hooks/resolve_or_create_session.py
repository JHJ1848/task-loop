#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[Hook Script] Resolve or Auto-Create Topic Session (PreToolUse) - Python 3.8+

Google Antigravity PreToolUse Hook for send_message
1. 拦截 send_message 工具调用；
2. 防御检查：若 Recipient 是有效已存在 UUID，直接放行；
3. 别名解析：若 Recipient 为专题别名（如 "hook", "session_control", "subagent"），检查 sessions.json；
4. 幂等复用与防重复创建：若 sessions.json 中已存在该专题的活跃未归档会话，通过 overwrite.Recipient 动态复用；
5. 归档检测：若既有会话已标记归档 (archived: true / status: "archived")，视同已删除，允许重新拉起新专题会话；
6. 自动拉起：调用 agentapi new-conversation 拉起顶层独立会话，登记 sessions.json，并 overwrite 替换；
7. 兜底策略：若拉起失败或环境不支持，安全拦截并输出引导错误信息，杜绝宿主崩溃与误拉起。

Input: stdin JSON ({ toolCall: { name, args: { Recipient, Message } }, conversationId, workspacePaths, ... })
Output: stdout JSON ({ decision: "allow" | "deny", reason?: string, overwrite?: { Recipient: string } })
"""

import sys
import os
import re
import json
import subprocess
from datetime import datetime

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

UUID_PATTERN = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

KNOWN_TOPICS = {
    "hook": {
        "title": "[钩子专题] Hooks体系 & 状态拦截",
        "memory_doc": "docs/memory/hook.md"
    },
    "session_control": {
        "title": "[会话专题] SDK接口封装 & 会话管理",
        "memory_doc": "docs/memory/session_control.md"
    },
    "session": {
        "alias_for": "session_control"
    },
    "subagent": {
        "title": "[子代理专题] Subagent机制 & 动态模板",
        "memory_doc": "docs/memory/subagent.md"
    },
    "dispatch": {
        "title": "[调度专题] 复杂度裁决 & 派单协议",
        "memory_doc": "docs/memory/dispatch.md"
    },
    "memory": {
        "title": "[记忆专题] 受控记忆 & 知识沉淀",
        "memory_doc": "docs/MEMORY.md"
    }
}


def resolve_workspace_root(workspace_paths):
    if workspace_paths and isinstance(workspace_paths, list) and len(workspace_paths) > 0:
        return workspace_paths[0]
    return os.getcwd()


def find_sessions_registry(ws_root):
    candidates = [
        os.path.join(ws_root, ".agents", "task-loop", "sessions.json"),
        os.path.join(ws_root, ".agents", "sessions.json"),
        os.path.join(os.getcwd(), ".agents", "task-loop", "sessions.json")
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                with open(c, "r", encoding="utf-8") as f:
                    return {"path": c, "data": json.load(f)}
            except Exception:
                pass
    return None


def is_session_active(session_item):
    if not session_item or not isinstance(session_item, dict):
        return False
    if session_item.get("archived") is True or session_item.get("status") in ["archived", "deleted"]:
        return False
    return True


def find_agent_api_binary():
    env_path = os.environ.get("AGENTAPI_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    home_dir = os.path.expanduser("~")
    candidates = [
        os.path.join(home_dir, ".gemini", "antigravity", "bin", "agentapi.exe"),
        os.path.join(home_dir, ".gemini", "antigravity", "bin", "agentapi"),
        os.path.join(home_dir, ".antigravity", "bin", "agentapi.exe"),
        os.path.join(home_dir, ".antigravity", "bin", "agentapi")
    ]
    for c in candidates:
        if os.path.exists(c):
            return c

    try:
        cmd = "where.exe agentapi" if sys.platform == "win32" else "which agentapi"
        out = subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL, text=True).strip()
        first_line = out.splitlines()[0] if out else ""
        if first_line and os.path.exists(first_line):
            return first_line
    except Exception:
        pass
    return None


def normalize_topic_key(key):
    if not key or not isinstance(key, str):
        return ""
    cleaned = key.strip().lower()
    cleaned = re.sub(r"^(topic|module):", "", cleaned)
    if cleaned in KNOWN_TOPICS and "alias_for" in KNOWN_TOPICS[cleaned]:
        cleaned = KNOWN_TOPICS[cleaned]["alias_for"]
    return cleaned


def create_topic_session_via_agent_api(agent_api_path, topic_key, topic_meta):
    title = topic_meta.get("title", f"[{topic_key}专题] 领域研发")
    init_prompt = f"[{topic_key}专题初始化] 你是 task-loop 项目的【{topic_key}专题负责人】(topic: {topic_key})。请阅读 {topic_meta.get('memory_doc', '相关记忆文档')} 并承接任务。"

    last_error = None
    for attempt in range(1, 3):
        try:
            cmd = [agent_api_path, "new-conversation", f"--title={title}", init_prompt]
            out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, timeout=8).strip()
            if UUID_PATTERN.match(out):
                return {"success": True, "conversationId": out, "title": title}

            try:
                parsed = json.loads(out)
                new_id = parsed.get("conversationId") or parsed.get("conversation_id") or parsed.get("id")
                if new_id:
                    return {"success": True, "conversationId": new_id, "title": title}
            except Exception:
                match = re.search(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", out)
                if match:
                    return {"success": True, "conversationId": match.group(0), "title": title}

            last_error = f"未能从 agentapi 输出中提取有效 UUID: {out}"
        except Exception as e:
            last_error = str(e)

    return {"success": False, "error": last_error or "拉起会话超时或执行异常"}


def process_payload(payload):
    try:
        tool_call = payload.get("toolCall")
        if not tool_call or tool_call.get("name") != "send_message":
            return {"decision": "allow"}

        args = tool_call.get("args") or {}
        recipient = str(args.get("Recipient") or args.get("recipient") or "").strip()

        if not recipient:
            return {"decision": "deny", "reason": "[Session Resolver] send_message 缺少必填参数 Recipient。"}

        ws_root = resolve_workspace_root(payload.get("workspacePaths"))
        registry_obj = find_sessions_registry(ws_root)

        # 1. 规范 UUID 处理
        if UUID_PATTERN.match(recipient):
            if registry_obj:
                sessions = registry_obj["data"].get("sessions", [])
                for s in sessions:
                    if s.get("session_id") == recipient:
                        if not is_session_active(s):
                            return {
                                "decision": "deny",
                                "reason": f"[Session Resolver] 目标会话 '{recipient}' 已归档 (Archived)。已归档会话不可再接收新消息，请使用专题别名自动拉起新会话。"
                            }
                        break
            return {"decision": "allow"}

        # 2. 专题别名校验
        topic_key = normalize_topic_key(recipient)
        known_meta = KNOWN_TOPICS.get(topic_key)

        is_configured = bool(known_meta)
        if registry_obj and "modules" in registry_obj["data"] and topic_key in registry_obj["data"]["modules"]:
            is_configured = True

        if not is_configured:
            return {
                "decision": "deny",
                "reason": f"[Session Resolver] 拦截未知目标 '{recipient}'！未在已知专题清单中注册。为避免误拉起无用会话，请使用合法专题别名 (如 hook, session_control, subagent) 或直接传入有效会话 UUID。"
            }

        # 3. 幂等复用与防重复（排除已归档）
        if registry_obj and "modules" in registry_obj["data"] and topic_key in registry_obj["data"]["modules"]:
            mod_entry = registry_obj["data"]["modules"][topic_key]
            existing_id = mod_entry.get("session_id")
            if existing_id and UUID_PATTERN.match(existing_id):
                sessions = registry_obj["data"].get("sessions", [])
                s_item = next((s for s in sessions if s.get("session_id") == existing_id), None)
                if is_session_active(s_item) and is_session_active(mod_entry):
                    return {"decision": "allow", "overwrite": {"Recipient": existing_id}}

        # 检查 sessions 列表中活跃且匹配的会话
        if registry_obj and isinstance(registry_obj["data"].get("sessions"), list):
            for s in registry_obj["data"]["sessions"]:
                if is_session_active(s) and s.get("title") and topic_key in s["title"].lower():
                    s_id = s.get("session_id")
                    if s_id:
                        if "modules" not in registry_obj["data"]:
                            registry_obj["data"]["modules"] = {}
                        registry_obj["data"]["modules"][topic_key] = {
                            "session_id": s_id,
                            "title": s.get("title"),
                            "memory_doc": (known_meta.get("memory_doc") if known_meta else f"docs/memory/{topic_key}.md")
                        }
                        try:
                            with open(registry_obj["path"], "w", encoding="utf-8") as f:
                                json.dump(registry_obj["data"], f, indent=2, ensure_ascii=False)
                        except Exception:
                            pass
                        return {"decision": "allow", "overwrite": {"Recipient": s_id}}

        # 4. 自动拉起流程
        agent_api_path = find_agent_api_binary()
        if not agent_api_path:
            return {
                "decision": "deny",
                "reason": f"[Session Resolver] 目标专题 '{topic_key}' 尚未初始化（或旧会话已归档），且当前环境未找到 'agentapi' 工具。请先在终端运行初始化脚本或由主会话使用 invoke_subagent 创建临时子代理。"
            }

        topic_meta = known_meta or {"title": f"[{topic_key}专题] 领域研发", "memory_doc": f"docs/memory/{topic_key}.md"}
        create_res = create_topic_session_via_agent_api(agent_api_path, topic_key, topic_meta)
        if not create_res.get("success"):
            return {
                "decision": "deny",
                "reason": f"[Session Resolver] 自动拉起专题会话 '{topic_key}' 失败: {create_res.get('error')}。请检查宿主 agentapi 状态。"
            }

        new_session_id = create_res["conversationId"]

        # 更新 sessions.json
        if registry_obj:
            if "modules" not in registry_obj["data"]:
                registry_obj["data"]["modules"] = {}
            registry_obj["data"]["modules"][topic_key] = {
                "session_id": new_session_id,
                "title": create_res["title"],
                "memory_doc": topic_meta.get("memory_doc")
            }
            if "sessions" not in registry_obj["data"]:
                registry_obj["data"]["sessions"] = []

            for s in registry_obj["data"]["sessions"]:
                if s.get("session_id") != new_session_id and s.get("title") and topic_key in s.get("title", "").lower():
                    s["archived"] = True
                    s["archived_at"] = datetime.utcnow().isoformat() + "Z"

            registry_obj["data"]["sessions"].append({
                "session_id": new_session_id,
                "vendor": "antigravity",
                "title": create_res["title"],
                "is_main": False,
                "archived": False,
                "created_at": datetime.utcnow().isoformat() + "Z",
                "last_active_at": datetime.utcnow().isoformat() + "Z",
                "memory_docs": [topic_meta.get("memory_doc")]
            })

            try:
                with open(registry_obj["path"], "w", encoding="utf-8") as f:
                    json.dump(registry_obj["data"], f, indent=2, ensure_ascii=False)
            except Exception:
                pass

        return {"decision": "allow", "overwrite": {"Recipient": new_session_id}}
    except Exception:
        return {"decision": "allow"}


def main():
    raw_input = sys.stdin.read().strip()
    payload = {}
    if raw_input:
        try:
            payload = json.loads(raw_input)
        except Exception:
            payload = {}
    else:
        if "--payload" in sys.argv:
            try:
                idx = sys.argv.index("--payload")
                payload = json.loads(sys.argv[idx + 1])
            except Exception:
                payload = {}

    result = process_payload(payload)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
