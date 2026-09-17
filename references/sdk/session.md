# [SDK Session] 跨厂商 SessionProvider 抽象与状态机持久化规范

本文档定义了 `task-loop` 中跨厂商会话（Session / Subagent / Thread）控制的标准抽象接口 `SessionProvider`，聚焦 Google Antigravity、OpenAI Codex 与 Anthropic Claude Code 三大主流厂商，规范化会话发现、启动、发信、管理与响应式唤醒机制，并定义 Schema v4 状态机持久化架构。

---

## 一、SessionProvider 统一架构与设计哲学 (Architecture & Principles)

### 1. 抹平异构环境差异 (Heterogeneous Environment Parity)
在多厂商 AI 协同研发中，各平台对“会话”的定义、交互协议与存储格式差异巨大：
* Google Antigravity 采用顶层 Conversation 与即时 Subagent 双层结构，依托 Language Server Sidebus 跨会话发信；
* OpenAI Codex 采用 Thread/Project 结构，依赖环境变量 `CODEX_THREAD_ID` 与 Desktop App Tools/CLI；
* Anthropic Claude Code 采用项目哈希目录存储 `.jsonl`，依赖 Hooks stdin JSON 提取会话 ID，并通过无头 `-p` 派发任务。

`SessionProvider` 建立高度一致的抽象层，将上层调度逻辑与底层宿主实现完全解耦，支持一套编排流水线驱动三大平台。Codex Provider 的实现级接口另提供 `read/read_async`，用于在 formal threadId 上读取异步 Host Adapter 结果。

