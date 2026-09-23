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

try:
    from . import host_vendor
except ImportError:
    import host_vendor

# 影响边界: 宿主级 Agent 状态根目录由各厂商自行读写, 承载 Agent 的记忆、配置、凭据与技能,
# 属于宿主状态而非项目业务文件。按目录列举而非按厂商分支, 接入新宿主只需追加一行,
# 不为每个厂商增加维护点。
HOST_AGENT_STATE_ROOTS = [
    os.path.join(os.path.expanduser("~"), name)
    for name in (".claude", ".codex", ".zcode", ".gemini", ".agents")
]

# 工作区外可豁免的路径前缀: 操作系统临时目录、桌面, 以及宿主 Agent 状态根目录。
OUTSIDE_WORKSPACE_EXEMPT_PREFIXES = [
    tempfile.gettempdir(),
    *HOST_AGENT_STATE_ROOTS,
    os.path.join(os.path.expanduser("~"), "Desktop"),
]


def is_outside_workspace_exempt(norm_target):
    if not norm_target:
        return False
    return any(is_path_inside(norm_target, prefix) for prefix in OUTSIDE_WORKSPACE_EXEMPT_PREFIXES)


def is_project_external_path(norm_target, norm_ws_root):
    # 仅当目标位于工作区之外时才视为项目外部。工作区内的业务文件一律仍受门禁治理,
    # 避免工作区本身位于桌面或宿主状态目录下时被整体豁免。
    if not norm_target:
        return False
    if norm_ws_root and is_path_inside(norm_target, norm_ws_root):
        return False
    return is_outside_workspace_exempt(norm_target)


def is_task_loop_initialized(ws_root):
    # 工作区接入 task-loop 的唯一标记: .agents/task-loop 目录。
    if not ws_root:
        return False
    return os.path.isdir(os.path.join(ws_root, ".agents", "task-loop"))


def has_governance_basis(ws_root):
    # 门禁的治理依据: 工作区已接入 task-loop, 或存在显式派发的白名单(环境变量)。
    # 两者都没有时该工作区与 task-loop 无关, fail-closed 不适用 —— 否则门禁会越过影响边界,
    # 在无关项目中拒绝一切写入(含宿主自身的记忆与状态目录)。
    if is_task_loop_initialized(ws_root):
        return True
    dispatched = os.environ.get("TASK_LOOP_ALLOWLIST")
    return isinstance(dispatched, str) and dispatched.strip() != ""

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

    # Outside the workspace: OS tempdir, Desktop, and host agent-state roots
    return is_outside_workspace_exempt(norm_target)


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
        *HOST_AGENT_STATE_ROOTS
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


def extract_session_id(payload, env=None):
    if env is None:
        env = os.environ
    return (
        payload.get("conversationId")
        or payload.get("conversation_id")
        or payload.get("session_id")
        or payload.get("sessionId")
        or env.get("CLAUDE_CODE_SESSION_ID")
        or env.get("CLAUDE_SESSION_ID")
        or env.get("ZCODE_SESSION_ID")
        or None
    )


def resolve_workspace(payload, env=None):
    if env is None:
        env = os.environ
    workspace_paths = payload.get("workspacePaths")
    if isinstance(workspace_paths, list) and len(workspace_paths) > 0:
        return workspace_paths[0]
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd:
        return cwd
    return env.get("ZCODE_PROJECT_DIR") or env.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def normalize_tool_call(payload):
    if isinstance(payload.get("toolCall"), dict):
        return payload["toolCall"]
    raw_args = payload.get("tool_input") if payload.get("tool_input") is not None else payload.get("toolInput")
    if not isinstance(raw_args, dict):
        return None

    tool_name = payload.get("tool_name") or payload.get("toolName")
    if not isinstance(tool_name, str) or not tool_name:
        return None

    args = dict(raw_args)
    target = (
        args.get("TargetFile")
        if args.get("TargetFile") is not None
        else args.get("FilePath")
        if args.get("FilePath") is not None
        else args.get("file_path")
        if args.get("file_path") is not None
        else args.get("filePath")
        if args.get("filePath") is not None
        else args.get("target_file")
        if args.get("target_file") is not None
        else args.get("target_path")
        if args.get("target_path") is not None
        else args.get("path")
    )
    args.pop("file_path", None)
    args.pop("filePath", None)
    args["TargetFile"] = target

    return {"name": tool_name, "args": args}


def format_deny(reason, is_zcode_protocol):
    if is_zcode_protocol:
        return {
            "suppressOutput": True,
            "systemMessage": "[task-loop Allowlist Guard] blocked an out-of-allowlist write.",
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason or "Target file is outside the dispatched task allowlist."
            }
        }
    return {"decision": "deny", "reason": reason}


