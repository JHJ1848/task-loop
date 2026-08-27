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


def is_path_allowed(target_file, allowlist, ws_root):
    norm_target = normalize_path(target_file if os.path.isabs(target_file) else os.path.join(ws_root, target_file))
    norm_ws_root = normalize_path(ws_root)

    # 仅当目标文件在工作区外部且位于系统临时目录/脑区时豁免
    temp_dir = normalize_path(tempfile.gettempdir())
    if not norm_target.startswith(norm_ws_root) and norm_target.startswith(temp_dir):
        return True

    brain_dir = normalize_path(os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain"))
    if norm_target.startswith(brain_dir):
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
        conversation_id = payload.get("conversationId")

        allowlist = find_allowlist_for_session(ws_root, conversation_id)
        if not allowlist:
            return {"decision": "allow"}

        if not is_path_allowed(target_file, allowlist, ws_root):
            return {
                "decision": "deny",
                "reason": f"[task-loop Allowlist Guard] 工具调用被拦截！目标文件 '{target_file}' 不在当前任务白名单 (Allowlist: [{', '.join(allowlist)}]) 范围内，严禁越界修改！"
            }

        return {"decision": "allow"}
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
