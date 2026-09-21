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


def strip_unc_prefix(p):
    if not p or not isinstance(p, str):
        return ""
    s = p
    if s.startswith("\\\\?\\") or s.startswith("//?/"):
        s = s[4:]
        if s.upper().startswith("UNC\\") or s.upper().startswith("UNC/"):
            s = "\\\\" + s[4:]
    return s


def normalize_path(p):
    if not p:
        return ""
    cleaned = strip_unc_prefix(p)
    norm = os.path.normpath(cleaned).replace("\\", "/")
    if sys.platform == "win32" or (len(norm) > 1 and norm[1] == ":"):
        norm = norm.lower()
    return norm


def resolve_real_path_safely(p):
    if not p:
        return ""
    cleaned = strip_unc_prefix(p).replace("\\", "/") if sys.platform != "win32" else strip_unc_prefix(p)
    abs_path = os.path.abspath(cleaned)
    try:
        if os.path.exists(abs_path):
            return os.path.realpath(abs_path)
        curr = abs_path
        missing_segments = []
        while curr and curr != os.path.dirname(curr):
            missing_segments.insert(0, os.path.basename(curr))
            curr = os.path.dirname(curr)
            if os.path.exists(curr):
                real_parent = os.path.realpath(curr)
                return os.path.join(real_parent, *missing_segments)
    except Exception:
        pass
    return os.path.realpath(abs_path)


def is_path_inside(candidate, parent):
    if not candidate or not parent:
        return False
    try:
        c_clean = strip_unc_prefix(candidate).replace("\\", "/") if sys.platform != "win32" else strip_unc_prefix(candidate)
        p_clean = strip_unc_prefix(parent).replace("\\", "/") if sys.platform != "win32" else strip_unc_prefix(parent)
        abs_parent = os.path.abspath(p_clean)
        abs_candidate = os.path.abspath(c_clean)
        if sys.platform == "win32" or (len(abs_parent) > 1 and abs_parent[1] == ":") or (len(abs_candidate) > 1 and abs_candidate[1] == ":"):
            abs_parent = abs_parent.lower()
            abs_candidate = abs_candidate.lower()
        
        try:
            rel = os.path.relpath(abs_candidate, abs_parent)
        except ValueError:
            return False
            
        if rel == ".":
            return True
        is_outside = (
            rel == ".." or
            rel.startswith(".." + os.sep) or
            rel.startswith("../") or
            rel.startswith("..\\") or
            os.path.isabs(rel)
        )
        return not is_outside
    except (OSError, ValueError):
        return False


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


def load_vendor_aliases_contract():
    script_dir = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
    roots = [
        os.path.dirname(os.path.dirname(script_dir)),
        os.getcwd()
    ]
    for r in roots:
        p = os.path.join(r, "contracts", "vendor-aliases.json")
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    raw = json.load(fh)
                if isinstance(raw, dict) and isinstance(raw.get("aliases"), dict):
                    res = dict(DEFAULT_VENDOR_ALIASES)
                    res.update(raw["aliases"])
                    return res
            except Exception:
                pass
    return dict(DEFAULT_VENDOR_ALIASES)


VENDOR_ALIASES = load_vendor_aliases_contract()


def normalize_vendor(name):
    if not name:
        return None
    key = str(name).strip().lower()
    if key in VENDOR_ALIASES:
        return VENDOR_ALIASES[key]
    return key if re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", key) else None


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
    if not norm_target:
        return False
    # Inside the workspace, only specific subdirectories are exempt
    if norm_ws_root and is_path_inside(norm_target, norm_ws_root):
        ws_exempt_prefixes = [
            os.path.join(norm_ws_root, "docs"),
            os.path.join(norm_ws_root, "scratch"),
            os.path.join(norm_ws_root, ".agents", "task-loop"),
        ]
        for p in ws_exempt_prefixes:
            if is_path_inside(norm_target, p):
                return True
        return False

    # Outside the workspace: allow OS tempdir, brain, Desktop
    outside_exempt_prefixes = [
        tempfile.gettempdir(),
        os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain"),
        os.path.join(os.path.expanduser("~"), "Desktop"),
    ]
    for p in outside_exempt_prefixes:
        if is_path_inside(norm_target, p):
            return True
    return False


