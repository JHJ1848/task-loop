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
import re

try:
    from . import host_vendor
except ImportError:
    import host_vendor

UUID_SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass


VENDOR_ALIASES = {
    "agy": "antigravity",
    "antigravity": "antigravity",
    "zcode": "zcode",
    "z-code": "zcode",
    "codex": "codex",
    "claude": "claude",
    "claude-code": "claude",
    "claudecode": "claude",
}


def normalize_vendor(name):
    if not name:
        return None
    key = str(name).strip().lower()
    if key in VENDOR_ALIASES:
        return VENDOR_ALIASES[key]
    return key if re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", key) else None


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
    vendor = normalize_vendor(target_vendor)
    if ws_root:
        if vendor:
            candidates.append(os.path.join(ws_root, ".agents", "task-loop", f"sessions.{vendor}.json"))
        candidates.extend([
            os.path.join(ws_root, ".agents", "task-loop", "sessions.json"),
            os.path.join(ws_root, ".agents", "sessions.json")
        ])
    if os.getcwd() and os.getcwd() != ws_root:
        if vendor:
            candidates.append(os.path.join(os.getcwd(), ".agents", "task-loop", f"sessions.{vendor}.json"))
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
    roots = [ws_root]
    if os.getcwd() and os.getcwd() != ws_root:
        roots.append(os.getcwd())
    for root in roots:
        tpl_path = os.path.join(root, "templates", "prompt_templates.json")
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


def detect_vendor_from_session_id(session_id: str, fallback_vendor: str = None) -> str:
    # Session ID shapes are shared or vendor-specific aliases owned by an explicit adapter.
    # The generic AGY hook must never infer ZCode from sess_* or CLAUDE_SESSION_ID.
    return normalize_vendor(fallback_vendor)


def resolve_target_vendor(payload, conversation_id):
    if payload.get("vendor"):
        return normalize_vendor(payload["vendor"])
    if os.environ.get("CODEX_THREAD_ID") and (not conversation_id or os.environ.get("CODEX_THREAD_ID") == conversation_id):
        return "codex"
    if os.environ.get("CODEX_SESSION_ID") and (not conversation_id or os.environ.get("CODEX_SESSION_ID") == conversation_id):
        return "codex"
    if os.environ.get("ZCODE_SESSION_ID") and (not conversation_id or os.environ.get("ZCODE_SESSION_ID") == conversation_id):
        return "zcode"
    if os.environ.get("ANTIGRAVITY_CONVERSATION_ID") and (not conversation_id or os.environ.get("ANTIGRAVITY_CONVERSATION_ID") == conversation_id):
        return "antigravity"
    if isinstance(conversation_id, str) and conversation_id.lower().startswith("sess_"):
        return None
    return "antigravity" if isinstance(conversation_id, str) and not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        conversation_id,
        re.IGNORECASE,
    ) else None


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

    effective_vendor = normalize_vendor(target_vendor) or detect_vendor_from_session_id(conversation_id)

    if effective_vendor == "codex":
        return {
            "session_id": conversation_id,
            "is_main": False,
            "is_unregistered": True,
            "title": "Codex vendor unsupported",
            "module_key": "unknown",
            "created_at": None,
            "last_active_at": None,
            "summary": None,
            "memory_docs": []
        }

    # 1. 如果包含 vendors 分区 (Schema v4 / v3)
    if isinstance(session_data.get("vendors"), dict):
        vendor_data = session_data["vendors"].get(effective_vendor) if effective_vendor else None
        if vendor_data:
            v_details = match_in_vendor_data(conversation_id, vendor_data)
            if not v_details["is_unregistered"]:
                return v_details

        return match_in_vendor_data(conversation_id, vendor_data)

    # 2. 顶层单厂商匹配 (Schema v2 或当前 vendor 顶层数据)
    return match_in_vendor_data(conversation_id, session_data)


def extract_main_thread_id(session_data, target_vendor=None):
    if not session_data or not isinstance(session_data, dict):
        return None
    if isinstance(session_data.get("vendors"), dict):
        effective_vendor = normalize_vendor(target_vendor)
        vendor_data = session_data["vendors"].get(effective_vendor) if effective_vendor else None
        return vendor_data.get("main_thread_id") if isinstance(vendor_data, dict) else None
    return session_data.get("main_thread_id") or None


