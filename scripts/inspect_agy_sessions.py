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


def main():
    parser = argparse.ArgumentParser(description="Antigravity Project Session Inspector & State Probe")
    parser.add_argument("--root", default=".", help="Project root directory (default: .)")
    parser.add_argument("--brain-path", default=None, help="Custom AGY brain directory path")
    parser.add_argument("--active-window", type=int, default=30, help="Minutes to consider a session ACTIVE (default: 30)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of table")
    args = parser.parse_args()

    report = inspect_agy_sessions(root=args.root, brain_path=args.brain_path, active_window=args.active_window)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_table(report)


if __name__ == "__main__":
    main()
