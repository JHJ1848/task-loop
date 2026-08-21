# Cross-Agent Session Control SDK Reference

本文档定义了 `task-loop` 中跨厂商会话（Session / Subagent / Thread）操作的标准抽象接口与各平台原生工具映射规范，供人类开发者与 AI 会话检索调用。

---

## 一、通用会话控制抽象层 (Unified Session Control Interface)

```
┌─────────────────────────────────────────────────────────────┐
│                 SessionProvider 统一抽象接口                 │
├─────────────────────────────────────────────────────────────┤
│ • spawn(role, prompt, workspace, model) -> conversation_id  │
│ • send(conversation_id, message_payload) -> void            │
│ • manage(action: 'list'|'kill'|'status', conversation_ids)  │
│ • await_reply() -> Reactive Wakeup / Event Callback         │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、各厂商 SDK 接口与工具映射表

### 1. [AGY] Google Antigravity 原生 SDK 接口（优先全面暴露）

Antigravity 提供了原生的高性能 Subagent 工具链，支持真正的异步独立会话上下文与免轮询唤醒：

| 操作分类 | 原生 Tool 名称 | 核心参数与签名 | 功能说明与最佳实践 |
|---|---|---|---|
| **拉起新会话 / 子代理** | `invoke_subagent` | `Subagents: [{ TypeName: 'self'\|'research'\|string, Role: string, Prompt: string, Workspace: 'inherit'\|'branch'\|'share', Model: 'inherit'\|'flash'\|'pro' }]` | **创建并启动子会话**。<br/>• `TypeName: 'self'` 继承父代理全量工具与上下文能力；<br/>• `Workspace: 'inherit'` 共享当前项目目录。 |
| **动态定义代理模板** | `define_subagent` | `name: string, description: string, system_prompt: string, enable_write_tools: bool, enable_subagent_tools: bool` | 声明新的专用代理类型（如 `reviewer`, `worker`），供 `invoke_subagent` 反复拉起。 |
| **跨会话发送消息** | `send_message` | `Recipient: string (conversation_id), Message: string` | **向目标会话投递指令/任务包**。<br/>• 仅用于 Agent 间通信，严禁用于与人类用户通信。 |
| **会话生命周期管理** | `manage_subagents` | `Action: 'list'\|'kill'\|'kill_all', ConversationIds?: string[]` | **状态监控与强制介入**：<br/>• `list`：查询活动子会话实时状态 (`running`, `idle`, `waiting_for_input`, `errored`)；<br/>• `kill`：终止走弯路或超时的子会话及其派生树。 |
| **挂机等待与唤醒** | **Reactive Wakeup** | *(无须工具调用，系统原生事件驱动)* | **零 Token 纯响应式挂机**：发出任务后主会话直接结束当前轮工具调用，子会话完成或发信时系统自动唤醒主会话，严禁写循环 polling。 |

#### 典型调用示例（AGY 环境）：
```json
// 1. 下发任务至专题子会话
{
  "name": "invoke_subagent",
  "args": {
    "Subagents": [
      {
        "TypeName": "self",
        "Role": "Markdown Preview Worker",
        "Prompt": "请根据任务包 LOOP-002 执行 Markdown 预览修复，文件白名单：src/main/resources/static/md-preview.html...",
        "Workspace": "inherit",
        "Model": "inherit"
      }
    ]
  }
}

// 2. 超时或违规时的干预与终止
{
  "name": "manage_subagents",
  "args": {
    "Action": "kill",
    "ConversationIds": ["71b5580c-929e-4c03-b29f-bd4d4fb28046"]
  }
}
```

---

### 2. [Codex] OpenAI Codex 会话 SDK 接口（标准适配插槽）

| 操作分类 | 接口 / 工具名 | 参数规范 | 功能说明 |
|---|---|---|---|
| **向既有会话发信** | `send_message_to_thread` | `thread_id: string, message: string` | 向 `sessions.json` 中已注册的长期 Topic 线程发送任务数据包。 |
| **新建项目会话** | `create_conversation` | `title: string, workspace_path: string` | 创建并初始化一个同项目归属的新会话线程。 |
| **读取会话状态** | `get_thread_status` | `thread_id: string` | 查询目标线程是否处于 idle / busy 状态。 |

---

### 3. [Claude Code] Anthropic Claude Code 会话接口（预留扩展插槽）

| 操作分类 | 机制 / 接口 | 参数规范 | 说明 |
|---|---|---|---|
| **管道化派发** | `claude-cli / subprocess` | `--session-id <ID> --prompt <PROMPT>` | 通过 CLI 管道派发子任务。 |
| **钩子与事件监听** | `UserPromptSubmit / Stop Hook` | `root: string, event: string` | 状态事件记录与观测。 |

---

## 三、官方文档与参考规范汇总

* **Google Antigravity 官方指南**：
  * Antigravity Customization & Skills System Guide (`agy-customizations`)
  * Antigravity Subagent Orchestration Specification (`antigravity_guide`)
* **OpenAI Codex 会话规范**：
  * [Codex Thread & Dispatch Reference](./dispatch-contract.md)
* **Anthropic Claude Code 官方文档**：
  * [Claude Code Documentation](https://docs.anthropic.com/claude/docs/claude-code)