def get_plugin_topic_rules(details, templates, main_thread_id=None):
    plugin_rules = (templates.get("plugin_rules") if templates else None) or (templates.get("rules") if templates else None) or {}
    lines = []

    if details.get("is_unregistered"):
        if main_thread_id:
            lines.append(f"- [Plugin: task-loop | 会话提示]: 当前会话未在 task-loop 状态机中注册。本项目主治理中枢为 {main_thread_id}。当前会话严禁执行 /init 初始化或擅自创建专题会话。若需执行任务，请等待主会话派单或向主会话请示。")
        else:
            lines.append("- [Plugin: task-loop | 会话提示]: 当前会话未在 task-loop 状态机中注册。当前项目尚未初始化，可运行 /init 初始化主治理中枢。")
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
            lines.append("  6. 专题职责正交对齐与严禁跨界污染 (Strict Topic Ownership & Anti-Pollution): 严禁逮着同一个活跃会话持续薅！派单前必须严格根据修改文件的物理路径与领域职责 (如 scripts/hooks 归 hook, providers/session 归 session_control, subagent 归 subagent, install/plugin 归 plugin_spec) 精确路由到法定专题。严禁把无关改动塞入其他专题导致上下文与 KV Cache 污染；若为全新业务需求，必须通过 /new-session 建立独立业务专题;")
            lines.append("  7. 缺失专题与不明确流转铁律: 若无可用专题会话或不清楚如何新建/请求会话，必须先查阅文档指导 (references/sdk/README.md, skills/new-session/SKILL.md, skills/session-control/SKILL.md)，若仍需确认必须主动向用户请求指引并询问，绝对禁止主会话自主擅自派遣子代理 Worker 逃避专题治理;")
            lines.append("  8. 任务派单流转与权责核验 (Dispatch Workflow & Seam Gate): 寻找专题 -> 没有则按规范创建顶层专题会话 -> 派单前必须在思维链中核验拟下发 Allowlist 物理文件是否 100% 属于目标专题权责 (严禁搭便车派单) -> sidebus (send_message) 定向发信，划定 Allowlist 物理白名单;")
            lines.append("  9. 复杂度分级调度: Level 1 就地派单，Level 2 标准派单自测，Level 3 专题会话内 Subagent 并行协作;")
            # [task-026 对齐] 落实 task-025 架构重塑：四大绝对门禁与双轮驱动质检 (轮1需求逆向比对 + 轮2宏观上下文深度质检)
            lines.append("  10. 四大绝对门禁与双轮驱动质检 (Dual-Engine Verification & Loop Rejection): 严禁充当传声筒盲目轻信放行！主会话必须严格执行双轮驱动质检与四大绝对门禁：① 门禁1 (原有逻辑破坏防御): 逐行逆向审视 Diff，严禁专题擅自删除或弱化旧有 if 校验、业务门禁、前置条件或提前落盘，发现违规必须下发 DELIVERABLE_REJECTED 驳回重修；② 门禁2 (最小改动自证与注释溯源): 核验《最小改动自证说明》与代码改动原因注释，超出 Allowlist 或无关重构一律驳回；③ 门禁3 (双轮驱动质检与全局风险评估): 执行【轮1: 需求清单逐项逆向比对】(排查遗漏与假交付 GOTCHA-001/003) 与【轮2: 宏观上下文深度质检】(防误伤误改/防分支冲突/推演状态机乱序/边界空值/并发原子性风险)；④ 门禁4 (Loop 闭环仲裁与主动打回): 门禁未 100% 全过时主动打回专题修复，杜绝让用户充当质检员 (参考 references/dispatch-contract.md 与 gotchas.md);")
            # [task-026 对齐] 动态监督与双阶梯巡检
            lines.append("  11. 双阶梯进度监测与动态监督机制 (Dynamic Progress Supervision & Inspection): 派单后挂载 30s 进度监测器 (schedule DurationSeconds=30)。30s 触发时执行 node scripts/inspect_agy_sessions.js --monitor-dispatch <session_id> 检查真活跃 (thread_running/is_working)；定期审视目标专题的思考链 (Thinking) 与工具调用 (Tool Calls)，识别死循环、走弯路或消极退化特征并主动纠偏，杜绝消极挂起。【门禁分流】: ① 若 is_working === false (未见 MODEL 步/未激活)，绝对严禁挂载 120s 巡检任务！必须立即出具【🔴 专题未激活告警卡】、调用 agentapi.bat send-message 补发唤醒，并继续挂载 30s 进度监测器循环监控直至激活；② 仅当确凿返回 is_working === true (检测到线程工作) 时，才准入挂载 120s 巡检任务 (参考 references/dispatch-contract.md 与 gotchas.md)。")
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
            lines.append("  3. 智能派遣门槛与防干等: 严禁单子代理串行干等反模式！必须满足并发度 >= 2 (多分支并发加速) 或存在 Workspace='branch' 物理强隔离沙箱需求时才允许派遣子代理，单线任务一律由专题自身直接执行 (参考 references/default-fallback-workflow.md);")
            lines.append("  4. 短路迭代与异常中断: 审查未通过直接让 worker 改动 (避免二次长链路重新 explore); worker 中途发现意外/异常须立即停止并反馈专题会话统筹;")
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
            lines.append("  3. 专题内子代理协同门槛: 仅在满足并发度 >= 2 (多分支并发加速) 或物理强隔离沙箱时才允许拉起子代理，严禁单子代理串行让专题干等，单线任务一律由专题自身直接实施闭环;")
            # [task-026 对齐] 专题自主语法检查与功能自测，并提供最小改动自证与注释溯源
            lines.append("  4. 标准执行与自查流程: 承接锁定 -> 边界实施 (附带代码注释溯源) -> 专题自主语法检查与功能自测 -> 记忆沉淀 (docs/memory/*.md) -> 强制提供包含最小改动自证、注释溯源、原有逻辑自查与自测证据的规范交付物并通过 sidebus 汇报。")

    # 专题会话收尾强制发信契约注入 (对于所有非主会话的已注册专题会话生效，且目标主会话不能为自身，杜绝自发自收死循环)
    if not details.get("is_main"):
        target_main_id = main_thread_id or "<main_thread_id>"
        if target_main_id != details.get("session_id"):
            lines.append("- [Plugin: task-loop | 专题强制收尾与反向汇报契约]:")
            # [task-026 对齐] 任务收尾自主自测通过后，必须反向发信向主会话汇报交付物
            lines.append("  1. 任务收尾必发信: 当在本专题会话中完成功能开发、修复或自主自测通过后，严禁仅在当前窗口输出文本结束！")
            lines.append(f"  2. 强制调用 send_message: 必须且强制在最后一轮调用 send_message(recipient=\"{target_main_id}\", message=\"[专题交付: WORK]...\") 向主治理中枢汇报包含【核心摘要、最小改动自证、代码注释溯源、原有逻辑审查、改动清单与自主自测证据】的结构化交付报告，触发主会话双轮驱动质检与四大绝对门禁验收！")

    # 检查是否手动开启 Hook 提示词 dump 调试开关 (默认 false)
    is_hook_dump_enabled = (os.environ.get("ENABLE_HOOK_PROMPT_DUMP") == "true") or \
                           (templates and templates.get("enable_footer_hook_dump") is True)
    if is_hook_dump_enabled:
        lines.append("- [Plugin: task-loop | 尾部声明约束]: 在回复结尾除列出【引用规则与记忆文档】外，还须列出当轮【触发的 Hook 提示词】清单 (仅限 [Plugin: task-loop | 开头的实际 Hook 注入项，每项超 50 字截断并加 '...' 省略)。")

    return lines