### 2. 六大核心原语契约 (Six Standard Primitives)

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        SessionProvider 标准原语                        │
├────────────────────────────────────────────────────────────────────────┤
│ 1. get_current_session_id() -> string                                  │
│ 2. scan_project_sessions(project_root) -> SessionMetadata[]             │
│ 3. spawn(role, prompt, workspace, model) -> string (session_id)        │
│ 4. send(conversation_id, message_payload) -> void                      │
│ 5. manage(action: 'list'|'kill'|'status', conversation_ids) -> Result  │
│ 6. await_reply() -> ReactiveWakeup / Callback                          │
└────────────────────────────────────────────────────────────────────────┘
```

### 3. Codex formal ID 与生命周期结果

```json
{
  "formal_id": {
    "accepted_fields": ["threadId", "thread_id"],
    "accepted_locations": ["structuredContent", "nested response/thread", "content text JSON"],
    "client_fields": ["clientThreadId", "client_thread_id"],
    "client_rule": "clientThreadId、queued 或无 formal ID -> PENDING_CREATION；不能 send、read、wait 或 bind"
  },
  "codex_provider_methods": ["create", "create_async", "send/submit", "read", "read_async", "wait"],
  "status_rule": "创建只有 formal threadId 才 READY；发送只有 adapter 或明确 CLI 且 submitted=true 才 SUBMITTED；否则保留 PREPARED_ONLY/UNSUPPORTED"
}
```

Codex `create_thread` 属于 Desktop 宿主工具，不由本仓库脚本层伪造。`/init` 或 `/new-session` 发现缺失/不可续接专题时，主会话先调用 `list_projects`，按 `isGitRepository` 选择 `worktree` 或 `local`，再调用 `create_thread`；取得正式 ID 后运行 `new_topic_session --bind-current <threadId> --id-kind threadId`，写回 `sessions.json`、`topics.json` 与厂商镜像。`send_message_to_thread` 提交成功不等于模型回复，需另行 `wait_threads/read_thread`。

---

## 二、三大厂商 SessionProvider 深度映射矩阵 (Three Vendors Mapping)

```json
[
  {
    "primitive": "get_current_session_id",
    "antigravity": "宿主在每轮上下文 <user_information> 中自动注入 Conversation ID",
    "codex": "严格读取环境变量 CODEX_THREAD_ID 或 CODEX_SESSION_ID",
    "claude_code": "由 Hooks stdin JSON 的 .session_id 字段提取并注入"
  },
  {
    "primitive": "scan_project_sessions",
    "antigravity": "扫描 $AppDataDir/brain/*/transcript.jsonl 提取当前工作区关联会话",
    "codex": "读取 $CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl 校验 cwd 路径",
    "claude_code": "解析 ~/.claude/projects/<munged-cwd>/<session-id>.jsonl"
  },
  {
    "primitive": "spawn",
    "antigravity": "持久专题: agentapi new-conversation; 临时隔离代理: invoke_subagent",
    "codex": "Desktop: create_thread; CLI: 命令行启动新线程",
    "claude_code": "子进程调用 claude -p \"<prompt>\" 或无头拉起"
  },
  {
    "primitive": "send",
    "antigravity": "上下文发信: send_message 原生工具; 跨进程发信: agentapi send-message",
    "codex": "Desktop: send_message_to_thread; CLI: codex queue --thread <id> --message <text>",
    "claude_code": "无头派发: claude -p \"<task>\" --session-id <uuid> --output-format json; 续接: claude --resume <id>"
  },
  {
    "primitive": "manage",
    "antigravity": "原生工具 manage_subagents (list / kill / status)",
    "codex": "Desktop: list_threads / wait_threads; CLI 查询",
    "claude_code": "CLI 命令: claude agents --json [--all] [--cwd <path>]"
  },
  {
    "primitive": "await_reply",
    "antigravity": "系统原生 Reactive Wakeup (结束本轮工具调用即可自动挂起等待唤醒)",
    "codex": "Desktop wait_threads 或 CLI 进程退出码等待",
    "claude_code": "无头 CLI 进程阻塞等待退出或流式 stream-json 监听"
  }
]
```

---

## 三、Schema v4 厂商顶层分区状态机持久化架构 (Persistence Architecture)

### 1. 顶层厂商独立分区原理
为了杜绝多 Agent 协同工作时的状态相互踩踏与并发锁死，`.agents/task-loop/sessions.json` 与 `topics.json` 采用 **Schema v4 顶层厂商独立分区架构**：

```json
{
  "schema_version": 4,
  "vendors": {
    "antigravity": {
      "main_thread_id": "ee94b2c5-c0c2-473f-8f71-213250ba5295",
      "modules": {
        "session_control": {
          "session_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
          "title": "[Session] SDK & Scripting",
          "resumable": true
        }
      }
    },
    "codex": {
      "main_thread_id": "thr_main_codex_001",
      "model_policy": {
        "main": { "model": "gpt-6-astra", "effort": "medium" },
        "topic": { "model": "gpt-5.6-terra", "effort": "xhigh" },
        "subagent": { "model": "gpt-5.6-luna", "effort": "max" }
      },
      "modules": {}
    },
    "claude": {
      "main_thread_id": "claude_root_sess_001",
      "modules": {}
    }
  }
}
```

### 2. 核心持久化特性
1. **物理隔离镜像**：同时自动同步写出 `sessions.<vendor>.json` 镜像物理文件，供单厂商轻量工具直读；
2. **粘性绑定保护 (Sticky Binding Lock)**：当执行初始化与重连扫描时，当前厂商分区内已存在的有效会话绑定（`resumable === true` 且存在 formal 物理 ID）优先予以锁定保留，严禁覆盖重建；
3. **精准只读查询 (Query CLI)**：查询状态必须调用 `node scripts/query_task_loop_state.js --vendor <v> --key <dot.path>`，杜绝全量加载大 JSON。

---

## 四、双轨实现参考 (Dual-Runtime Implementation)

### 1. Node.js 18+ 原生轻量实现骨架 (`session_provider.js`)

```javascript
// session_provider.js - 零依赖 Node.js 18+ 标准实现
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class SessionProvider {
  constructor(vendor = 'antigravity', wsRoot = process.cwd()) {
    this.vendor = vendor;
    this.wsRoot = wsRoot;
  }

  getCurrentSessionId() {
    if (this.vendor === 'codex') {
      return process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null;
    }
    // AGY 会话由 Hook / 上下文传递
    return process.env.ANTIGRAVITY_CONVERSATION_ID || null;
  }

  async send(conversationId, message) {
    if (this.vendor === 'antigravity') {
      if (typeof globalThis.send_message === 'function') {
        return await globalThis.send_message({
          Recipient: conversationId,
          Message: message,
          toolAction: 'Sending message to session',
          toolSummary: 'Cross-session dispatch'
        });
      }
      // CLI 降级通道
      execSync(`agentapi.bat send-message ${conversationId} "${message.replace(/"/g, '\\"')}"`, {
        cwd: this.wsRoot,
        stdio: 'inherit'
      });
      return;
    }

    if (this.vendor === 'claude') {
      execSync(`claude -p "${message.replace(/"/g, '\\"')}" --session-id ${conversationId} --output-format json`, {
        cwd: this.wsRoot,
        stdio: 'inherit'
      });
      return;
    }
  }
}

