# [SDK Index] 跨 Agent 厂商会话控制 SDK 体系规范

本文档定义了 `task-loop` 中跨厂商会话（Session / Subagent / Thread）操作的标准抽象接口，并汇聚了 Google Antigravity、OpenAI Codex 与 Anthropic Claude Code 三大厂商的原生 SDK 规范文档。

---

## 一、通用会话控制抽象层 (Unified Session Control Interface)

```text
┌─────────────────────────────────────────────────────────────┐
│                 SessionProvider 统一抽象接口                 │
├─────────────────────────────────────────────────────────────┤
│ • get_current_session_id() -> conversation_id / session_id  │
│ • scan_project_sessions(project_root) -> SessionMetadata[]  │
│ • spawn(role, prompt, workspace, model) -> conversation_id  │
│ • send(conversation_id, message_payload) -> void            │
│ • manage(action: 'list'|'kill'|'status', conversation_ids)  │
│ • await_reply() -> Reactive Wakeup / Event Callback         │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、厂商 SDK 规范索引 (Vendor SDK Documentation)

```json
[
  {
    "vendor": "Google Antigravity (AGY)",
    "doc_path": "references/sdk/agy.md",
    "official_docs_path": "references/sdk/antigravity-official-docs.md",
    "status": "主力支持 (Primary Native)",
    "capabilities": [
      "上下文注入 (Conversation ID)",
      "原生子代理拉起 (invoke_subagent)",
      "动态模板声明 (define_subagent)",
      "智能体间通信 (send_message)",
      "系统级独立会话新建与通信 (agentapi CLI: new-conversation / send-message)",
      "常驻后台守护与定时调度 (Sidecars: ~/.gemini/config/sidecars/)",
      "状态监控与熔断 (manage_subagents)",
      "零 Token 响应式事件驱动 (Reactive Wakeup)",
      "官方 Python SDK (pip install google-antigravity)"
    ]
  },
  {
    "vendor": "OpenAI Codex",
    "doc_path": "references/sdk/codex.md",
    "status": "预留适配 (Standard Adapter)",
    "capabilities": [
      "运行时适配 (CODEX_THREAD_ID / CODEX_SESSION_ID)",
      "Desktop 宿主工具 (create_thread, send_message_to_thread, wait_threads)",
      "CLI 续接 (codex exec resume)",
      "官方 TypeScript / Python SDK",
      "MCP 协议调用 (codex / codex-reply)",
      "进程级 JSON-RPC (codex app-server)"
    ]
  },
  {
    "vendor": "Anthropic Claude Code",
    "doc_path": "references/sdk/claude.md",
    "status": "预留适配 (Standard Adapter)",
    "capabilities": [
      "Hooks 事件管道注入 (.session_id)",
      "活动会话查询 (claude agents --json)",
      "无头模式批处理 (claude -p --output-format json)",
      "会话分叉与续接 (--resume, --fork-session)",
      "流式双向管道 (stream-json)",
      "官方 Agent SDK (claude-agent-sdk)"
    ]
  }
]
```

---

## 三、官方权威参考源与文档归档

```json
[
  {
    "name": "Google Antigravity SDK 官方源码仓库",
    "url": "https://github.com/google-antigravity/antigravity-sdk-python.git",
    "type": "Git Repository"
  },
  {
    "name": "Google Antigravity 官方在线 SDK 文档",
    "url": "https://antigravity.google/docs/sdk/overview",
    "type": "Online Documentation"
  },
  {
    "name": "Google Antigravity 官方 Sidecars 文档",
    "url": "https://antigravity.google/docs/sidecars/",
    "type": "Online Documentation"
  },
  {
    "name": "Antigravity SDK 官方文档精简归档",
    "doc_path": "references/sdk/antigravity-official-docs.md",
    "type": "Local Markdown Archive"
  }
]
```

