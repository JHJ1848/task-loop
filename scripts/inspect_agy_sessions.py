#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[inspect_agy_sessions.py]
Antigravity (AGY) Project Session Inspector & State Probe (Python)

Scans, inspects, and reports the live/sleeping state of all AGY sessions
associated with the current workspace.
"""

import sys
import os
import json
import re
import argparse
from datetime import datetime, timezone
from pathlib import Path

# Force UTF-8 encoding on Windows to prevent GBK transcoding crashes
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def normalize_path(p: str) -> str:
    if not p:
        return ""
    return str(Path(p).resolve()).replace("\\", "/").rstrip("/").lower()


def format_relative_time(date_iso: str) -> str:
    if not date_iso:
        return "未知"
    try:
        # Normalize ISO string with Z
        iso_str = date_iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(iso_str)
        now = datetime.now(timezone.utc)
        diff_sec = int((now - dt).total_seconds())

        if diff_sec < 0:
            return "刚刚"
        if diff_sec < 60:
            return f"{diff_sec} 秒前"
        diff_min = diff_sec // 60
        if diff_min < 60:
            return f"{diff_min} 分钟前"
        diff_hour = diff_min // 60
        if diff_hour < 24:
            return f"{diff_hour} 小时前"
        diff_day = diff_hour // 24
        if diff_day < 30:
            return f"{diff_day} 天前"
        return date_iso[:10]
    except Exception:
        return "未知"


def load_registry_sessions(project_root: str):
    mapping = {}
    candidates = [
        os.path.join(project_root, ".agents", "task-loop", "sessions.antigravity.json"),
        os.path.join(project_root, ".agents", "task-loop", "sessions.json")
    ]

    for fp in candidates:
        if os.path.exists(fp):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    data = json.load(f)
                main_id = data.get("main_thread_id")
                if data.get("vendor") == "antigravity" or "antigravity" in data.get("vendors", {}):
                    v_data = data.get("vendors", {}).get("antigravity", data)
                    main_id = v_data.get("main_thread_id", main_id)
                    modules = v_data.get("modules", {})
                    for mod_key, mod_info in modules.items():
                        sess_id = mod_info.get("session_id")
                        if sess_id:
                            mapping[sess_id] = {
                                "module_key": mod_key,
                                "title": mod_info.get("title", f"[{mod_key}]"),
                                "is_main": (sess_id == main_id),
                                "memory_doc": mod_info.get("memory_doc"),
                                "is_registered": True
                            }
                    sessions = v_data.get("sessions", [])
                    for s in sessions:
                        sess_id = s.get("session_id")
                        if sess_id and sess_id not in mapping:
                            mem_docs = s.get("memory_docs", [])
                            mapping[sess_id] = {
                                "module_key": s.get("module_key", "unassigned"),
                                "title": s.get("title", f"Session {sess_id[:8]}"),
                                "is_main": s.get("is_main", sess_id == main_id),
                                "memory_doc": mem_docs[0] if mem_docs else None,
                                "is_registered": True
                            }
                if mapping:
                    break
            except Exception:
                pass
    return mapping


def inspect_agy_sessions(root: str = ".", brain_path: str = None, active_window: int = 30):
    raw_project_root = str(Path(root).resolve())
    project_root = normalize_path(root)

    if brain_path:
        brain_dir = str(Path(brain_path).resolve())
    else:
        brain_dir = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain")

    registry_map = load_registry_sessions(raw_project_root)

    if not os.path.exists(brain_dir) or not os.path.isdir(brain_dir):
        return {
            "project_root": raw_project_root,
            "total": 0,
            "active_count": 0,
            "sleeping_count": 0,
            "sessions": []
        }

    results = []
    try:
        entries = os.listdir(brain_dir)
    except Exception:
        entries = []

    for entry in entries:
        entry_path = os.path.join(brain_dir, entry)
        if not os.path.isdir(entry_path):
            continue

        conv_id = entry
        log_file = os.path.join(entry_path, ".system_generated", "logs", "transcript.jsonl")
        if not os.path.exists(log_file):
            log_file = os.path.join(entry_path, ".system_generated", "logs", "transcript_full.jsonl")
            if not os.path.exists(log_file):
                continue

        is_match = conv_id in registry_map
        step_count = 0
        first_created_at = ""
        last_active_at = ""
        last_user_prompt = ""
        last_sidebus_message = ""

        try:
            with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line_str = line.strip()
                    if not line_str:
                        continue
                    step_count += 1
                    line_lower = line_str.lower()
                    project_root_escaped = project_root.replace(":", "%3a")

                    if not is_match and (project_root in line_lower or project_root_escaped in line_lower):
                        is_match = True

                    try:
                        parsed = json.loads(line_str)
                        created_at = parsed.get("created_at", "")
                        if created_at:
                            if not first_created_at:
                                first_created_at = created_at
                            last_active_at = created_at

                        if parsed.get("type") == "USER_INPUT" and parsed.get("content"):
                            clean = parsed["content"].replace("\r", " ").replace("\n", " ").strip()
                            if clean:
                                last_user_prompt = clean

                        content = parsed.get("content", "")
                        if content and any(k in content for k in ["[主会话派单", "[专题交付", "[协同回执"]):
                            clean = content.replace("\r", " ").replace("\n", " ").strip()
                            if clean:
                                last_sidebus_message = clean
                    except Exception:
                        pass
        except Exception:
            pass

        if not last_active_at:
            try:
                mtime = os.path.getmtime(log_file)
                last_active_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                ctime = os.path.getctime(log_file)
                if not first_created_at:
                    first_created_at = datetime.fromtimestamp(ctime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
            except Exception:
                pass

        if not is_match:
            continue

        recent_prompt = last_sidebus_message or last_user_prompt or "(无近期交互摘要)"
        if len(recent_prompt) > 80:
            recent_prompt = recent_prompt[:77] + "..."

        reg_info = registry_map.get(conv_id, {
            "module_key": "unregistered",
            "title": f"[未命名会话] {conv_id[:8]}",
            "is_main": False,
            "memory_doc": None,
            "is_registered": False
        })

        # Calculate active/sleeping status
        diff_mins = 999999
        if last_active_at:
            try:
                iso_str = last_active_at.replace("Z", "+00:00")
                dt = datetime.fromisoformat(iso_str)
                now = datetime.now(timezone.utc)
                diff_mins = (now - dt).total_seconds() / 60.0
            except Exception:
                pass

        if diff_mins <= active_window:
            status = "ACTIVE" if reg_info["is_registered"] else "UNREGISTERED_ACTIVE"
        else:
            status = "IDLE_SLEEPING" if reg_info["is_registered"] else "UNREGISTERED"

        results.append({
            "session_id": conv_id,
            "title": reg_info["title"],
            "module_key": reg_info["module_key"],
            "is_main": reg_info["is_main"],
            "is_registered": reg_info["is_registered"],
            "status": status,
            "steps": step_count,
            "created_at": first_created_at,
            "last_active_at": last_active_at,
            "last_active_relative": format_relative_time(last_active_at),
            "memory_doc": reg_info["memory_doc"],
            "recent_prompt": recent_prompt,
            "deep_link": f"conversation://{conv_id}"
        })

    def sort_key(x):
        main_score = 0 if x["is_main"] else 1
        active_score = 0 if x["status"] == "ACTIVE" else 1
        return (main_score, active_score, x.get("last_active_at") or "")

    # Sort: Main first, then active, then latest timestamp descending
    results.sort(key=sort_key)

    return {
        "project_root": raw_project_root,
        "total": len(results),
        "active_count": sum(1 for r in results if r["status"] == "ACTIVE"),
        "sleeping_count": sum(1 for r in results if r["status"] == "IDLE_SLEEPING"),
        "sessions": results
    }


def print_table(report):
    print("\n" + "=" * 80)
    print("[task-loop] AGY 会话状态巡检与探针报告 (Session Inspector)")
    print("=" * 80)
    print(f"* 工作区目录: {report['project_root']}")
    print(f"* 会话总数: {report['total']} (活跃: {report['active_count']} | 休眠: {report['sleeping_count']})")
    print("-" * 80)

    if not report["sessions"]:
        print("(当前工作区未发现已绑定的 AGY 会话)")
        print("-" * 80 + "\n")
        return

    for i, s in enumerate(report["sessions"], 1):
        role_tag = "[Main 会话中枢]" if s["is_main"] else f"[专题: {s['module_key']}]"
        status_tag = "[ACTIVE:活跃]" if s["status"] == "ACTIVE" else "[SLEEPING:休眠]"

        print(f"\n{i}. {s['title']}  {role_tag}  {status_tag}")
        print(f"   * 会话 ID     : {s['session_id']}")
        print(f"   * 步数 / 活跃 : {s['steps']} Steps | {s['last_active_relative']} ({s['last_active_at'] or 'N/A'})")
        if s["memory_doc"]:
            print(f"   * 受控记忆   : {s['memory_doc']}")
        print(f"   * 最近交互   : {s['recent_prompt']}")
        print(f"   * 切换唤醒卡 : [-> 点击切换至该会话]({s['deep_link']})")

    print("\n" + "=" * 80 + "\n")


def check_agentapi_rpc(session_id: str, options: dict = None):
    """保护性检查 AgentAPI RPC 连通性"""
    if options and options.get("skip_rpc"):
        return {"checked": False, "available": True, "skipped": True}

    import shutil
    import subprocess

    bin_path = os.environ.get("AGENTAPI_PATH")
    if not bin_path or not os.path.exists(bin_path):
        home = os.path.expanduser("~")
        candidates = [
            os.path.join(home, ".gemini", "antigravity", "bin", "agentapi.bat"),
            os.path.join(home, ".gemini", "antigravity", "bin", "agentapi.exe"),
            os.path.join(home, ".gemini", "antigravity", "bin", "agentapi"),
            os.path.join(home, ".antigravity", "bin", "agentapi.bat"),
            os.path.join(home, ".antigravity", "bin", "agentapi.exe"),
            os.path.join(home, ".antigravity", "bin", "agentapi"),
        ]
        bin_path = next((c for c in candidates if os.path.exists(c)), None)

    if not bin_path:
        bin_path = shutil.which("agentapi")

    if not bin_path:
        return {"checked": False, "available": False, "error": "agentapi binary not found"}

    try:
        proc = subprocess.run(
            [bin_path, "get-conversation-metadata", session_id],
            capture_output=True,
            text=True,
            timeout=3.0,
            shell=(os.name == "nt"),
            encoding="utf-8"
        )
        if proc.returncode == 0:
            out = proc.stdout.strip()
            try:
                meta = json.loads(out)
            except Exception:
                meta = out
            return {"checked": True, "available": True, "metadata": meta}
        else:
            return {"checked": True, "available": False, "error": proc.stderr.strip() or f"exit code {proc.returncode}"}
    except Exception as e:
        return {"checked": True, "available": False, "error": str(e)}


def fetch_session_transcript(session_id: str, options: dict = None, **kwargs):
    """跨会话转录内省原语 (Transcript Introspection Primitive)
    按时序提取目标会话的最新执行轨迹，包括思维链 Thinking、工具调用与模型内容。
    """
    opts = dict(options or {})
    opts.update(kwargs)
    options = opts

    tail = int(options.get("tail", 5))
    if tail <= 0:
        tail = 5
    include_thinking = options.get("include_thinking", True)
    include_tools = options.get("include_tools", True)

    brain_dir = (
        str(Path(options["brain_path"]).resolve())
        if options.get("brain_path")
        else os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain")
    )
    session_dir = os.path.join(brain_dir, session_id)

    if not os.path.exists(session_dir):
        return {
            "session_id": session_id,
            "found": False,
            "total_steps": 0,
            "tail": tail,
            "steps": [],
            "error": f"会话目录不存在: {session_dir}"
        }

    log_file = os.path.join(session_dir, ".system_generated", "logs", "transcript.jsonl")
    if not os.path.exists(log_file):
        log_file = os.path.join(session_dir, ".system_generated", "logs", "transcript_full.jsonl")

    if not os.path.exists(log_file):
        return {
            "session_id": session_id,
            "found": False,
            "total_steps": 0,
            "tail": tail,
            "steps": [],
            "error": f"日志文件不存在: {log_file}"
        }

    all_steps = []
    try:
        with open(log_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    all_steps.append(json.loads(line))
                except Exception:
                    pass
    except Exception as e:
        return {
            "session_id": session_id,
            "found": False,
            "total_steps": 0,
            "tail": tail,
            "steps": [],
            "error": f"读取转录日志失败: {str(e)}"
        }

    raw_tail_steps = all_steps[-tail:] if tail < len(all_steps) else all_steps
    formatted_steps = []
    offset = len(all_steps) - len(raw_tail_steps)

    for idx, st in enumerate(raw_tail_steps):
        step_idx = st.get("step_index")
        if step_idx is None:
            step_idx = offset + idx

        item = {
            "step_index": step_idx,
            "type": st.get("type", "UNKNOWN"),
            "source": st.get("source", "UNKNOWN"),
            "status": st.get("status", "DONE"),
            "created_at": st.get("created_at")
        }

        th = st.get("thinking")
        if include_thinking and th:
            item["thinking_preview"] = th[:197] + "..." if len(th) > 200 else th
        else:
            item["thinking_preview"] = None

        tool_calls = st.get("tool_calls")
        if include_tools and isinstance(tool_calls, list):
            tc_list = []
            for tc in tool_calls:
                args = tc.get("args")
                if args is not None:
                    if isinstance(args, str):
                        args_summary = args[:117] + "..." if len(args) > 120 else args
                    else:
                        args_str = json.dumps(args, ensure_ascii=False)
                        args_summary = args_str[:117] + "..." if len(args_str) > 120 else args_str
                else:
                    args_summary = ""
                tc_list.append({
                    "name": tc.get("name", "unnamed_tool"),
                    "args_summary": args_summary
                })
            item["tool_calls"] = tc_list
        else:
            item["tool_calls"] = []

        content = st.get("content")
        if content and isinstance(content, str):
            item["content_snippet"] = content[:197] + "..." if len(content) > 200 else content
        else:
            item["content_snippet"] = None

        formatted_steps.append(item)

    return {
        "session_id": session_id,
        "found": True,
        "total_steps": len(all_steps),
        "tail": tail,
        "log_file": log_file,
        "steps": formatted_steps
    }


def print_recent_trajectory(data: dict):
    print("\n" + "=" * 80)
    print("[task-loop] 目标专题会话执行轨迹内省报告 (Transcript Introspection)")
    print("=" * 80)
    print(f"* 会话 ID   : {data.get('session_id')}")
    print(f"* 状态     : {'🟢 日志已就绪' if data.get('found') else '🔴 未找到日志'}")
    print(f"* 总步数   : {data.get('total_steps', 0)} (展示最近 {len(data.get('steps', []))} 步)")
    if data.get("log_file"):
        print(f"* 日志路径 : {data['log_file']}")
    if data.get("error"):
        print(f"* 错误信息 : {data['error']}")
    print("-" * 80)

    steps = data.get("steps", [])
    if not steps:
        print("(未检测到有效历史步骤)")
    else:
        for st in steps:
            source_tag = f"[{st.get('source', 'UNKNOWN')}]"
            type_tag = f"[{st.get('type', 'STEP')}]"
            status_tag = f"[{st.get('status', 'DONE')}]"
            print(f"\n#{st.get('step_index')} {source_tag} {type_tag} {status_tag} ({st.get('created_at') or '时间未知'})")
            if st.get("thinking_preview"):
                clean_th = re.sub(r'\s+', ' ', st["thinking_preview"])
                print(f"   💡 思考链: {clean_th}")
            for tc in st.get("tool_calls", []):
                print(f"   🔧 工具调用: {tc.get('name')} -> {tc.get('args_summary')}")
            if st.get("content_snippet"):
                clean_cnt = re.sub(r'\s+', ' ', st["content_snippet"])
                print(f"   💬 内容摘要: {clean_cnt}")
    print("\n" + "=" * 80 + "\n")


def probe_dispatch_session(session_id: str, brain_path: str = None, options: dict = None, **kwargs):
    """4维物理交叉验证探针 (4-Dimension Physical Cross-Validation Probe)
    彻底消灭历史步骤与假阳性绿灯，综合在场锁、文件物理增量、步骤时效与 Daemon RPC。
    """
    opts = dict(options or {})
    if brain_path:
        opts["brain_path"] = brain_path
    opts.update(kwargs)
    options = opts

    brain_dir = (
        str(Path(options["brain_path"]).resolve())
        if options.get("brain_path")
        else os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain")
    )

    now = datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    fresh_window_sec = int(options.get("fresh_window_sec", 30))
    baseline_time = options.get("baseline_time")
    baseline_size = options.get("baseline_size")
    if baseline_size is not None:
        try:
            baseline_size = int(baseline_size)
        except Exception:
            baseline_size = None

    # 维度 1: Presence 在场锁检测
    presence_lock_dir = (
        str(Path(options["presence_path"]).resolve())
        if options.get("presence_path")
        else os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "presence")
    )
    presence_lock_file = os.path.join(presence_lock_dir, f"{session_id}.lock")
    is_present = os.path.exists(presence_lock_file)
    dimension_presence = {
        "is_present": is_present,
        "lock_file": presence_lock_file
    }

    session_dir = os.path.join(brain_dir, session_id)
    if not os.path.exists(session_dir):
        dimension_fs = {
            "transcript_path": None,
            "transcript_mtime": None,
            "transcript_size": 0,
            "delta_bytes": 0,
            "has_recent_write": False,
            "mtime_diff_sec": None
        }
        dimension_inference = {
            "model_steps_count": 0,
            "tool_calls_count": 0,
            "thinking_steps_count": 0,
            "in_progress_steps_count": 0,
            "latest_model_step": None,
            "is_fresh": False,
            "step_age_sec": None,
            "thread_running_fresh": False
        }
        dimension_rpc = check_agentapi_rpc(session_id, options)

        return {
            "session_id": session_id,
            "found": False,
            "thread_running": False,
            "is_working": False,
            "working_status": "DORMANT_NOT_ACTIVATED",
            "can_enter_gate": False,
            "can_enter_120s_gate": False,
            "should_loop_probe": True,
            "should_loop_30s_probe": True,
            "should_loop_30s_monitor": True,
            "dispatch_found": False,
            "recent_trajectory": [],
            "model_steps_count": 0,
            "tool_calls_count": 0,
            "thinking_steps_count": 0,
            "in_progress_steps_count": 0,
            "dimensions": {
                "presence": dimension_presence,
                "filesystem": dimension_fs,
                "inference_step": dimension_inference,
                "rpc": dimension_rpc
            },
            "reason": f"会话目录不存在: {session_dir}",
            "deep_link": f"conversation://{session_id}",
            "alert_card": f"[🔴 专题未激活告警卡]\n专题会话 ({session_id}) 尚未创建或无日志！请点击唤醒：\n[-> 点击切换并激活专题会话](conversation://{session_id})"
        }

    log_file = os.path.join(session_dir, ".system_generated", "logs", "transcript.jsonl")
    if not os.path.exists(log_file):
        log_file = os.path.join(session_dir, ".system_generated", "logs", "transcript_full.jsonl")

    # 维度 2: 文件系统物理状态与增量检测
    transcript_mtime = None
    transcript_mtime_ms = 0
    transcript_size = 0
    delta_bytes = None

    if os.path.exists(log_file):
        try:
            stat = os.stat(log_file)
            transcript_mtime_dt = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            transcript_mtime = transcript_mtime_dt.isoformat()
            transcript_mtime_ms = int(stat.st_mtime * 1000)
            transcript_size = stat.st_size
            if baseline_size is not None:
                delta_bytes = max(0, transcript_size - baseline_size)
        except Exception:
            pass

    mtime_diff_sec = int((now_ms - transcript_mtime_ms) / 1000) if transcript_mtime_ms > 0 else None
    has_recent_write = False

    if baseline_time:
        try:
            if isinstance(baseline_time, (int, float)):
                base_ms = int(baseline_time)
            else:
                base_iso = str(baseline_time).replace("Z", "+00:00")
                base_ms = int(datetime.fromisoformat(base_iso).timestamp() * 1000)
            has_recent_write = (transcript_mtime_ms >= (base_ms - 1000))
            if baseline_size is not None:
                has_recent_write = has_recent_write and (delta_bytes > 0)
        except Exception:
            pass
    elif mtime_diff_sec is not None:
        has_recent_write = (mtime_diff_sec <= fresh_window_sec)

    dimension_filesystem = {
        "transcript_path": log_file,
        "transcript_mtime": transcript_mtime,
        "transcript_size": transcript_size,
        "delta_bytes": delta_bytes,
        "has_recent_write": has_recent_write,
        "mtime_diff_sec": mtime_diff_sec
    }

    if not os.path.exists(log_file):
        dimension_inference = {
            "model_steps_count": 0,
            "tool_calls_count": 0,
            "thinking_steps_count": 0,
            "in_progress_steps_count": 0,
            "latest_model_step": None,
            "is_fresh": False,
            "step_age_sec": None,
            "thread_running_fresh": False
        }
        dimension_rpc = check_agentapi_rpc(session_id, options)

        return {
            "session_id": session_id,
            "found": False,
            "thread_running": False,
            "is_working": False,
            "working_status": "DORMANT_NOT_ACTIVATED",
            "can_enter_gate": False,
            "can_enter_120s_gate": False,
            "should_loop_probe": True,
            "should_loop_30s_probe": True,
            "should_loop_30s_monitor": True,
            "dispatch_found": False,
            "model_steps_count": 0,
            "tool_calls_count": 0,
            "thinking_steps_count": 0,
            "in_progress_steps_count": 0,
            "dimensions": {
                "presence": dimension_presence,
                "filesystem": dimension_filesystem,
                "inference_step": dimension_inference,
                "rpc": dimension_rpc
            },
            "reason": "未找到 transcript.jsonl 日志文件",
            "deep_link": f"conversation://{session_id}",
            "alert_card": f"[🔴 专题未激活告警卡]\n专题会话 ({session_id}) 尚未生成交互日志！请点击唤醒：\n[-> 点击切换并激活专题会话](conversation://{session_id})"
        }

    last_dispatch_index = -1
    last_dispatch_step = None
    steps = []

    try:
        with open(log_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
        idx = 0
        for line in lines:
            line_str = line.strip()
            if not line_str:
                continue
            try:
                parsed = json.loads(line_str)
                steps.append(parsed)
                text = parsed.get("content") or ""
                if not text and parsed.get("thinking"):
                    text = json.dumps(parsed.get("thinking"))
                if (
                    "[主会话派单" in text
                    or "【主会话派单" in text
                    or (parsed.get("type") == "USER_INPUT" and any(k in text for k in ["单一职责目标", "物理白名单", "派单任务"]))
                ):
                    last_dispatch_index = idx
                    last_dispatch_step = {
                        "step_index": parsed.get("step_index", idx),
                        "type": parsed.get("type"),
                        "created_at": parsed.get("created_at"),
                        "snippet": text[:100]
                    }
                idx += 1
            except Exception:
                pass
    except Exception as e:
        dimension_inference = {
            "model_steps_count": 0,
            "tool_calls_count": 0,
            "thinking_steps_count": 0,
            "in_progress_steps_count": 0,
            "latest_model_step": None,
            "is_fresh": False,
            "step_age_sec": None,
            "thread_running_fresh": False
        }
        dimension_rpc = check_agentapi_rpc(session_id, options)

        return {
            "session_id": session_id,
            "found": False,
            "thread_running": False,
            "is_working": False,
            "working_status": "DORMANT_NOT_ACTIVATED",
            "can_enter_gate": False,
            "can_enter_120s_gate": False,
            "should_loop_probe": True,
            "should_loop_30s_probe": True,
            "should_loop_30s_monitor": True,
            "dispatch_found": False,
            "model_steps_count": 0,
            "tool_calls_count": 0,
            "thinking_steps_count": 0,
            "in_progress_steps_count": 0,
            "dimensions": {
                "presence": dimension_presence,
                "filesystem": dimension_filesystem,
                "inference_step": dimension_inference,
                "rpc": dimension_rpc
            },
            "reason": f"读取日志异常: {e}",
            "deep_link": f"conversation://{session_id}"
        }

    if last_dispatch_index == -1:
        for i in range(len(steps) - 1, -1, -1):
            if steps[i].get("source") in ("USER_EXPLICIT", "SYSTEM") or steps[i].get("type") == "USER_INPUT":
                last_dispatch_index = i
                last_dispatch_step = {
                    "step_index": steps[i].get("step_index", i),
                    "type": steps[i].get("type"),
                    "created_at": steps[i].get("created_at"),
                    "snippet": (steps[i].get("content") or "")[:100]
                }
                break

    model_steps_after_dispatch = 0
    tool_calls_count = 0
    thinking_steps_count = 0
    in_progress_steps_count = 0
    thread_running = False
    latest_model_step = None

    for i in range(last_dispatch_index + 1, len(steps)):
        st = steps[i]
        is_model = st.get("source") == "MODEL" or st.get("type") == "PLANNER_RESPONSE"
        has_tool_calls = bool(st.get("tool_calls") and len(st.get("tool_calls")) > 0)
        has_thinking = bool(st.get("thinking"))
        is_in_progress = st.get("status") == "IN_PROGRESS"

        if has_tool_calls:
            tc = st.get("tool_calls")
            tool_calls_count += len(tc) if isinstance(tc, list) else 1
        if has_thinking:
            thinking_steps_count += 1
        if is_in_progress:
            in_progress_steps_count += 1
            thread_running = True

        if is_model or has_tool_calls or has_thinking or is_in_progress:
            model_steps_after_dispatch += 1
            latest_model_step = {
                "step_index": st.get("step_index", i),
                "type": st.get("type"),
                "status": st.get("status") or "DONE",
                "created_at": st.get("created_at"),
                "has_tool_calls": has_tool_calls,
                "has_thinking": has_thinking,
                "is_in_progress": is_in_progress
            }

    if len(steps) > 0 and steps[-1].get("status") == "IN_PROGRESS":
        thread_running = True

    # 维度 3: Step Freshness 时效强校验 (彻底根除历史步骤假阳性)
    is_step_fresh = False
    step_age_sec = None
    if latest_model_step and latest_model_step.get("created_at"):
        try:
            step_iso = latest_model_step["created_at"].replace("Z", "+00:00")
            step_dt = datetime.fromisoformat(step_iso)
            step_ms = int(step_dt.timestamp() * 1000)
            step_age_sec = int((now_ms - step_ms) / 1000)

            if baseline_time:
                if isinstance(baseline_time, (int, float)):
                    b_ms = int(baseline_time)
                else:
                    b_iso = str(baseline_time).replace("Z", "+00:00")
                    b_ms = int(datetime.fromisoformat(b_iso).timestamp() * 1000)
                is_step_fresh = (step_ms >= (b_ms - 1000))
            else:
                is_step_fresh = (step_age_sec <= fresh_window_sec)
        except Exception:
            pass

    thread_running_fresh = False
    if thread_running and len(steps) > 0:
        last_step = steps[-1]
        if last_step.get("created_at"):
            try:
                l_iso = last_step["created_at"].replace("Z", "+00:00")
                l_dt = datetime.fromisoformat(l_iso)
                l_ms = int(l_dt.timestamp() * 1000)
                l_age_sec = int((now_ms - l_ms) / 1000)
                if baseline_time:
                    if isinstance(baseline_time, (int, float)):
                        b_ms = int(baseline_time)
                    else:
                        b_iso = str(baseline_time).replace("Z", "+00:00")
                        b_ms = int(datetime.fromisoformat(b_iso).timestamp() * 1000)
                    thread_running_fresh = (l_ms >= (b_ms - 1000))
                else:
                    thread_running_fresh = (l_age_sec <= fresh_window_sec)
            except Exception:
                pass

    dimension_inference = {
        "model_steps_count": model_steps_after_dispatch,
        "tool_calls_count": tool_calls_count,
        "thinking_steps_count": thinking_steps_count,
        "in_progress_steps_count": in_progress_steps_count,
        "latest_model_step": latest_model_step,
        "is_fresh": is_step_fresh,
        "step_age_sec": step_age_sec,
        "thread_running_fresh": thread_running_fresh
    }

    # 维度 4: Daemon RPC 可达性
    dimension_rpc = check_agentapi_rpc(session_id, options)

    # 综合裁决逻辑 (Reconciliation Logic):
    is_working = bool(
        dimension_inference["is_fresh"]
        or dimension_inference["thread_running_fresh"]
        or (dimension_filesystem["has_recent_write"] and dimension_presence["is_present"])
    )

    can_enter_gate = is_working
    should_loop_probe = not is_working

    dimensions = {
        "presence": dimension_presence,
        "filesystem": dimension_filesystem,
        "inference_step": dimension_inference,
        "rpc": dimension_rpc
    }

    if is_working:
        alert_card = None
    else:
        presence_str = '🟢 在场' if dimension_presence['is_present'] else '⚪ 未打开/休眠'
        write_str = '🟢 近期有写入' if dimension_filesystem['has_recent_write'] else '⚪ 无近期写入'
        delta_str = f"增量: {dimension_filesystem['delta_bytes']}B" if dimension_filesystem['delta_bytes'] is not None else f"大小: {dimension_filesystem['transcript_size']}B"
        inf_str = '🟢 新鲜步骤' if dimension_inference['is_fresh'] else '🔴 无时效内步骤'
        age_str = f"{dimension_inference['step_age_sec']}s" if dimension_inference['step_age_sec'] is not None else '无'
        rpc_str = '🟢 可达' if dimension_rpc.get('available') else '⚪ 未激活'

        alert_card = (
            "[🔴 专题未激活告警卡]\n"
            f"专题会话 ({session_id}) 尚未进入大模型真实工作态 (4维物理交叉验证: 未检测到时效内的有效步骤与活跃写入)！\n"
            "【4维物理校验指标】:\n"
            f"* 在场锁 (Presence): {presence_str}\n"
            f"* 磁盘变更 (Filesystem): {write_str} ({delta_str})\n"
            f"* 推理时效 (Inference): {inf_str} (步骤距今: {age_str})\n"
            f"* RPC 可达 (Daemon): {rpc_str}\n"
            "【自愈与门禁规则】:\n"
            "1. 绝对严禁挂载 120s 巡检任务进入盲等！\n"
            "2. 立即通过 agentapi send-message 补发唤醒，或点击下方链接在 UI 中手动激活：\n"
            f"[-> 点击切换并激活专题会话](conversation://{session_id})\n"
            "3. 必须继续挂载 30s 进度监测器循环监控，直到真实激活。"
        )

    recent_tail = steps[-3:] if len(steps) >= 3 else steps
    recent_trajectory = []
    r_offset = len(steps) - len(recent_tail)
    for idx, st in enumerate(recent_tail):
        step_idx = st.get("step_index")
        if step_idx is None:
            step_idx = r_offset + idx
        tcs = st.get("tool_calls")
        tc_names = [tc.get("name") for tc in tcs if isinstance(tc, dict) and tc.get("name")] if isinstance(tcs, list) else []
        action_summary = st.get("type", "UNKNOWN")
        if tc_names:
            action_summary = f"tool_calls({', '.join(tc_names)})"
        elif st.get("thinking"):
            action_summary = "thinking"
        elif st.get("content"):
            action_summary = "content_output"

        th = st.get("thinking")
        thinking_prev = re.sub(r'\s+', ' ', th[:100]) if th else None

        recent_trajectory.append({
            "step_index": step_idx,
            "source": st.get("source", "UNKNOWN"),
            "type": st.get("type", "UNKNOWN"),
            "status": st.get("status", "DONE"),
            "created_at": st.get("created_at"),
            "action_summary": action_summary,
            "thinking_preview": thinking_prev
        })

    return {
        "session_id": session_id,
        "found": True,
        "thread_running": thread_running_fresh or thread_running,
        "is_working": is_working,
        "working_status": "WORKING_IN_PROGRESS" if is_working else "DORMANT_NOT_ACTIVATED",
        "can_enter_gate": can_enter_gate,
        "can_enter_120s_gate": can_enter_gate,
        "should_loop_probe": should_loop_probe,
        "should_loop_30s_probe": should_loop_probe,
        "should_loop_30s_monitor": should_loop_probe,
        "dispatch_found": (last_dispatch_index != -1),
        "dispatch_step_index": last_dispatch_index,
        "last_dispatch_step": last_dispatch_step,
        "recent_trajectory": recent_trajectory,
        "model_steps_count": model_steps_after_dispatch,
        "tool_calls_count": tool_calls_count,
        "thinking_steps_count": thinking_steps_count,
        "in_progress_steps_count": in_progress_steps_count,
        "latest_model_step": latest_model_step,
        "dimensions": dimensions,
        "deep_link": f"conversation://{session_id}",
        "alert_card": alert_card
    }


def main():
    parser = argparse.ArgumentParser(description="Antigravity Project Session Inspector & Progress Monitor")
    parser.add_argument("--root", default=".", help="Project root directory (default: .)")
    parser.add_argument("--brain-path", default=None, help="Custom AGY brain directory path")
    parser.add_argument("--active-window", type=int, default=30, help="Minutes to consider a session ACTIVE (default: 30)")
    parser.add_argument("--monitor-dispatch", default=None, help="Monitor target session for real MODEL execution post-dispatch (alias: --probe-dispatch)")
    parser.add_argument("--probe-dispatch", default=None, help="Alias for --monitor-dispatch")
    parser.add_argument("--dump-recent", default=None, help="Introspect recent execution trajectory (thinking, tools, content)")
    parser.add_argument("--tail", type=int, default=5, help="Number of recent steps to dump (default: 5)")
    parser.add_argument("--baseline-time", default=None, help="Dispatch baseline timestamp for freshness calculation")
    parser.add_argument("--baseline-size", type=int, default=None, help="Dispatch baseline transcript size in bytes")
    parser.add_argument("--fresh-window-sec", type=int, default=30, help="Window in seconds for fresh step calculation (default: 30)")
    parser.add_argument("--skip-rpc", action="store_true", help="Skip AgentAPI metadata query")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of table")
    args = parser.parse_args()

    if args.dump_recent:
        dump_result = fetch_session_transcript(
            args.dump_recent,
            brain_path=args.brain_path,
            tail=args.tail
        )
        if args.json:
            print(json.dumps(dump_result, ensure_ascii=False, indent=2))
        else:
            print_recent_trajectory(dump_result)
        sys.exit(0)

    target_dispatch_id = args.monitor_dispatch or args.probe_dispatch
    if target_dispatch_id:
        probe_result = probe_dispatch_session(
            target_dispatch_id,
            brain_path=args.brain_path,
            options={
                "baseline_time": args.baseline_time,
                "baseline_size": args.baseline_size,
                "fresh_window_sec": args.fresh_window_sec,
                "skip_rpc": args.skip_rpc
            }
        )
        print(json.dumps(probe_result, ensure_ascii=False, indent=2))
        sys.exit(0)

    report = inspect_agy_sessions(root=args.root, brain_path=args.brain_path, active_window=args.active_window)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_table(report)


if __name__ == "__main__":
    main()