def is_path_allowed(target_file, allowlist, ws_root):
    if not target_file or not isinstance(allowlist, list):
        return False

    raw_ws_root = resolve_workspace_root([ws_root])
    clean_target = strip_unc_prefix(target_file).replace("\\", "/") if sys.platform != "win32" else strip_unc_prefix(target_file)
    abs_target = os.path.abspath(clean_target) if os.path.isabs(clean_target) else os.path.abspath(os.path.join(raw_ws_root, clean_target))
    real_target = resolve_real_path_safely(abs_target)

    # 1. 豁免路径直接放行 (Desktop, docs, scratch, temp, brain, task-loop state)
    # 逻辑路径与真实路径必须均在豁免范围内，防御符号链接逃逸
    if is_exempt_path(abs_target, raw_ws_root) and is_exempt_path(real_target, raw_ws_root):
        return True

    for entry in allowlist:
        if entry == "*":
            return True
        clean_entry = entry
        if clean_entry.endswith("/**"):
            clean_entry = clean_entry[:-3]
        elif clean_entry.endswith("/*"):
            clean_entry = clean_entry[:-2]

        clean_entry_base = strip_unc_prefix(clean_entry).replace("\\", "/") if sys.platform != "win32" else strip_unc_prefix(clean_entry)
        abs_entry = os.path.abspath(clean_entry_base) if os.path.isabs(clean_entry_base) else os.path.abspath(os.path.join(raw_ws_root, clean_entry_base))
        real_entry = resolve_real_path_safely(abs_entry)

        # 逻辑路径与真实路径双重严格子路径校验，防止前缀碰撞与软链接逃逸
        is_logical_inside = is_path_inside(abs_target, abs_entry)
        is_real_inside = is_path_inside(real_target, real_entry)

        if is_logical_inside and is_real_inside:
            return True
    return False


def find_sessions_registry(ws_root, target_vendor=None):
    candidates = []
    vendor = normalize_vendor(target_vendor)
    if vendor:
        candidates.append(os.path.join(ws_root, ".agents", "task-loop", f"sessions.{vendor}.json"))
    candidates.extend([
        os.path.join(ws_root, ".agents", "task-loop", "sessions.json"),
        os.path.join(ws_root, ".agents", "sessions.json"),
    ])
    if os.getcwd() and os.getcwd() != ws_root:
        if vendor:
            candidates.append(os.path.join(os.getcwd(), ".agents", "task-loop", f"sessions.{vendor}.json"))
        candidates.append(os.path.join(os.getcwd(), ".agents", "task-loop", "sessions.json"))
    for c in candidates:
        if os.path.exists(c):
            try:
                with open(c, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return None


def is_governance_or_state_file(norm_target, norm_ws_root):
    if not norm_target:
        return False
    abs_ws_root = norm_ws_root or os.getcwd()

    allowed_prefixes = [
        os.path.join(abs_ws_root, ".agents"),
        os.path.join(abs_ws_root, "docs"),
        os.path.join(abs_ws_root, "rules"),
        os.path.join(abs_ws_root, "templates"),
        os.path.join(abs_ws_root, "references"),
        os.path.join(abs_ws_root, "config"),
        tempfile.gettempdir(),
        os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain")
    ]
    for p in allowed_prefixes:
        if is_path_inside(norm_target, p):
            return True

    allowed_exact = [
        os.path.join(abs_ws_root, "AGENTS.md"),
        os.path.join(abs_ws_root, ".gitignore"),
        os.path.join(abs_ws_root, "plugin.json"),
        os.path.join(abs_ws_root, "hooks.json"),
        os.path.join(abs_ws_root, "SKILL.md")
    ]
    for f in allowed_exact:
        if is_path_inside(norm_target, f):
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
        return normalize_vendor(explicit_vendor)
    if os.environ.get("CODEX_THREAD_ID") and (not conversation_id or os.environ.get("CODEX_THREAD_ID") == conversation_id):
        return "codex"
    if os.environ.get("CODEX_SESSION_ID") and (not conversation_id or os.environ.get("CODEX_SESSION_ID") == conversation_id):
        return "codex"
    if os.environ.get("ZCODE_SESSION_ID") and (not conversation_id or os.environ.get("ZCODE_SESSION_ID") == conversation_id):
        return "zcode"
    if conversation_id and os.environ.get("ANTIGRAVITY_CONVERSATION_ID") == conversation_id:
        return "antigravity"
    if isinstance(conversation_id, str) and re.fullmatch(r"[0-9a-f-]{36}", conversation_id, re.IGNORECASE):
        return None
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
        vendor = detect_vendor(conversation_id, payload.get("vendor"))
        session_data = find_sessions_registry(ws_root, vendor)
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
            return {"decision": "allow"}

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
