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


def find_prompt_templates(ws_root):
    candidates = [
        os.path.join(ws_root, "templates", "prompt_templates.json"),
        os.path.join(ws_root, ".agents", "task-loop", "templates", "prompt_templates.json"),
        os.path.join(os.path.dirname(__file__), "..", "..", "templates", "prompt_templates.json"),
        os.path.join(os.getcwd(), "templates", "prompt_templates.json")
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                with open(c, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return None


def find_active_todo(ws_root, conversation_id):
    candidates = [
        os.path.join(ws_root, ".agents", "task-loop", "todo.json"),
        os.path.join(os.getcwd(), ".agents", "task-loop", "todo.json")
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                with open(c, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    items = data.get("items", [])
                    if isinstance(items, list):
                        for item in items:
                            if item.get("assignee_thread_id") == conversation_id and item.get("status") in ["in_progress", "dispatched", "pending"]:
                                return item
            except Exception:
                pass
    return None


def get_session_details(conversation_id, session_data):
    if not session_data:
        return {
            "session_id": conversation_id,
            "is_main": False,
            "title": "未注册会话",
            "module_key": "unknown",
            "created_at": None,
            "last_active_at": None,
            "memory_docs": []
        }

    main_thread_id = session_data.get("main_thread_id")
    is_main = (main_thread_id == conversation_id)

    session_item = None
    sessions = session_data.get("sessions", [])
    if isinstance(sessions, list):
        for s in sessions:
            if s.get("session_id") == conversation_id:
                session_item = s
                break

    module_key = None
    mem_docs = []
    modules = session_data.get("modules", {})
    if isinstance(modules, dict):
        for k, v in modules.items():
            if isinstance(v, dict) and v.get("session_id") == conversation_id:
                module_key = k
                if v.get("memory_doc"):
                    mem_docs.append(v["memory_doc"])
                elif isinstance(v.get("memory_docs"), list):
                    mem_docs.extend(v["memory_docs"])
                break

    if session_item and isinstance(session_item.get("memory_docs"), list) and len(session_item["memory_docs"]) > 0:
        mem_docs = session_item["memory_docs"]

    title = "专题会话"
    if session_item and session_item.get("title"):
        title = session_item["title"]
    elif is_main:
        title = "[主会话] 任务编排 & 治理中枢"

    return {
        "session_id": conversation_id,
        "is_main": (session_item.get("is_main") if (session_item and "is_main" in session_item) else is_main),
        "title": title,
        "module_key": module_key or ("main" if is_main else "unknown"),
        "created_at": session_item.get("created_at") if session_item else None,
        "last_active_at": session_item.get("last_active_at") if session_item else None,
        "summary": session_item.get("summary") if session_item else (f"专题模块: {module_key}" if module_key else None),
        "memory_docs": mem_docs or []
    }


def get_plugin_topic_rules(details, templates):
    plugin_rules = (templates.get("plugin_rules") if templates else None) or (templates.get("rules") if templates else None) or {}
    lines = []

    if details.get("is_main"):
        main_rules = plugin_rules.get("main_session")
        if main_rules and isinstance(main_rules, list):
            lines.extend(main_rules)
        else:
            lines.append("- [Plugin: task-loop | 主会话约束规则]:")
            lines.append("  1. 职责边界: 主会话严禁参与任何实际业务代码修改，所有代码更改必须派单至对应专题会话;")
            lines.append("  2. 需求加工与定界: 理解用户意图，提炼单一职责目标、验收准则与任务类型 ([EXPLORE] 或 [WORK]);")
            lines.append("  3. 防冲突与复用: 派发前强制比对现有专题清单 (modules/tags/docs/memory)，复用优先，严禁重复创建重叠专题;")
            lines.append("  4. 任务派单流程: 寻找专题 -> 没有则调用 agentapi new-conversation 新建 -> send_message 定向发信，划定 Allowlist 物理白名单;")
            lines.append("  5. 复杂度分级调度: Level 1 就地闭环，Level 2 标准派单自测，Level 3 临时 Subagent 并行协作;")
            lines.append("  6. 质检与门禁核验: 依据子会话测试与证据验收，输出用户验证指引卡 (参考 references/dispatch-contract.md 与 skills/task-loop/SKILL.md)。")
    elif details.get("module_key") == "session_control":
        sess_rules = plugin_rules.get("session_control")
        if sess_rules and isinstance(sess_rules, list):
            lines.extend(sess_rules)
        else:
            lines.append("- [Plugin: task-loop | 会话控制专题规则]:")
            lines.append("  1. 职责范围: 负责跨厂商会话日志反向内省与 SessionProvider 六大标准原语实现与维护;")
            lines.append("  2. 拓扑与受控记忆: 严守只读安全，维护 .agents/task-loop/sessions.json 与受控记忆 docs/memory/session_control.md。")
    elif details.get("module_key") == "subagent":
        sub_rules = plugin_rules.get("subagent")
        if sub_rules and isinstance(sub_rules, list):
            lines.extend(sub_rules)
        else:
            lines.append("- [Plugin: task-loop | 子代理专题规则]:")
            lines.append("  1. 职责范围: 负责 AGY 原生子代理编排原语 (invoke/define/manage) 治理与 Workspace 隔离模式;")
            lines.append("  2. 原生兜底工作流: 简单任务直接就地改动闭环；复杂未知任务开启 explore + worker + viewer 三角色子代理协作 (各类型建议不超过3个);")
            lines.append("  3. 短路迭代与异常中断: 审查未通过直接让 worker 改动 (避免二次长链路重新 explore); worker 中途发现意外/异常须立即停止并反馈专题会话统筹 (参考 references/default-fallback-workflow.md);")
            lines.append("  4. 协作与生命周期: 严格遵循响应式唤醒 (Reactive Wakeup，严禁轮询) 与瞬态代理 vs 持久根会话边界，维护 docs/memory/subagent.md。")
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
            lines.append("  1. 领域攻坚与闭环: 负责所属领域专业排查与代码实施，严守任务 Allowlist 物理白名单;")
            lines.append("  2. 兜底执行工作流: 简单目标直接改动；复杂目标调度 explore -> worker -> viewer，评判失败直接 worker 改动，中途遇异常立即停下反馈专题统筹 (参考 references/default-fallback-workflow.md);")
            lines.append("  3. 标准执行流程: 承接锁定 -> 边界实施 -> 本地自测 (单测 Exit Code 0) -> 记忆沉淀 (docs/memory/*.md) -> 标准结构化交付。")

    # 检查是否手动开启 Hook 提示词 dump 调试开关 (默认 false)
    is_hook_dump_enabled = (os.environ.get("ENABLE_HOOK_PROMPT_DUMP") == "true") or \
                           (templates and templates.get("enable_footer_hook_dump") is True)
    if is_hook_dump_enabled:
        lines.append("- [Plugin: task-loop | 尾部声明约束]: 在回复结尾除列出【引用规则与记忆文档】外，还须列出当轮【触发的 Hook 提示词】清单 (仅限 [Plugin: task-loop | 开头的实际 Hook 注入项，每项超 50 字截断并加 '...' 省略)。")

    return lines


def generate_injection_message(conversation_id, session_data, active_todo, templates=None):
    details = get_session_details(conversation_id, session_data)
    header_namespace = (templates.get("header_namespace") if templates else None) or (templates.get("plugin_namespace") if templates else None) or "[Plugin: task-loop | 会话上下文感知]"
    
    parts = [header_namespace]
    parts.append(f"- 会话 ID: {details['session_id']}")
    parts.append(f"- 是否主会话: {'是 (Main Thread)' if details['is_main'] else '否 (Topic Session)'}")
    parts.append(f"- 专题主题: {details['title']}")

    if details.get("module_key") and details["module_key"] != "unknown":
        parts.append(f"- 所属模块: {details['module_key']}")
    if details.get("created_at"):
        parts.append(f"- 创建时间: {details['created_at']}")
    if details.get("last_active_at"):
        parts.append(f"- 最近更新: {details['last_active_at']}")

    if details["is_main"]:
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
    parts.extend(get_plugin_topic_rules(details, templates))

    return "\n".join(parts)


def process_payload(payload):
    try:
        conversation_id = payload.get("conversationId")
        if not conversation_id and "ANTIGRAVITY_CONVERSATION_ID" in os.environ:
            conversation_id = os.environ["ANTIGRAVITY_CONVERSATION_ID"]

        if not conversation_id:
            return {"injectSteps": []}

        ws_root = resolve_workspace_root(payload.get("workspacePaths"))
        session_data = find_sessions_registry(ws_root)
        templates = find_prompt_templates(ws_root)
        active_todo = find_active_todo(ws_root, conversation_id)

        ephemeral_text = generate_injection_message(conversation_id, session_data, active_todo, templates)

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