def extract_session_id(payload, env=None):
    if env is None:
        env = os.environ
    return (
        payload.get("conversationId")
        or payload.get("conversation_id")
        or payload.get("sessionId")
        or payload.get("session_id")
        or env.get("ANTIGRAVITY_CONVERSATION_ID")
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


def extract_event_name(payload):
    raw = payload.get("hook_event_name") or payload.get("hookEventName") or ""
    if raw in ("SessionStart", "UserPromptSubmit"):
        return raw
    return "UserPromptSubmit"


def compute_lifecycle_state(details, active_todo):
    if active_todo:
        status = active_todo.get("status") or "in_progress"
        if status in ("in_progress", "dispatched"):
            return {
                "label": "[⚡ 工作中 (WORKING)]",
                "code": "WORKING",
                "desc": f"当前指派任务 [{active_todo.get('id', 'Task')}]: {active_todo.get('title', '')}"
            }
        elif status == "rejected":
            return {
                "label": "[⚠️ 质检打回重修中 (REVISING)]",
                "code": "REVISING",
                "desc": f"任务 [{active_todo.get('id', 'Task')}] 被驳回重修，请重点审查驳回清单中的逻辑破坏项"
            }
        elif status == "awaiting_approval":
            return {
                "label": "[⏳ 等待审批中 (AWAITING_APPROVAL)]",
                "code": "AWAITING_APPROVAL",
                "desc": "当前正在等待主会话白名单或方案审批"
            }
        else:
            return {
                "label": f"[⚡ 任务中 ({status.upper()})]",
                "code": status.upper(),
                "desc": f"当前任务 [{active_todo.get('id', 'Task')}]"
            }

    if details.get("is_main"):
        return {
            "label": "[🧭 治理与调度中 (ORCHESTRATING)]",
            "code": "ORCHESTRATING",
            "desc": "作为主治理中枢，仅限只读探索与任务编排，严禁自身修改业务代码"
        }

    if not details.get("is_unregistered"):
        return {
            "label": "[🟢 空闲待命 (IDLE)]",
            "code": "IDLE",
            "desc": "当前无挂起任务，处于待命状态；请等待主会话派单，禁止擅自修改业务代码"
        }

    return {
        "label": "[⚪ 未注册 (UNREGISTERED)]",
        "code": "UNREGISTERED",
        "desc": "未在 task-loop 状态机中注册"
    }


def compute_fleet_overview(session_data, ws_root, target_vendor=None):
    if not session_data or not isinstance(session_data, dict):
        return None
    effective_vendor = normalize_vendor(target_vendor)
    modules = None
    if isinstance(session_data.get("vendors"), dict) and effective_vendor and effective_vendor in session_data["vendors"]:
        modules = session_data["vendors"][effective_vendor].get("modules")
    elif isinstance(session_data.get("modules"), dict):
        modules = session_data["modules"]
    if not modules or not isinstance(modules, dict):
        return None

    active_todos = []
    todo_path = os.path.join(ws_root, ".agents", "task-loop", "todo.json")
    if os.path.exists(todo_path):
        try:
            with open(todo_path, "r", encoding="utf-8") as f:
                todo_data = json.load(f)
            if isinstance(todo_data.get("items"), list):
                for item in todo_data["items"]:
                    if item.get("status") in ("in_progress", "dispatched"):
                        active_todos.append(item)
        except Exception:
            pass

    parts = []
    for mod_key, mod_val in modules.items():
        if not mod_val or not isinstance(mod_val, dict):
            continue
        sess_id = mod_val.get("session_id")
        matched_todo = next((t for t in active_todos if t.get("assignee_thread_id") == sess_id or t.get("assignee") == mod_key), None)
        if matched_todo:
            parts.append(f"{mod_key} [⚡ WORKING: {matched_todo.get('id', 'Task')}]")
        else:
            parts.append(f"{mod_key} [🟢 IDLE]")

    return " | ".join(parts) if parts else None


def generate_injection_message(conversation_id, session_data, active_todo, templates=None, vendor=None, dynamic_context=None):
    if dynamic_context is None:
        dynamic_context = {}
    details = get_session_details(conversation_id, session_data, vendor)
    header_namespace = (templates.get("header_namespace") if templates else None) or (templates.get("plugin_namespace") if templates else None) or "[Plugin: task-loop | 会话上下文感知]"
    
    parts = [header_namespace]
    parts.append(f"- 会话 ID: {details['session_id']}")
    
    if details.get("is_unregistered"):
        parts.append("- 是否主会话: 待定 (Unregistered)")
    else:
        parts.append(f"- 是否主会话: {'是 (Main Thread)' if details['is_main'] else '否 (Topic Session)'}")
    parts.append(f"- 专题主题: {details['title']}")

    # 动态运行状态注入
    lifecycle = compute_lifecycle_state(details, active_todo)
    parts.append(f"- 运行状态: {lifecycle['label']}")

    invocation_num = dynamic_context.get("invocationNum") or dynamic_context.get("invocation_num")
    if invocation_num is not None:
        parts.append(f"- 交互轮次: 第 {invocation_num} 轮推理 (Turn #{invocation_num})")

    if details.get("is_main"):
        ws_root = dynamic_context.get("wsRoot") or resolve_workspace_root([])
        fleet = compute_fleet_overview(session_data, ws_root, vendor)
        if fleet:
            parts.append(f"- 专题集群态势: {fleet}")

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
    elif not details.get("is_main") and not details.get("is_unregistered"):
        parts.append("- 待命指引: 当前无进行中任务，处于空闲待命状态；请等待主会话派单，严禁擅自修改业务代码。")

    # 专属专题规则与约束 (全部带有 [Plugin: task-loop | 前缀)
    main_thread_id = extract_main_thread_id(session_data, vendor)
    parts.extend(get_plugin_topic_rules(details, templates, main_thread_id))

    return "\n".join(parts)


def process_payload(payload, env=None, argv=None):
    try:
        if env is None:
            env = os.environ
        if argv is None:
            argv = sys.argv
        if not isinstance(payload, dict):
            payload = {}

        conversation_id = extract_session_id(payload, env)
        ws_root = resolve_workspace(payload, env)
        declared_vendor = host_vendor.resolve_vendor(payload, env, argv)

        is_zcode_protocol = bool(
            payload.get("requested_vendor") == "zcode"
            or payload.get("hook_event_name")
            or payload.get("hookEventName")
            or payload.get("requested_event")
            or ("--event" in argv)
            or (payload.get("cwd") and not isinstance(payload.get("workspacePaths"), list))
            or env.get("CLAUDE_SESSION_ID")
            or env.get("CLAUDE_CODE_SESSION_ID")
            or env.get("ZCODE_SESSION_ID")
            or env.get("ZCODE_PROJECT_DIR")
            or env.get("CLAUDE_PROJECT_DIR")
            or (conversation_id and conversation_id.startswith("sess_"))
            or declared_vendor in ("zcode", "claude")
        )

        if is_zcode_protocol:
            if not conversation_id:
                return {}
            if not declared_vendor and not conversation_id.startswith("sess_") and UUID_SESSION_ID.match(conversation_id):
                return {}
            vendor = declared_vendor or "zcode"

            should_dedupe = not payload.get("isTest") and not payload.get("skipDedupe")
            if should_dedupe and not check_and_acquire_dedupe_lock(conversation_id):
                return {}

            event_name = extract_event_name(payload)
            if payload.get("requested_event") == "SessionStart" or ("SessionStart" in argv):
                event_name = "SessionStart"

            session_data = find_sessions_registry(ws_root, vendor)
            templates = find_prompt_templates(ws_root)
            active_todo = find_active_todo(ws_root, conversation_id)

            dynamic_context = {
                "wsRoot": ws_root,
                "invocationNum": payload.get("invocationNum") or payload.get("invocation_num") or payload.get("turn")
            }

            additional_context = generate_injection_message(conversation_id, session_data, active_todo, templates, vendor, dynamic_context)

            return {
                "hookSpecificOutput": {
                    "hookEventName": event_name,
                    "additionalContext": additional_context
                },
                "suppressOutput": True
            }

        # 默认 AGY 协议
        target_vendor = resolve_target_vendor(payload, conversation_id)
        if target_vendor == "codex":
            return {
                "supported": False,
                "vendor": "codex",
                "hook": "PreInvocation",
                "status": "unsupported",
                "reasonCode": "CODEX_AUTOMATIC_HOOK_UNSUPPORTED",
                "reason": "Codex automatic PreInvocation hook is unsupported; no context injection was performed."
            }

        if not conversation_id and "ANTIGRAVITY_CONVERSATION_ID" in env:
            conversation_id = env["ANTIGRAVITY_CONVERSATION_ID"]

        if not conversation_id or not target_vendor:
            return {"injectSteps": []}

        should_dedupe = not payload.get("isTest") and not payload.get("skipDedupe")
        if should_dedupe and not check_and_acquire_dedupe_lock(conversation_id):
            return {"injectSteps": []}

        session_data = find_sessions_registry(ws_root, target_vendor)
        templates = find_prompt_templates(ws_root)
        active_todo = find_active_todo(ws_root, conversation_id)

        dynamic_context = {
            "wsRoot": ws_root,
            "invocationNum": payload.get("invocationNum") if payload.get("invocationNum") is not None else payload.get("invocation_num")
        }

        ephemeral_text = generate_injection_message(conversation_id, session_data, active_todo, templates, target_vendor, dynamic_context)

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

    if "--event" in sys.argv:
        try:
            idx = sys.argv.index("--event")
            if idx + 1 < len(sys.argv) and sys.argv[idx + 1] == "SessionStart":
                payload["hook_event_name"] = "SessionStart"
        except Exception:
            pass

    result = process_payload(payload, os.environ, sys.argv)
    if not result:
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

