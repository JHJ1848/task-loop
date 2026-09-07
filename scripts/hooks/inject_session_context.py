#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[Hook Script] Inject Session Context (PreInvocation)

Google Antigravity PreInvocation Hook
1. 从 stdin (或环境变量) 获取当前会话 ID (conversationId)
2. 匹配 sessions.json 获取会话基础信息 (是否主会话 / 主题 / ID / 创建时间 / 更新时间 / 关联记忆等)
3. 读取 templates/prompt_templates.json 标准化模板
4. 仅注入属于本 Plugin 范围的会话感知与专属规则 (全部带 [Plugin: task-loop | 前缀)，零污染全局外部规范

Input: stdin JSON ({ conversationId, workspacePaths, modelName, invocationNum, ... })
Output: stdout JSON ({ injectSteps: [{ ephemeralMessage: "..." }] })
"""

import os
import sys
import json

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass


def normalize_path(p):
    if not p:
        return ""
    return p.replace("\\", "/")


def resolve_workspace_root(workspace_paths):
    if workspace_paths and isinstance(workspace_paths, list) and len(workspace_paths) > 0:
        return workspace_paths[0]
    return os.getcwd()


def find_sessions_registry(ws_root, target_vendor=None):
    candidates = []
    if ws_root:
        if target_vendor:
            candidates.append(os.path.join(ws_root, ".agents", "task-loop", f"sessions.{target_vendor}.json"))
        candidates.extend([
            os.path.join(ws_root, ".agents", "task-loop", "sessions.json"),
            os.path.join(ws_root, ".agents", "sessions.json")
        ])
    if os.getcwd() and os.getcwd() != ws_root:
        if target_vendor:
            candidates.append(os.path.join(os.getcwd(), ".agents", "task-loop", f"sessions.{target_vendor}.json"))
        candidates.extend([
            os.path.join(os.getcwd(), ".agents", "task-loop", "sessions.json"),
            os.path.join(os.getcwd(), ".agents", "sessions.json")
        ])
    for c in candidates:
        if os.path.exists(c):
            try:
                with open(c, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return None


def find_prompt_templates(ws_root):
    tpl_path = os.path.join(ws_root, ".agents", "task-loop", "prompt-templates.json")
    if os.path.exists(tpl_path):
        try:
            with open(tpl_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return None


def find_active_todo(ws_root, conversation_id):
    todo_path = os.path.join(ws_root, ".agents", "task-loop", "todo.json")
    if os.path.exists(todo_path):
        try:
            with open(todo_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                items = data.get("items", [])
                for item in items:
                    if item.get("assignee_thread_id") == conversation_id and item.get("status") == "in_progress":
                        return item
        except Exception:
            pass
    return None


def match_in_vendor_data(conversation_id, data):
    if not data or not isinstance(data, dict):
        return {
            "session_id": conversation_id,
            "is_main": False,
            "is_unregistered": True,
            "title": "未注册会话 (Unregistered Session)",
            "module_key": "unknown",
            "created_at": None,
            "last_active_at": None,
            "summary": None,
            "memory_docs": []
        }

    main_thread_id = data.get("main_thread_id")
    is_main = (main_thread_id == conversation_id)

    session_item = None
    sessions = data.get("sessions", [])
    if isinstance(sessions, list):
        for s in sessions:
            if s.get("session_id") == conversation_id:
                session_item = s
                break

    module_key = None
    mem_docs = []
    modules = data.get("modules", {})
    if isinstance(modules, dict):
        for k, v in modules.items():
            if isinstance(v, dict) and v.get("session_id") == conversation_id:
                module_key = k
                if v.get("memory_doc"):
                    mem_docs.append(v["memory_doc"])
                elif isinstance(v.get("memory_docs"), list):
                    mem_docs.extend(v["memory_docs"])
                break

    is_registered = bool(is_main or session_item or module_key)

    if not is_registered:
        return {
            "session_id": conversation_id,
            "is_main": False,
            "is_unregistered": True,
            "title": "未注册会话 (Unregistered Session)",
            "module_key": "unknown",
            "created_at": None,
            "last_active_at": None,
            "summary": None,
            "memory_docs": []
        }

    if session_item and isinstance(session_item.get("memory_docs"), list) and len(session_item["memory_docs"]) > 0:
        mem_docs = session_item["memory_docs"]

    final_is_main = session_item.get("is_main") if (session_item and "is_main" in session_item) else is_main
    if final_is_main and not mem_docs:
        mem_docs = ["docs/MEMORY.md"]

    title = "专题会话"
    if session_item and session_item.get("title"):
        title = session_item["title"]
    elif is_main:
        title = "[主会话] 任务编排 & 治理中枢"

    return {
        "session_id": conversation_id,
        "is_main": final_is_main,
        "is_unregistered": False,
        "title": title,
        "module_key": module_key or ("main" if is_main else "unknown"),
        "created_at": session_item.get("created_at") if session_item else None,
        "last_active_at": session_item.get("last_active_at") if session_item else None,
        "summary": session_item.get("summary") if session_item else (f"专题模块: {module_key}" if module_key else None),
        "memory_docs": mem_docs or []
    }


def detect_vendor_from_session_id(session_id: str, fallback_vendor: str = "antigravity") -> str:
    if not session_id or not isinstance(session_id, str):
        return fallback_vendor or "antigravity"
    if session_id.startswith("sess_"):
        return "zcode"
    import re
    if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", session_id, re.IGNORECASE):
        return "antigravity"
    return fallback_vendor or "antigravity"


def check_and_acquire_dedupe_lock(conversation_id: str) -> bool:
    import tempfile
    import time
    dedupe_lock = os.path.join(tempfile.gettempdir(), f".task-loop-hook-{conversation_id or 'default'}.lock")
    now = time.time()

    try:
        fd = os.open(dedupe_lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(str(int(now * 1000)))
        return True
    except FileExistsError:
        try:
            content = ""
            try:
                with open(dedupe_lock, "r", encoding="utf-8") as f:
                    content = f.read().strip()
            except Exception:
                pass

            if content.isdigit():
                ts_ms = int(content)
                age_sec = (now * 1000 - ts_ms) / 1000.0
                if 0 <= age_sec < 2.0:
                    return False

            mtime = os.path.getmtime(dedupe_lock)
            if 0 <= (now - mtime) < 2.0:
                return False

            try:
                os.remove(dedupe_lock)
            except Exception:
                pass

            fd2 = os.open(dedupe_lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd2, "w", encoding="utf-8") as f:
                f.write(str(int(now * 1000)))
            return True
        except Exception:
            return False
    except Exception:
        return False


def get_session_details(conversation_id, session_data, target_vendor=None):
    if not session_data:
        return {
            "session_id": conversation_id,
            "is_main": False,
            "is_unregistered": True,
            "title": "未注册会话 (Unregistered Session)",
            "module_key": "unknown",
            "created_at": None,
            "last_active_at": None,
            "summary": None,
            "memory_docs": []
        }

    effective_vendor = target_vendor or detect_vendor_from_session_id(conversation_id, "antigravity")

    # 1. 如果包含 vendors 分区 (Schema v4 / v3)
    if isinstance(session_data.get("vendors"), dict):
        if effective_vendor in session_data["vendors"]:
            v_details = match_in_vendor_data(conversation_id, session_data["vendors"][effective_vendor])
            if not v_details["is_unregistered"]:
                return v_details

        # 跨所有 vendor 分区匹配
        for v_key, v_data in session_data["vendors"].items():
            if v_key == effective_vendor:
                continue
            v_details = match_in_vendor_data(conversation_id, v_data)
            if not v_details["is_unregistered"]:
                return v_details

    # 2. 顶层单厂商匹配 (Schema v2 或当前 vendor 顶层数据)
    return match_in_vendor_data(conversation_id, session_data)


def extract_main_thread_id(session_data, target_vendor=None):
    if not session_data or not isinstance(session_data, dict):
        return None
    effective_vendor = target_vendor or "antigravity"
    if isinstance(session_data.get("vendors"), dict) and effective_vendor in session_data["vendors"]:
        v = session_data["vendors"][effective_vendor]
        if isinstance(v, dict) and v.get("main_thread_id"):
            return v["main_thread_id"]
    if session_data.get("main_thread_id"):
        return session_data["main_thread_id"]
    if isinstance(session_data.get("vendors"), dict):
        for v in session_data["vendors"].values():
            if isinstance(v, dict) and v.get("main_thread_id"):
                return v["main_thread_id"]
    return None


def get_plugin_topic_rules(details, templates, main_thread_id=None):
    plugin_rules = (templates.get("plugin_rules") if templates else None) or (templates.get("rules") if templates else None) or {}
    lines = []

    if details.get("is_unregistered"):
        lines.append("- [Plugin: task-loop | 会话提示]: 当前会话未在 task-loop 状态机中注册。若需作为主治理中枢，可运行 /init 进行初始化。")
        return lines

    if details.get("is_main"):
        main_rules = plugin_rules.get("main_session")
        if main_rules and isinstance(main_rules, list):
            lines.extend(main_rules)
        else:
            lines.append("- [Plugin: task-loop | 主会话定位与治理硬约束]:")
            lines.append("  1. 仅限只读探索 (Explore Only): 主会话仅限执行需求初加工、只读探测与架构诊断 (EXPLORE)，严禁主会话自身直接执行修改落地 (WORK) 或直接编辑业务代码;")
            lines.append("  2. 强制 sidebus 派单执行 (Mandatory Sidebus Delegation): 所有具体的业务代码修改、功能落地与 BugFix (WORK) 强制要求通过 sidebus (send_message / agentapi) 派单至对应的专题会话 (Topic Session) 实施，杜绝主会话直接修改或擅自派遣临时 Worker 造成的上下文错乱与业务冲突;")
            lines.append("  3. 主会话子代理派遣权限严格受限 (Reviewer & Explorer Only): 主会话严禁派遣 Worker (落地/写代码子代理)，主会话仅限派遣 reviewer (代码审查走查) 与 explorer / research (架构只读探索);")
            lines.append("  4. 实体会话与 KV Cache 价值: 主会话与专题会话为长期存在的物理会话实体 (Permanent Physical Session Entities)，常驻 IDE 左侧边栏列表中，存储历史积累并极大提升大模型 Prompt Token Cache (KV Cache) 命中率，大幅降低延迟与成本;")
            lines.append("  5. 需求定界与白名单: 提炼单一职责目标、验收准则与严格的物理白名单 (Allowlist)，明确任务类型 ([EXPLORE] 或 [WORK]);")
            lines.append("  6. 防冲突与复用: 派发前强制比对现有专题清单 (modules/tags/docs/memory)，复用优先，严禁重复创建重叠专题;")
            lines.append("  7. 缺失专题与不明确流转铁律: 若无可用专题会话或不清楚如何新建/请求会话，必须先查阅文档指导 (references/sdk/README.md, skills/new-session/SKILL.md, skills/session-control/SKILL.md)，若仍需确认必须主动向用户请求指引并询问，绝对禁止主会话自主擅自派遣子代理 Worker 逃避专题治理;")
            lines.append("  8. 任务派单流转: 寻找专题 -> 没有则按规范创建顶层专题会话 -> sidebus (send_message) 定向发信，划定 Allowlist 物理白名单;")
            lines.append("  9. 复杂度分级调度: Level 1 就地派单，Level 2 标准派单自测，Level 3 专题会话内 Subagent 并行协作;")
            lines.append("  10. 批判性门禁核验与杜绝盲目透传 (Critical Verification Gate & Anti-Rubber-Stamp): 严禁充当传声筒盲目轻信专题汇报！主会话必须执行四步独立质检：① 独立执行自动化单测/构建命令获取真实 Exit Code 0 证据；② 真实 Diff 审查，走查改动是否 100% 严格在 Allowlist 内且无冗余代码与格式污染；③ 必要时派遣 reviewer 子代理交叉走查；④ 验收通过方可更新状态，未通过强制下发 DELIVERABLE_REJECTED 驳回重修 (参考 references/dispatch-contract.md 与 skills/task-loop/SKILL.md);")
            lines.append("  11. 看门狗 30s 探针门禁循环与 120s 准入机制 (Watchdog 30s Probe Gate Loop & 120s Audit Admission): 派单后挂载 30s 探针 (schedule DurationSeconds=30)。30s 触发时必须执行 node scripts/inspect_agy_sessions.js --probe-dispatch <session_id> 检查真活跃 (thread_running/is_working)。【门禁分流】: ① 若 is_working === false (未见 MODEL 步/未激活)，绝对严禁挂载 120s 定时器！必须立即出具【🔴 专题未激活告警卡】、调用 agentapi.bat send-message 补发唤醒，并继续挂载 30s 探针循环监控直至激活；② 仅当确凿返回 is_working === true (检测到线程工作) 时，才准入挂载 120s 偏差巡检定时器 (参考 references/dispatch-contract.md)。")
    elif details.get("module_key") == "session_control":
        sess_rules = plugin_rules.get("session_control")
        if sess_rules and isinstance(sess_rules, list):
            lines.extend(sess_rules)
        else:
            lines.append("- [Plugin: task-loop | 会话控制专题规则]:")
            lines.append("  1. 职责范围: 负责跨厂商会话日志反向内省与 SessionProvider 六大标准原语实现与维护;")
            lines.append("  2. 物理实体会话治理: 维护长期常驻物理会话拓扑与状态机持久化 (.agents/task-loop/sessions.json 与 docs/memory/session_control.md)，保障大模型 KV Cache 高效复用。")
    elif details.get("module_key") == "subagent":
        sub_rules = plugin_rules.get("subagent")
        if sub_rules and isinstance(sub_rules, list):
            lines.extend(sub_rules)
        else:
            lines.append("- [Plugin: task-loop | 子代理专题规则]:")
            lines.append("  1. 职责范围: 负责 AGY 原生子代理编排原语 (invoke/define/manage) 治理与 Workspace 隔离模式;")
            lines.append("  2. 定位与边界: 子代理 (subagents / workers) 仅为专题会话内部按需临时拉起的轻量隔离沙箱，任务完成后即销毁；主会话禁止派遣 Worker 子代理，仅可派遣 reviewer / explorer;")
            lines.append("  3. 原生兜底工作流: 简单任务直接就地改动闭环；复杂未知任务开启 explore + worker + viewer 三角色子代理协作 (各类型建议不超过3个);")
            lines.append("  4. 短路迭代与异常中断: 审查未通过直接让 worker 改动 (避免二次长链路重新 explore); worker 中途发现意外/异常须立即停止并反馈专题会话统筹 (参考 references/default-fallback-workflow.md);")
            lines.append("  5. 协作与生命周期: 严格遵循响应式唤醒 (Reactive Wakeup，严禁轮询) 与瞬态代理 vs 持久物理实体会话边界，维护 docs/memory/subagent.md。")
    elif details.get("module_key") == "hook":
        hook_rules = plugin_rules.get("hook")
        if hook_rules and isinstance(hook_rules, list):
            lines.extend(hook_rules)
        else:
            lines.append("- [Plugin: task-loop | 钩子专题规则]:")
            lines.append("  1. 职责范围: 负责 AGY 五大生命周期钩子系统维护 (PreInvocation 瞬态注入 / PreToolUse 白名单硬门禁 / PostToolUse / PostInvocation / Stop);")
            lines.append("  2. 协议与输出约束: 严守 ephemeralMessage 瞬态注入防历史污染、stdout 纯净输出与 camelCase 命名，维护 docs/memory/hook.md。")
    else:
        generic_rules = plugin_rules.get("generic_topic")
        if generic_rules and isinstance(generic_rules, list):
            lines.extend(generic_rules)
        else:
            lines.append("- [Plugin: task-loop | 专题会话约束规则]:")
            lines.append("  1. 物理实体与领域深耕: 作为长期常驻 IDE 侧边栏的物理会话实体，持续沉淀领域上下文并最大化大模型 KV Cache 命中率;")
            lines.append("  2. 领域攻坚与闭环: 负责所属领域专业排查与代码实施，严守任务 Allowlist 物理白名单;")
            lines.append("  3. 专题内子代理协同: 专题会话承接任务后，可按需在专题内拉起子代理 (subagents) 进行多任务拆解协同或直接落地实施;")
            lines.append("  4. 标准执行流程: 承接锁定 -> 边界实施 -> 本地自测 (单测 Exit Code 0) -> 记忆沉淀 (docs/memory/*.md) -> 强制调用 send_message 完成交付汇报。")

    # 专题会话收尾强制发信契约注入 (对于所有非主会话的已注册专题会话生效，且目标主会话不能为自身，杜绝自发自收死循环)
    if not details.get("is_main"):
        target_main_id = main_thread_id or "<main_thread_id>"
        if target_main_id != details.get("session_id"):
            lines.append("- [Plugin: task-loop | 专题强制收尾与反向汇报契约]:")
            lines.append("  1. 任务收尾必发信: 当在本专题会话中完成功能开发、修复或自测通过后，严禁仅在当前窗口输出文本结束！")
            lines.append(f"  2. 强制调用 send_message: 必须且强制在最后一轮调用 send_message(recipient=\"{target_main_id}\", message=\"[专题交付: WORK]...\") 向主治理中枢汇报结构化交付报告 (Summary, Changes, Evidence)，触发主会话门禁验收！")

    # 检查是否手动开启 Hook 提示词 dump 调试开关 (默认 false)
    is_hook_dump_enabled = (os.environ.get("ENABLE_HOOK_PROMPT_DUMP") == "true") or \
                           (templates and templates.get("enable_footer_hook_dump") is True)
    if is_hook_dump_enabled:
        lines.append("- [Plugin: task-loop | 尾部声明约束]: 在回复结尾除列出【引用规则与记忆文档】外，还须列出当轮【触发的 Hook 提示词】清单 (仅限 [Plugin: task-loop | 开头的实际 Hook 注入项，每项超 50 字截断并加 '...' 省略)。")

    return lines


def generate_injection_message(conversation_id, session_data, active_todo, templates=None, vendor=None):
    details = get_session_details(conversation_id, session_data, vendor)
    header_namespace = (templates.get("header_namespace") if templates else None) or (templates.get("plugin_namespace") if templates else None) or "[Plugin: task-loop | 会话上下文感知]"
    
    parts = [header_namespace]
    parts.append(f"- 会话 ID: {details['session_id']}")
    
    if details.get("is_unregistered"):
        parts.append("- 是否主会话: 待定 (Unregistered)")
    else:
        parts.append(f"- 是否主会话: {'是 (Main Thread)' if details['is_main'] else '否 (Topic Session)'}")
    parts.append(f"- 专题主题: {details['title']}")

    if not details.get("is_unregistered") and details.get("module_key") and details["module_key"] != "unknown":
        parts.append(f"- 所属模块: {details['module_key']}")
    if details.get("created_at"):
        parts.append(f"- 创建时间: {details['created_at']}")
    if details.get("last_active_at"):
        parts.append(f"- 最近更新: {details['last_active_at']}")

    if details.get("is_unregistered"):
        parts.append("- 角色定位: [待定 / 初始会话]")
    elif details["is_main"]:
        parts.append("- 角色定位: [主会话 / 治理中枢]")
    else:
        parts.append("- 角色定位: [专题会话 / 领域负责人]")
        if details.get("summary"):
            parts.append(f"- 专题概述: {details['summary']}")

    if details.get("memory_docs") and len(details["memory_docs"]) > 0:
        parts.append(f"- 关联记忆文档: {', '.join(details['memory_docs'])}")

    if active_todo:
        parts.append(f"- 当前指派任务 [{active_todo.get('id', 'Task')}]: {active_todo.get('title', '')}")
        allowlist = active_todo.get("allowlist", [])
        if allowlist:
            parts.append(f"- 物理文件白名单 (Allowlist): [{', '.join(allowlist)}]")
        if active_todo.get("complexity"):
            parts.append(f"- 任务复杂度: Level {active_todo.get('complexity')}")

    # 专属专题规则与约束 (全部带有 [Plugin: task-loop | 前缀)
    main_thread_id = extract_main_thread_id(session_data, vendor)
    parts.extend(get_plugin_topic_rules(details, templates, main_thread_id))

    return "\n".join(parts)


def process_payload(payload):
    try:
        conversation_id = payload.get("conversationId") or payload.get("conversation_id") or payload.get("sessionId") or payload.get("session_id")
        if not conversation_id and "ANTIGRAVITY_CONVERSATION_ID" in os.environ:
            conversation_id = os.environ["ANTIGRAVITY_CONVERSATION_ID"]

        if not conversation_id:
            return {"injectSteps": []}

        # 避免工作区插件与全局用户插件同时触发 PreInvocation 产生重复注入 (只要非测试模式即执行 2000ms 独占排他去重)
        should_dedupe = not payload.get("isTest") and not payload.get("skipDedupe")

        if should_dedupe and not check_and_acquire_dedupe_lock(conversation_id):
            return {"injectSteps": []}

        ws_root = resolve_workspace_root(payload.get("workspacePaths"))
        target_vendor = payload.get("vendor") or ("zcode" if os.environ.get("ZCODE_SESSION_ID") else ("codex" if os.environ.get("CODEX_THREAD_ID") else detect_vendor_from_session_id(conversation_id, "antigravity")))
        session_data = find_sessions_registry(ws_root, target_vendor)
        templates = find_prompt_templates(ws_root)
        active_todo = find_active_todo(ws_root, conversation_id)

        ephemeral_text = generate_injection_message(conversation_id, session_data, active_todo, templates, target_vendor)

        return {
            "injectSteps": [
                {
                    "ephemeralMessage": ephemeral_text
                }
            ]
        }
    except Exception:
        return {"injectSteps": []}


def main():
    raw_input = ""
    try:
        raw_input = sys.stdin.read()
    except Exception:
        raw_input = ""

    payload = {}
    if raw_input.strip():
        try:
            payload = json.loads(raw_input)
        except Exception:
            payload = {}
    else:
        if "--payload" in sys.argv:
            try:
                idx = sys.argv.index("--payload")
                if idx + 1 < len(sys.argv):
                    payload = json.loads(sys.argv[idx + 1])
            except Exception:
                payload = {}

    result = process_payload(payload)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
