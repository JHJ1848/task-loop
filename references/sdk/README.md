# [SDK Index] 跨厂商智能体控制 SDK 体系规范

本文档定义了 `task-loop` 中跨厂商智能体（Google Antigravity、OpenAI Codex 与 Anthropic Claude Code）的核心解耦架构规范，涵盖 **Hook 拦截与上下文注入**、**Session 会话调度与状态持久化** 以及 **Question 原生问答与选项交互** 三大核心支柱，并定义不新增 runtime 的 **Execution/Capability/Authority Context** 跨切面边界。

---

## 一、三大跨厂商解耦支柱与执行边界 (Three Pillars + Execution Boundary)

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   task-loop 跨厂商智能体解耦体系架构                   │
├──────────────────┬──────────────────────┬──────────────────────────────┤
│ 1. Hook 体系     │ 2. Session 体系      │ 3. Question 体系             │
│ (references/sdk/ │ (references/sdk/     │ (references/sdk/             │
│  hook.md)        │  session.md)         │  question.md)                │
├──────────────────┼──────────────────────┼──────────────────────────────┤
│ • PreInvocation  │ • get_current_id()   │ • ask_user_choice()          │
│   瞬态上下文注入 │ • scan_sessions()    │ • confirm_action()           │
│ • PreToolUse     │ • spawn() / send()   │ • 杜绝纯文本手打选项红线     │
│   白名单物理门禁 │ • manage()           │ • 原生交互模态与单键降级     │
│ • 零污染项目规则 │ • Schema v4 分区状态 │ • 决策推演与门禁审批统一     │
└──────────────────┴──────────────────────┴──────────────────────────────┘
```

QuestionProvider 是现有契约支柱，继续负责原生问答、选项和确认交互；下述第四项是跨切面执行边界，不是新的运行时或第四个 Provider。

```json
{
  "boundary": "Execution/Capability/Authority Context",
  "fields": [
    "host capability",
    "workspace environment",
    "role model/reasoning",
    "write permission/lifecycle"
  ],
  "codex_formal_id_rule": "只接受 formal threadId/thread_id；clientThreadId/queued -> PENDING_CREATION",
  "codex_model_precedence": ["用户显式选择", "既有 session.model_config", "role 默认"]
}
```

```json
[
  {
    "pillar": "Hook 生命周期与安全拦截",
    "doc_path": "references/sdk/hook.md",
    "core_features": [
      "PreInvocation 会话感知与瞬态治理规则注入，实现零污染 AGENTS.md",
      "PreToolUse 工具调用前 Allowlist 物理白名单硬门禁拦截",
      "ALLOWLIST_EXPANSION_REQUEST 反向审批双向闭环机制",
      "Node.js (18+) 与 Python (3.8+) 双轨标准库零依赖实现"
    ]
  },
  {
    "pillar": "SessionProvider 会话调度与持久化",
    "doc_path": "references/sdk/session.md",
    "core_features": [
      "六大标准原语: get_current_session_id, scan, spawn, send, manage, await_reply",
      "Schema v4 顶层厂商独立分区持久化与物理镜像文件 (sessions.<vendor>.json)",
      "粘性绑定保护 (Sticky Binding Lock) 机制",
      "双阶梯看门狗: 30s 响应探针循环与 120s 偏差巡检门禁"
    ]
  },
  {
    "pillar": "QuestionProvider 原生问答与选项交互",
    "doc_path": "references/sdk/question.md",
    "core_features": [
      "彻底杜绝纯文本提问 ('请回复确认落盘') 不良惯性与脆弱交互",
      "优先且强制调用宿主原生问答组件 (AGY ask_question / Codex Desktop 选项 / Claude Confirm)",
      "推荐项标注 (Recommended) 与用户第一人称响应视角规范",
      "Node.js 与 Python 双轨交互单键降级保障"
    ]
  }
]
```

---

## 二、聚焦三大厂商 SDK 深度对接规范 (Three Focus Vendors)

```json
[
  {
    "vendor": "Google Antigravity (AGY)",
    "doc_path": "references/sdk/agy.md",
    "official_docs_path": "references/sdk/antigravity-official-docs.md",
    "status": "主力支持 (Primary Native)",
    "capabilities": [
      "原生问答交互: ask_question 交互式模态弹窗与选项",
      "生命周期 Hook: PreInvocation 动态注入, PreToolUse 物理拦截",
      "原生子代理拉起: invoke_subagent / define_subagent",
      "跨会话通信: send_message 原生工具与 agentapi CLI 管道",
      "后台守护与事件唤醒: Reactive Wakeup 零 Token 挂起机制",
      "官方 Python SDK 与 Node.js 原生标准库双轨对接"
    ]
  },
  {
    "vendor": "OpenAI Codex",
    "doc_path": "references/sdk/codex.md",
    "status": "宿主能力适配 (Host-Capability Adapter)",
    "capabilities": [
      "交互选择组件与 CLI 单字符快速按键选项降级",
      "环境变量注入: CODEX_THREAD_ID / CODEX_SESSION_ID 读取",
      "Desktop App Tools 探测与 CLI 消息队列 (codex queue)",
      "/init 与 /new-session 缺失专题的 list_projects -> create_thread -> formal bind 闭环",
      "structuredContent/嵌套回执解析；clientThreadId/queued 显式 PENDING_CREATION",
      "创建期专属模型与推理深度策略 (Main: Astra, Topic: Terra, Subagent: Luna)",
      "状态持久化: vendors.codex 专属隔离分区"
    ]
  },
  {
    "vendor": "Anthropic Claude Code",
    "doc_path": "references/sdk/claude.md",
    "status": "预留适配 (Standard Adapter)",
    "capabilities": [
      "终端原生交互确认原语 (Confirm / Select)",
      "Hooks 管道: stdin JSON 提取 .session_id 与 Exit Code 2 拦截",
      "活动会话查询: claude agents --json",
      "无头模式派发: claude -p --output-format json",
      "会话分叉与续接 (--resume, --fork-session)"
    ]
  }
]
```

---

## 三、双轨运行时优先策略 (Dual-Runtime Policy)

1. **Node.js (18+) Primary 黄金事实源**：核心工作流工具、会话调度与 Hook 脚本强制优先使用 Node.js 执行，全量采用原生内置模块构建，零 npm 依赖；
2. **Python (3.8+) 标准库等价薄适配**：同步维护零 pip 依赖的标准库 Python 实现，作为跨平台兼容与无 Node 环境下的高兼容兜底备选；
3. **双向契约对拍**：通过 `test_contract_parity.test.js` 严格核验状态机、Hook 逻辑与会话探针跨运行时等价性。

---

## 四、权威参考源与文档归档

```json
[
  {
    "name": "Hook 生命周期规范",
    "doc_path": "references/sdk/hook.md",
    "type": "Architecture Specification"
  },
  {
    "name": "SessionProvider 规范",
    "doc_path": "references/sdk/session.md",
    "type": "Architecture Specification"
  },
  {
    "name": "QuestionProvider 规范",
    "doc_path": "references/sdk/question.md",
    "type": "Architecture Specification"
  },
  {
    "name": "Antigravity SDK 官方文档精简归档",
    "doc_path": "references/sdk/antigravity-official-docs.md",
    "type": "Local Markdown Archive"
  },
  {
    "name": "Google Antigravity SDK 官方源码仓库",
    "url": "https://github.com/google-antigravity/antigravity-sdk-python.git",
    "type": "Git Repository"
  }
]
```
