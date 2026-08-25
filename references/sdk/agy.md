# Google Antigravity (AGY) 会话与程序化 SDK 规范

Google Antigravity (AGY) 是 `task-loop` 的主力执行环境，提供了**宿主内部原生 Subagent 工具链**与**官方外部 Python 程序化 SDK (`google-antigravity`)** 双层治理能力。

---

## 一、宿主内部原生工具原语 (In-Session Native Tools)

在 Antigravity 宿主会话环境中，主会话与专题子代理之间通过原生工具原语进行协同与生命周期管理：

```json
[
  {
    "category": "获取当前会话 ID (方式 A: 上下文注入)",
    "tool_or_sdk": "Runtime Metadata",
    "signature": "<user_information> -> Conversation ID",
    "description": "当前会话自身直接感知：系统在每次启动或响应时自动将当前会话 UUID 注入模型上下文与 Artifact 存储路径中。"
  },
  {
    "category": "获取活动子会话 ID (方式 B: 工具查询)",
    "tool_or_sdk": "manage_subagents",
    "signature": "Action: 'list'",
    "description": "查询活动子会话：实时获取当前主会话所拉起的所有活跃子会话列表及其 conversationId、运行状态与物理日志路径。"
  },
  {
    "category": "获取工程关联会话 (方式 C: 脚本扫描)",
    "tool_or_sdk": "Provider Scanner",
    "signature": "node scripts/providers/get_agy_project_sessions.js <root> --inspect",
    "description": "物理反向内省：遍历 ~/.gemini/antigravity/brain/ 物理目录，基于 transcript.jsonl 中的工作区路径与时间戳反查属于当前项目的活跃会话 ID。"
  },
  {
    "category": "拉起新会话 / 子代理",
    "tool_or_sdk": "invoke_subagent",
    "signature": "Subagents: [{ TypeName: 'self'|'research'|string, Role: string, Prompt: string, Workspace: 'inherit'|'branch'|'share', Model: 'inherit'|'flash'|'pro' }]",
    "description": "创建并启动子会话。TypeName: 'self' 继承父代理全量工具与上下文能力；Workspace: 'inherit' 共享当前项目目录；系统返回 Payload 中包含新建子代理的 conversationId。"
  },
  {
    "category": "动态定义代理模板",
    "tool_or_sdk": "define_subagent",
    "signature": "name: string, description: string, system_prompt: string, enable_write_tools: bool, enable_subagent_tools: bool",
    "description": "声明新的专用代理类型（如 reviewer, worker），供 invoke_subagent 反复拉起。"
  },
  {
    "category": "跨会话发送消息 (既有专题续接)",
    "tool_or_sdk": "send_message",
    "signature": "Recipient: string (conversation_id), Message: string",
    "description": "向已存在的长期专题会话直接投递指令/任务包。自动继承目标会话既有的历史上下文、已加载工具与先验记忆；属于后台 Agent 通信管道，不影响前端 UI 人类气泡。"
  },
  {
    "category": "会话生命周期管理",
    "tool_or_sdk": "manage_subagents",
    "signature": "Action: 'list'|'kill'|'kill_all', ConversationIds?: string[]",
    "description": "状态监控与强制介入：list 查询活动子会话实时状态 (running, idle, waiting_for_input, errored)；kill 终止走弯路或超时的子会话及其派生树。"
  },
  {
    "category": "挂机等待与唤醒",
    "tool_or_sdk": "Reactive Wakeup",
    "signature": "系统原生事件驱动（零工具调用）",
    "description": "零 Token 纯响应式挂机：发出任务后主会话直接结束当前轮工具调用，子会话完成或发信时系统自动唤醒主会话，严禁写循环 polling。"
  },
  {
    "category": "系统级会话新建与通信 (CLI 工具)",
    "tool_or_sdk": "agentapi CLI",
    "signature": "agentapi new-conversation [--title=...] [--model=...] <prompt> / agentapi send-message <id> <content> / agentapi get-conversation-metadata <id>",
    "description": "系统/Sidecar 级外挂命令行工具：位于 ~/.gemini/antigravity/bin/agentapi.bat，支持在 IDE 顶层创建全新独立根会话 (rootConversationId)、查询完整元数据以及跨会话投递消息。"
  }
]
```

