#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[Hook Script] Enforce Allowlist Guard (PreToolUse) - Python 3.8+

Google Antigravity PreToolUse Hook
Intercepts modifying tools (write_to_file, replace_file_content, etc.),
checks whether target file is within the dispatched allowlist.

Input: stdin JSON ({ toolCall: { name, args }, conversationId, workspacePaths, ... })
Output: stdout JSON ({ decision: "allow" | "deny", reason?: string })
"""

import sys
import os
import json
import tempfile
import re

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass


def normalize_path(p):
    if not p:
        return ""
    norm = os.path.normpath(p).replace("\\", "/").lower()
    return norm


def resolve_workspace_root(workspace_paths):
    if workspace_paths and isinstance(workspace_paths, list) and len(workspace_paths) > 0:
        return workspace_paths[0]
    return os.getcwd()


def extract_target_file(tool_name, args):
    if not args or not isinstance(args, dict):
        return None

    write_tools = [
        # Antigravity native file-modification tools
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
        "create_file",
        "edit_file",
        "delete_file",
        # ZCode / Claude-Code-style file-modification tools
        "write",
        "edit",
        "multiedit",
        "notebookedit"
    ]

    if str(tool_name).lower() not in write_tools:
        return None

    return args.get("TargetFile") or args.get("FilePath") or args.get("target_file") or args.get("target_path") or args.get("path")


def find_allowlist_for_session(ws_root, conversation_id):
    # 1. 环境变量
    env_allowlist = os.environ.get("TASK_LOOP_ALLOWLIST")
    if env_allowlist:
        try:
            parsed = json.loads(env_allowlist)
            if isinstance(parsed, list) and len(parsed) > 0:
                return parsed
        except Exception:
            parts = [s.strip() for s in env_allowlist.split(",") if s.strip()]
            if parts:
                return parts

    # 2. todo.json
    todo_candidates = [
        os.path.join(ws_root, ".agents", "task-loop", "todo.json"),
        os.path.join(os.getcwd(), ".agents", "task-loop", "todo.json")
    ]
    for c in todo_candidates:
        if os.path.exists(c):
            try:
                with open(c, "r", encoding="utf-8") as f:
                    data = json.load(f)
                items = data.get("items", [])
                for item in items:
                    if (not conversation_id or item.get("assignee_thread_id") == conversation_id) and item.get("status") in ["in_progress", "dispatched", "pending"]:
                        allowlist = item.get("allowlist")
                        if allowlist and isinstance(allowlist, list) and len(allowlist) > 0:
                            return allowlist
            except Exception:
                pass

    # 3. dispatch packets
    dispatch_dirs = [
        os.path.join(ws_root, ".agents", "task-loop", "dispatch"),
        os.path.join(os.getcwd(), ".agents", "task-loop", "dispatch")
    ]
    for d in dispatch_dirs:
        if os.path.exists(d):
            try:
                for f in os.listdir(d):
                    if f.endswith(".json"):
                        p = os.path.join(d, f)
                        with open(p, "r", encoding="utf-8") as pf:
                            pkt = json.load(pf)
                        if not conversation_id or pkt.get("target_thread_id") == conversation_id:
                            allowlist = pkt.get("allowlist")
                            if allowlist and isinstance(allowlist, list) and len(allowlist) > 0:
                                return allowlist
            except Exception:
                pass
    return None


def is_exempt_path(norm_target, norm_ws_root):
    # Inside the workspace, only specific subdirectories are exempt
    if norm_ws_root and norm_target.startswith(norm_ws_root):
        ws_exempt_prefixes = [
            normalize_path(os.path.join(norm_ws_root, "docs")),
            normalize_path(os.path.join(norm_ws_root, "scratch")),
            normalize_path(os.path.join(norm_ws_root, ".agents", "task-loop")),
        ]
        for p in ws_exempt_prefixes:
            if norm_target.startswith(p):
                return True
        return False

    # Outside the workspace: allow OS tempdir, brain, Desktop
    outside_exempt_prefixes = [
        normalize_path(tempfile.gettempdir()),
        normalize_path(os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain")),
        normalize_path(os.path.join(os.path.expanduser("~"), "Desktop")),
    ]
    for p in outside_exempt_prefixes:
        if norm_target.startswith(p):
            return True
    return False


def is_path_allowed(target_file, allowlist, ws_root):
    norm_target = normalize_path(target_file if os.path.isabs(target_file) else os.path.join(ws_root, target_file))
    norm_ws_root = normalize_path(ws_root)

    # 1. 豁免路径直接放行 (Desktop, docs, scratch, temp, brain, task-loop state)
    if is_exempt_path(norm_target, norm_ws_root):
        return True

    for entry in allowlist:
        if entry == "*":
            return True
        clean_entry = entry
        if clean_entry.endswith("/**"):
            clean_entry = clean_entry[:-3]
        elif clean_entry.endswith("/*"):
            clean_entry = clean_entry[:-2]

        abs_entry = normalize_path(clean_entry if os.path.isabs(clean_entry) else os.path.join(ws_root, clean_entry))
        if norm_target == abs_entry:
            return True
        prefix = abs_entry if abs_entry.endswith("/") else abs_entry + "/"
        if norm_target.startswith(prefix):
            return True
    return False


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
                    return json.load(f)
            except Exception:
                pass
    return None


def is_governance_or_state_file(norm_target, norm_ws_root):
    allowed_prefixes = [
        normalize_path(os.path.join(norm_ws_root, ".agents")),
        normalize_path(os.path.join(norm_ws_root, "docs")),
        normalize_path(os.path.join(norm_ws_root, "rules")),
        normalize_path(os.path.join(norm_ws_root, "templates")),
        normalize_path(os.path.join(norm_ws_root, "references")),
        normalize_path(os.path.join(norm_ws_root, "config")),
        normalize_path(tempfile.gettempdir()),
        normalize_path(os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain"))
    ]
    for p in allowed_prefixes:
        if norm_target.startswith(p):
            return True

    allowed_exact = [
        normalize_path(os.path.join(norm_ws_root, "AGENTS.md")),
        normalize_path(os.path.join(norm_ws_root, ".gitignore")),
        normalize_path(os.path.join(norm_ws_root, "plugin.json")),
        normalize_path(os.path.join(norm_ws_root, "hooks.json")),
        normalize_path(os.path.join(norm_ws_root, "SKILL.md"))
    ]
    for f in allowed_exact:
        if norm_target == f:
            return True
    return False


def get_vendor_data(session_data, vendor):
    if not isinstance(session_data, dict) or not vendor:
        return None
    if isinstance(session_data.get("vendors"), dict):
        return session_data["vendors"].get(vendor)
    return session_data if vendor == "antigravity" else None


def check_is_main_session(session_data, conversation_id, vendor):
    if not session_data or not conversation_id:
        return False
    vendor_data = get_vendor_data(session_data, vendor)
    return bool(vendor_data and (vendor_data.get("main_thread_id") == conversation_id or
        any(isinstance(s, dict) and s.get("session_id") == conversation_id and s.get("is_main") for s in vendor_data.get("sessions", []))))


def detect_vendor(conversation_id, explicit_vendor=None):
    if explicit_vendor:
        return str(explicit_vendor).lower()
    if os.environ.get("CODEX_THREAD_ID") and (not conversation_id or os.environ.get("CODEX_THREAD_ID") == conversation_id):
        return "codex"
    if os.environ.get("CODEX_SESSION_ID") and (not conversation_id or os.environ.get("CODEX_SESSION_ID") == conversation_id):
        return "codex"
    if os.environ.get("ZCODE_SESSION_ID") and (not conversation_id or os.environ.get("ZCODE_SESSION_ID") == conversation_id):
        return "zcode"
    if isinstance(conversation_id, str) and re.fullmatch(r"[0-9a-f-]{36}", conversation_id, re.IGNORECASE):
        return None
    if conversation_id and os.environ.get("ANTIGRAVITY_CONVERSATION_ID") == conversation_id:
        return "antigravity"
    if isinstance(conversation_id, str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", conversation_id, re.IGNORECASE):
        return "antigravity"
    return None


def is_registered_for_vendor(session_data, conversation_id, vendor):
    if not isinstance(session_data, dict) or not conversation_id or not vendor:
        return False
    vendor_data = get_vendor_data(session_data, vendor)
    if not isinstance(vendor_data, dict):
        return False
    if vendor_data.get("main_thread_id") == conversation_id:
        return True
    if any(isinstance(s, dict) and s.get("session_id") == conversation_id for s in vendor_data.get("sessions", [])):
        return True
    return any(isinstance(s, dict) and s.get("session_id") == conversation_id for s in (vendor_data.get("modules") or {}).values())


def extract_main_thread_id(session_data, vendor):
    vendor_data = get_vendor_data(session_data, vendor)
    return vendor_data.get("main_thread_id") if isinstance(vendor_data, dict) else None


def process_payload(payload):
    try:
        tool_call = payload.get("toolCall")
        if not tool_call or not isinstance(tool_call, dict):
            return {"decision": "allow"}

        tool_name = tool_call.get("name")
        if not tool_name:
            return {"decision": "allow"}

        target_file = extract_target_file(tool_name, tool_call.get("args"))
        if not target_file:
            return {"decision": "allow"}

        ws_root = resolve_workspace_root(payload.get("workspacePaths"))
        conversation_id = payload.get("conversationId") or payload.get("conversation_id") or payload.get("sessionId") or payload.get("session_id")
        # 1. 主会话行为硬性红线拦截 (Explore-Only Hard Gate)
        session_data = find_sessions_registry(ws_root)
        vendor = detect_vendor(conversation_id, payload.get("vendor"))
        if not payload.get("vendor") and not vendor and conversation_id and is_registered_for_vendor(session_data, conversation_id, "antigravity"):
            vendor = "antigravity"
        if vendor == "codex":
            return {"decision": "deny", "reason": "[task-loop PreToolUse DENY] Codex automatic file interception is unsupported; use Skills, Provider, and pre-dispatch allowlist validation."}
        if not vendor or vendor not in ["antigravity", "zcode", "claude"]:
            return {"decision": "deny", "reason": f"[task-loop PreToolUse DENY] Unknown or missing vendor '{payload.get('vendor') or 'unknown'}' cannot write files."}
        if not conversation_id:
            return {"decision": "deny", "reason": f"[task-loop PreToolUse DENY] Vendor '{vendor}' file writes require a registered session."}
        if conversation_id and (not vendor or not is_registered_for_vendor(session_data, conversation_id, vendor)):
            return {"decision": "deny", "reason": f"[task-loop PreToolUse DENY] Session '{conversation_id}' is missing, unregistered, or mismatched for vendor '{vendor or 'unknown'}'."}
        is_main_session = check_is_main_session(session_data, conversation_id, vendor)

        if is_main_session:
            norm_target = normalize_path(target_file if os.path.isabs(target_file) else os.path.join(ws_root, target_file))
            norm_ws_root = normalize_path(ws_root)
            if not is_governance_or_state_file(norm_target, norm_ws_root):
                return {
                    "decision": "deny",
                    "reason": f"[task-loop PreToolUse DENY] 主会话硬性治理红线：主会话仅限只读探索 (Explore Only)，严禁直接修改业务代码 ({target_file})！所有具体代码实施、功能落地与 BugFix 必须且强制要求派单至专题会话 (Topic Session) 或子代理 (Subagent Worker) 实施，以彻底杜绝多会话并发修改导致的上下文错乱与业务冲突。请先生成派单契约并使用 send_message 或 invoke_subagent 派发。"
                }

        allowlist = find_allowlist_for_session(ws_root, conversation_id)
        if not allowlist:
            return {"decision": "deny", "reason": "[task-loop PreToolUse DENY] File writes require a non-empty dispatched allowlist."}

        if not is_path_allowed(target_file, allowlist, ws_root):
            main_thread_id = extract_main_thread_id(session_data, vendor) or "<main_thread_id>"
            req_json = json.dumps({
                "type": "ALLOWLIST_EXPANSION_REQUEST",
                "target_files": [target_file],
                "reason": "<请在此详细阐述需要修改该文件的理由与影响分析>"
            }, indent=2, ensure_ascii=False)
            return {
                "decision": "deny",
                "reason": f"[task-loop Allowlist Guard] 工具调用被拦截！目标文件 '{target_file}' 不在当前任务白名单 (Allowlist: [{', '.join(allowlist)}]) 范围内，严禁越界修改！若确需修改此文件，必须向主治理中枢发起标准化白名单扩展申请 (ALLOWLIST_EXPANSION_REQUEST)：\nsend_message('{main_thread_id}', '{req_json}')"
            }

        return {"decision": "allow"}
    except Exception:
        return {"decision": "deny", "reason": "[task-loop PreToolUse DENY] File write validation failed."}


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