def process_payload(payload, env=None, argv=None):
    is_zcode_protocol = False
    try:
        if env is None:
            env = os.environ
        if argv is None:
            argv = sys.argv
        if not isinstance(payload, dict):
            payload = {}

        is_zcode_protocol = bool(
            payload.get("tool_name")
            or payload.get("toolName")
            or payload.get("hook_event_name") == "PreToolUse"
            or payload.get("hookEventName") == "PreToolUse"
            or (payload.get("cwd") and not payload.get("toolCall") and not isinstance(payload.get("workspacePaths"), list))
        )

        tool_call = normalize_tool_call(payload)
        if not tool_call or not isinstance(tool_call, dict):
            return {} if is_zcode_protocol else {"decision": "allow"}

        tool_name = tool_call.get("name")
        if not tool_name:
            return {} if is_zcode_protocol else {"decision": "allow"}

        target_file = extract_target_file(tool_name, tool_call.get("args"))
        if not target_file:
            return {} if is_zcode_protocol else {"decision": "allow"}

        ws_root = resolve_workspace(payload, env)
        conversation_id = extract_session_id(payload, env)

        norm_target = normalize_path(target_file if os.path.isabs(target_file) else os.path.join(ws_root, target_file))
        norm_ws_root = normalize_path(ws_root)
        if not has_governance_basis(ws_root) or is_project_external_path(norm_target, norm_ws_root):
            return {} if is_zcode_protocol else {"decision": "allow"}

        declared_vendor = host_vendor.resolve_vendor(payload, env, argv) if hasattr(host_vendor, "resolve_vendor") else None
        vendor = detect_vendor(conversation_id, payload.get("vendor") or declared_vendor)
        session_data = find_sessions_registry(ws_root, vendor)
        if not payload.get("vendor") and not vendor and conversation_id and is_registered_for_vendor(session_data, conversation_id, "antigravity"):
            vendor = "antigravity"
        if vendor == "codex":
            reason = "[task-loop PreToolUse DENY] Codex automatic file interception is unsupported; use Skills, Provider, and pre-dispatch allowlist validation."
            return format_deny(reason, is_zcode_protocol)
        if not vendor or vendor not in ["antigravity", "zcode", "claude"]:
            reason = f"[task-loop PreToolUse DENY] Unknown or missing vendor '{payload.get('vendor') or 'unknown'}' cannot write files."
            return format_deny(reason, is_zcode_protocol)
        if not conversation_id:
            reason = f"[task-loop PreToolUse DENY] Vendor '{vendor}' file writes require a registered session."
            return format_deny(reason, is_zcode_protocol)
        if conversation_id and (not vendor or not is_registered_for_vendor(session_data, conversation_id, vendor)):
            reason = f"[task-loop PreToolUse DENY] Session '{conversation_id}' is missing, unregistered, or mismatched for vendor '{vendor or 'unknown'}'."
            return format_deny(reason, is_zcode_protocol)
        is_main_session = check_is_main_session(session_data, conversation_id, vendor)

        if is_main_session:
            if not is_governance_or_state_file(norm_target, norm_ws_root):
                reason = f"[task-loop PreToolUse DENY] 主会话硬性治理红线：主会话仅限只读探索 (Explore Only)，严禁直接修改业务代码 ({target_file})！所有具体代码实施、功能落地与 BugFix 必须且强制要求派单至专题会话 (Topic Session) 或子代理 (Subagent Worker) 实施，以彻底杜绝多会话并发修改导致的上下文错乱与业务冲突。请先生成派单契约并使用 send_message 或 invoke_subagent 派发。"
                return format_deny(reason, is_zcode_protocol)
            return {} if is_zcode_protocol else {"decision": "allow"}

        allowlist = find_allowlist_for_session(ws_root, conversation_id)
        if not allowlist:
            reason = "[task-loop PreToolUse DENY] File writes require a non-empty dispatched allowlist."
            return format_deny(reason, is_zcode_protocol)

        if not is_path_allowed(target_file, allowlist, ws_root):
            main_thread_id = extract_main_thread_id(session_data, vendor) or "<main_thread_id>"
            req_json = json.dumps({
                "type": "ALLOWLIST_EXPANSION_REQUEST",
                "target_files": [target_file],
                "reason": "<请在此详细阐述需要修改该文件的理由与影响分析>"
            }, indent=2, ensure_ascii=False)
            reason = f"[task-loop Allowlist Guard] 工具调用被拦截！目标文件 '{target_file}' 不在当前任务白名单 (Allowlist: [{', '.join(allowlist)}]) 范围内，严禁越界修改！若确需修改此文件，必须向主治理中枢发起标准化白名单扩展申请 (ALLOWLIST_EXPANSION_REQUEST)：\nsend_message('{main_thread_id}', '{req_json}')"
            return format_deny(reason, is_zcode_protocol)

        return {} if is_zcode_protocol else {"decision": "allow"}
    except Exception:
        reason = "[task-loop PreToolUse DENY] File write validation failed."
        return format_deny(reason, is_zcode_protocol)


def main():
    raw_input_data = sys.stdin.read().strip()
    payload = {}
    if raw_input_data:
        try:
            payload = json.loads(raw_input_data)
        except Exception:
            payload = {}
    else:
        if "--payload" in sys.argv:
            try:
                idx = sys.argv.index("--payload")
                payload = json.loads(sys.argv[idx + 1])
            except Exception:
                payload = {}

    result = process_payload(payload, os.environ, sys.argv)
    if not result:
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