---

## 二、官方 Python 程序化 SDK (`google-antigravity`)

针对外部自动化脚本、CI/CD 流水线或独立 Python 编排服务，官方提供了开源 Python SDK（GitHub: [`google-antigravity/antigravity-sdk-python`](https://github.com/google-antigravity/antigravity-sdk-python)，PyPI: `google-antigravity`）：

### 1. 三层架构心智模型 (Three-Layer Architecture)
```text
┌──────────────────────────────────────────────┐
│  Layer 1 — Agent (Lifecycle & Config)        │
│  拥有: config, hooks, triggers, policies,    │
│        MCP bridges, tool runner, chat()      │
│  ┌──────────────────────────────────────────┐│
│  │  Layer 2 — Conversation (Session State)  ││
│  │  拥有: history, turn tracking,           ││
│  │        compaction indices, usage,        ││
│  │        send(), receive_steps(), cancel() ││
│  │  ┌──────────────────────────────────────┐││
│  │  │  Layer 3 — Connection (Transport)    │││
│  │  │  拥有: wire protocol, binary harness,│││
│  │  │        idle/wakeup, disconnect       │││
│  │  └──────────────────────────────────────┘││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

### 2. 会话状态中枢 (`Conversation` API) 深度规范
```json
[
  {
    "property_or_method": "conversation.conversation_id",
    "type": "str",
    "description": "底层 Runtime 分配的会话全局 UUID。在首轮交互发生后生效，可回传用于跨进程持久化续接。"
  },
  {
    "property_or_method": "conversation.history",
    "type": "list[Step]",
    "description": "完整、未压缩的步骤轨迹历史（包含 TEXT_RESPONSE, TOOL_CALL, COMPACTION, FINISH 等强类型 Step）。"
  },
  {
    "property_or_method": "conversation.compaction_indices",
    "type": "list[int]",
    "description": "记录会话历史上发生上下文压缩的 Step 索引点。压缩点之前的 Step 已从活跃上下文剔除但仍保留在 history 中供审计。"
  },
  {
    "property_or_method": "conversation.total_usage",
    "type": "UsageMetadata",
    "description": "会话全生命周期的累计 Token 消耗（包含 prompt, cached_content, candidates, thoughts 细分数据）。"
  },
  {
    "property_or_method": "conversation.last_turn_usage",
    "type": "UsageMetadata | None",
    "description": "最近一轮交互消耗的增量 Token（通过轮次开始与结束快照精确做差计算）。"
  },
  {
    "property_or_method": "conversation.trajectory_usages",
    "type": "dict[str, UsageMetadata]",
    "description": "支持按 Trajectory ID 独立统计 Token 消耗。主 Agent 对应 conversation_id（或 'main'），每个 Subagent 拥有独立 trajectory_id 并单独核算消耗。"
  },
  {
    "property_or_method": "conversation.wait_for_wakeup(timeout=300.0)",
    "type": "async (float) -> bool",
    "description": "非阻塞等待底层会话事件唤醒，超时返回 False，唤醒成功返回 True。"
  },
  {
    "property_or_method": "conversation.cancel()",
    "type": "async () -> None",
    "description": "动态取消正在执行中的模型生成或工具调用轮次。"
  },
  {
    "property_or_method": "conversation.wait_for_idle()",
    "type": "async () -> None",
    "description": "阻塞直到当前轮次执行完毕并转入就绪空闲状态。"
  },
  {
    "property_or_method": "conversation.get_last_structured_output()",
    "type": "() -> Any | None",
    "description": "从最近的 FINISH 步骤中提取模型返回的结构化 JSON 输出。"
  }
]
```

### 3. 会话续接模式 (`SessionContinuationMode`) 与 ID 校验
* **三种续接模式**：
  - `types.SessionContinuationMode.RESUME ("resume")`：严格续接既有会话；**必须显式提供 `conversation_id`**，不存在则立即抛出异常。
  - `types.SessionContinuationMode.CREATE_OR_RESUME ("create_or_resume")`：默认高容错模式；若指定会话存在则续接，不存在则自动新建。
  - `types.SessionContinuationMode.CREATE_ONLY ("create_only")`：强制新建独立会话；若已存在同名会话则报错，杜绝状态意外覆盖。
* **会话 ID 格式硬性约束**：`conversation_id` 必须满足**长度 ≥ 32 字符**且仅包含正则 `^[a-zA-Z0-9-]+$`（如标准 UUIDv4），否则在配置校验阶段即被拒绝。

### 4. 会话上下文分层 Hook 体系 (`HookContext` & 8大生命周期)
* **三级上下文状态继承**：
  - `SessionContext`（会话级）：整个会话生命周期共享状态。
  - `TurnContext`（轮次级）：继承 `SessionContext`，单轮用户发信生命周期内共享。
  - `OperationContext`（操作/工具级）：继承 `TurnContext`，单次工具调用或模型调用内共享。
* **三大 Hook 类别**：
  - `InspectHook`（只读非阻塞）：用于日志、遥测与链路追踪（如 `@hooks.post_tool_call`）。
  - `DecideHook`（只读阻塞决策）：返回 `HookResult(allow=True/False, reason=...)` 决定是否放行或阻断操作（如 `@hooks.pre_tool_call_decide`）。
  - `TransformHook`（修改性阻塞）：用于对用户输入或工具输出进行动态脱敏与转换。
* **八大生命周期节点**：`on_session_start`、`on_session_end`、`pre_turn`、`post_turn`、`pre_tool`、`post_tool`、`on_tool_error`、`on_compaction`。

### 5. 工具感知会话状态 (`ToolContext`) 与 Skill 目录直接挂接
* **`ToolContext` 依赖注入**：
  自定义 Python 工具可声明 `ctx: ToolContext` 参数。SDK 在生成给大模型的 Tool Schema 中会**自动隐藏该参数**，并在执行时动态注入当前会话的 `ctx.conversation_id` 与跨工具线程安全状态存储（`ctx.get_state()` / `ctx.set_state()`）。
* **Skill 目录原生加载 (`skills_paths`)**：
  `LocalAgentConfig` 支持 `skills_paths=["./skills/task-loop"]` 直接批量挂接外部 SKILL.md 技能目录，与 Antigravity IDE 行为无缝统一。

### 6. 会话预算控制与中止原因 (`BudgetConfig` & `StopReason`)
```json
[
  {
    "config_field": "BudgetConfig",
    "parameters": {
      "max_model_calls": "限制单会话内模型推理轮次上限",
      "max_tool_calls": "限制单会话内工具调用次数上限",
      "max_input_tokens": "限制累计未命中缓存的输入 Token 上限",
      "max_output_tokens": "限制累计输出 Token (candidates + thoughts) 上限",
      "max_total_tokens": "限制全会话综合净 Token 消耗上限"
    }
  },
  {
    "enum": "StopReason",
    "values": [
      "UNSPECIFIED (正常收敛或未指定)",
      "MAX_MODEL_CALLS_EXCEEDED (超模型推理上限熔断)",
      "MAX_TOOL_CALLS_EXCEEDED (超工具调用上限熔断)",
      "MAX_INPUT_TOKENS_EXCEEDED (超输入 Token 上限熔断)",
      "MAX_OUTPUT_TOKENS_EXCEEDED (超输出 Token 上限熔断)",
      "MAX_TOTAL_TOKENS_EXCEEDED (超总 Token 上限熔断)",
      "QUOTA_EXHAUSTED (后端 API 配额耗尽熔断)"
    ]
  }
]
```

---

## 三、代码示例：基于 SDK 的有状态会话与 Token 审计

```python
import asyncio
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig, types
from google.antigravity.tools.tool_context import ToolContext

# 1. 声明带会话上下文感知的自定义工具
def record_progress(task_id: str, note: str, ctx: ToolContext) -> str:
    """记录任务进度到会话状态中。"""
    ctx.set_state(f"task_{task_id}", note)
    return f"已在会话 [{ctx.conversation_id[:8]}] 中记录任务 {task_id}: {note}"

async def run_stateful_session():
    # 配置会话存储目录、预算与 Skill 路径
    config = LocalAgentConfig(
        save_dir="./agent_storage",
        skills_paths=["./skills"],
        tools=[record_progress],
        budget=types.BudgetConfig(max_tool_calls=50, max_total_tokens=100_000),
        capabilities=CapabilitiesConfig(
            enable_subagents=True,
            compaction_threshold=32_000
        )
    )

    async with Agent(config) as agent:
        conv = agent.conversation
        
        # 2. 执行第一轮交互
        response = await agent.chat("请梳理本项目核心模块并派发子代理核查")
        print("回答:", await response.text())
        print(f"首轮消耗: {conv.last_turn_usage.total_token_count} tokens")
        print(f"会话 ID: {agent.conversation_id}")
        
        # 3. 独立 Subagent 消耗审计
        for traj_id, usage in conv.trajectory_usages.items():
            print(f"轨迹 [{traj_id}] 消耗: {usage.total_token_count} tokens")

        # 4. 检查上下文压缩点
        if conv.compaction_indices:
            print(f"上下文发生过压缩，压缩点步骤索引: {conv.compaction_indices}")

if __name__ == "__main__":
    asyncio.run(run_stateful_session())
```

---

## 四、双层架构选型与边界建议

```json
[
  {
    "layer": "层级 1: 宿主交互与跨 Agent 协作 (In-Session Orchestration)",
    "technology": "Antigravity 原生 Subagent 工具链 (invoke_subagent / send_message / Reactive Wakeup)",
    "scenario": "AI 开发者在 IDE / CLI 会话内部工作，根据 1/2/3 复杂度动态分派 Worker / Reviewer 子代理处理专题任务。",
    "characteristics": "零外部安装依赖、系统级物理沙箱隔离、自动 Reactive Wakeup 挂机。"
  },
  {
    "layer": "层级 2: 外部独立自动化与流水线 (External Programmatic Loop)",
    "technology": "Python SDK (google-antigravity / antigravity-sdk-python)",
    "scenario": "外部 Python 自动化服务、CI 门禁脚本、或第三方调度系统需要直接以代码形式拉起并流式监控 Antigravity Agent。",
    "characteristics": "完整的 Python 类型系统支持、细粒度 Thoughts 与 ToolCalls 事件流拦截、进程内自定义工具注册与 ToolContext 共享。"
  }
]
```

---

## 五、基于 `agentapi` 的顶层专题会话自动化创建与通信全流程

针对 **Sidecar 后台守护进程**、**外部 CI/Git Webhook 触发器** 或 **Main 会话需要主动开启独立顶层窗口** 的场景，Antigravity 提供了系统级命令行工具 `agentapi`。以下为自动化创建与管理专题会话的完整步骤指南：

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                   agentapi 专题会话自动化创建与流转管道                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 步骤 1: 定位 agentapi 二进制执行文件                                         │
│         │                                                                   │
│         ▼                                                                   │
│ 步骤 2: agentapi new-conversation --title="..." "<prompt>"                  │
│         └─► 获取生成的独立根会话 conversationId                             │
│         │                                                                   │
│         ▼                                                                   │
│ 步骤 3: agentapi get-conversation-metadata <id>                             │
│         └─► 核验工作区路径并持久化回写至 .agents/task-loop/sessions.json    │
│         │                                                                   │
│         ▼                                                                   │
│ 步骤 4: agentapi send-message <id> "<content>" / In-Session send_message    │
│         └─► 目标会话执行任务并通过 Reactive Wakeup 自动回传结果              │
│         │                                                                   │
│         ▼                                                                   │
│ 步骤 5: 生命周期收尾（IDE UI 手动删除或磁盘物理归档）                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1. 步骤 1：定位 `agentapi` 二进制执行环境
* **物理位置**：
  * Windows：`~/.gemini/antigravity/bin/agentapi.bat`（内部调用 `language_server.exe agentapi`）
  * Linux/macOS：`~/.gemini/antigravity/bin/agentapi`
* **执行语义**：`agentapi` 处于系统全局 `PATH` 中，无需第三方依赖，可被 Node.js / Python 脚本或 Sidecar 守护进程直接调用。

### 2. 步骤 2：执行 `new-conversation` 创建全新独立根会话
* **执行命令格式**：
  ```bash
  agentapi new-conversation --title="[专题名称] 核心功能A & 核心功能B" --model=flash "首轮初始化派单提示词"
  ```
* **参数与语义**：
  * **`--title`**（可选）：为新创建的根会话命名，该标题将直接展示在 Antigravity IDE 顶层侧边栏的会话历史中。
  * **`--model`**（可选）：指定初始模型层级，支持 `<flash_lite / flash / pro>`；不指定时使用默认模型。
  * **`--profile`**（可选）：指定运行 Profile 环境。
  * **`<prompt>`**（必需）：传递给新会话的第一条任务初始化 Prompt。
* **返回 JSON 结构**：
  ```json
  {
    "response": {
      "newConversation": {
        "conversationId": "79262e90-3bd8-4ae5-a760-2896cfa3ea0f",
        "prompt": "首轮初始化派单提示词"
      }
    }
  }
  ```

### 3. 步骤 3：提取元数据并持久化注册 (`get-conversation-metadata`)
* **执行命令**：
  ```bash
  agentapi get-conversation-metadata <conversation_id>
  ```
* **语义说明**：提取该根会话的绑定工作区（`workspaces[0].workspaceFolderAbsoluteUri`）、Git 分支以及创建时间戳（`createdAt`）。
* **持久化回写**：调用 `initialize_task_loop_state` 或直接将该 `conversationId` 连同其专题标签（`module_key`、`tags`、`summary`）登记到 [`.agents/task-loop/sessions.json`](.agents/task-loop/sessions.json)。

### 4. 步骤 4：跨会话发信与 Reactive Wakeup 闭环 (`send-message`)
* **外部脚本/Sidecar 发信**：
  ```bash
  agentapi send-message <conversation_id> "这是追加下发的专题任务详情..."
  ```
* **主会话内部发信**：
  ```json
  {
    "tool": "send_message",
    "Recipient": "79262e90-3bd8-4ae5-a760-2896cfa3ea0f",
    "Message": "这是追加下发的专题任务详情..."
  }
  ```
* **语义说明**：目标会话接收到消息后在后台自动执行，任务完成后将回执发送给调用方，系统通过 **Reactive Wakeup** 零轮询唤醒主控端。

### 5. 步骤 5：生命周期与删除边界规范
* **命令行删除不支持**：`agentapi` 当前未暴露 `delete-conversation` 子命令（为防止程序误删重要聊天记录）。
* **UI 视图清理**：用户在 Antigravity IDE 的会话历史列表中点击垃圾桶图标完成 View Model 删除。
* **磁盘数据清理**：物理日志落盘于 `~/.gemini/antigravity/brain/<conversation_id>/`，可按需归档或清理。