module.exports = { SessionProvider };
```

### 2. Python 3.8+ 原生轻量实现骨架 (`session_provider.py`)

```python
# session_provider.py - 零 pip 依赖 Python 3.8+ 标准实现
import os
import subprocess
from typing import Optional, Dict, Any

class SessionProvider:
    def __init__(self, vendor: str = "antigravity", ws_root: str = "."):
        self.vendor = vendor
        self.ws_root = ws_root

    def get_current_session_id(self) -> Optional[str]:
        if self.vendor == "codex":
            return os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID")
        return os.environ.get("ANTIGRAVITY_CONVERSATION_ID")

    def send(self, conversation_id: str, message: str) -> None:
        if self.vendor == "claude":
            subprocess.run(
                ["claude", "-p", message, "--session-id", conversation_id, "--output-format", "json"],
                cwd=self.ws_root,
                check=True
            )
```

## 五、QuestionProvider 与第四个跨切面边界

QuestionProvider 是现有契约支柱，负责需要用户选择或确认的交互；SessionProvider 不新增 Question runtime，也不把普通文本提示冒充原生选择器。

```json
{
  "boundary": "Execution/Capability/Authority Context",
  "meaning": "跨厂商运行时边界，不新增独立 runtime",
  "fields": [
    "host capability",
    "workspace environment",
    "role model/reasoning",
    "write permission/lifecycle"
  ],
  "codex_model_precedence": ["用户显式选择", "既有 session.model_config", "role 默认"],
  "codex_role_defaults": {
    "main": { "model": "gpt-6-astra", "reasoning_effort": "medium" },
    "topic": { "model": "gpt-5.6-terra", "reasoning_effort": "xhigh" },
    "subagent": { "model": "gpt-5.6-luna", "reasoning_effort": "max" }
  }
}
```

---

## 六、看门狗巡检与开发陷阱 (Gotchas)

1. **[Gotcha 1] 杜绝 Polling 轮询的 Token 消耗**：
   在 AGY 中派遣任务后，严禁编写死循环轮询 `manage_subagents(status)`；必须结束当前 Turn 利用 Reactive Wakeup 机制挂起，等待系统自动唤醒。
2. **[Gotcha 2] 双阶梯看门狗真活跃核验 (30s Probe -> 120s Audit)**：
   主会话派单后，执行 30s 响应探针（`inspect_agy_sessions.js --probe-dispatch`），严格核验是否存在实际 `MODEL` 工作步；若未激活，严禁挂载 120s 巡检进入盲等，必须输出告警卡并补发唤醒；仅当确凿激活后方可挂载 120s 巡检。
3. **[Gotcha 3] 跨会话发信 UI 折叠卡**：
   `send_message` 在前端以 `Message from Root Agent v` 折叠卡呈现，不会伪造用户气泡；目标专题完成任务后必须通过 `send_message` 反向交付，触发主中枢验收。
4. **[Gotcha 4] 环境变量净化 (Environment Sanitization)**：
   在调用 CLI 拉起独立顶层会话时，必须净化子进程的 `ANTIGRAVITY_CONVERSATION_ID` 等环境变量，防止新会话被识别为嵌套子代理。
