---
name: session-control
description: "[task-loop] Multi-vendor agent session provider, introspection, and lifecycle manager for ZCode, Antigravity, Codex, and Claude Code. Scans and parses conversation logs (ZCode db.sqlite/rollout JSONL included), manages SessionProvider primitives, and handles topic session routing."
---

# Session Control Topic Skill (`session-control`)

本文档为 `task-loop` 中【会话控制专题 (`session_control`)】的专属技能定义，负责跨厂商智能体会话抽象、反向内省、生命周期管理与专题路由。

![session-control 跨厂商会话控制与内省体系架构](assets/architecture.svg)

---

## 一、专题核心职责 (Core Responsibilities)

1. **跨厂商会话反向内省 (Reverse Introspection)**:
   - 自动扫描与解析 ZCode（`db.sqlite` 只读 + `rollout/model-io-sess_*.jsonl`）、AGY（`transcript.jsonl`）、Codex（`sessions/*.jsonl` / `CODEX_THREAD_ID`）与 Claude Code（`--resume` / `claude agents`）的历史交互。
2. **六大标准 SessionProvider 原语**:
   - `get_current_session_id`: 获取当前宿主会话 UUID。
   - `scan`: 扫描工程历史会话并提取最近 Prompt 与元数据。
   - `spawn`: 创建独立真实顶层会话（如 `agentapi new-conversation`）。
   - `send`: 定向跨会话发信（如 `send_message` / `claude -p`）。
   - `manage`: 状态查询、取消或资源回收。
   - `await_reply`: 等待目标会话回复或挂起。
3. **专题拓扑与状态机持久化**:
   - 维护 `.agents/task-loop/sessions.json` 与 `topics.json`，建立模块映射与主会话登记。

---

## 二、六大 SessionProvider 原语规范 (API Primitives JSON)

```json
[
  {
    "primitive": "get_current_session_id",
    "signature": "getCurrentSessionId() -> string | null",
    "description": "读取当前正在执行的会话 UUID（AGY: Hook context / transcript, Codex: CODEX_THREAD_ID, Claude: stdin JSON）。"
  },
  {
    "primitive": "scan",
    "signature": "scanSessions(options) -> SessionInfo[]",
    "description": "按工作区路径扫描历史会话日志，过滤非当前项目碎片。"
  },
  {
    "primitive": "spawn",
    "signature": "spawnSession(spec) -> string (newSessionId)",
    "description": "创建持久化独立顶层专题会话，返回真实根会话 ID。"
  },
  {
    "primitive": "send",
    "signature": "sendMessage(sessionId, message) -> SendResult",
    "description": "向已存在的持久专题会话定向发信，自动继承历史上下文。"
  },
  {
    "primitive": "manage",
    "signature": "manageSession(action, sessionId) -> ManageResult",
    "description": "会话生命周期治理（list / status / cancel / terminate）。"
  },
  {
    "primitive": "await_reply",
    "signature": "awaitReply(sessionId, timeout) -> ReplyResult",
    "description": "挂机等待专题会话处理完成并获取交付报告。"
  }
]
```

---

## 三、实战避坑指南 (Gotchas)

```json
[
  {
    "gotcha_id": "Gotcha 7",
    "title": "既有专题派单 vs 临时子代理",
    "rule": "已有长期专题必须优先使用 send_message 定向发信，自动继承历史记忆；严禁随意拉起空白瞬态子代理。"
  },
  {
    "gotcha_id": "Gotcha 8",
    "title": "跨会话发信 UI 呈现",
    "rule": "send_message 在 AGY IDE 中以折叠卡形式渲染于目标会话顶部，不伪造人类用户聊天气泡。"
  },
  {
    "gotcha_id": "Gotcha 10",
    "title": "主会话派单三步铁律",
    "rule": "1. 寻找专题 -> 2. 没有则 agentapi 新建真实顶层会话 -> 3. send_message 定向发信。"
  }
]
```

---

## 五、关联文档与受控记忆 (References)
* **专题受控记忆**: [`docs/memory/session_control.md`](../../docs/memory/session_control.md)
* **跨厂商 SDK 主索引**: [`references/sdk/README.md`](../../references/sdk/README.md)
* **ZCode 分支适配规范**: [`references/sdk/zcode.md`](../../references/sdk/zcode.md)
* **AGY SDK 手册**: [`references/sdk/agy.md`](../../references/sdk/agy.md)
* **Codex SDK 手册**: [`references/sdk/codex.md`](../../references/sdk/codex.md)
* **Claude SDK 手册**: [`references/sdk/claude.md`](../../references/sdk/claude.md)
