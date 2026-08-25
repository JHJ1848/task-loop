# [Official Docs] Google Antigravity SDK 会话与子代理操作核心规范

本文档归档自 Google Antigravity 官方在线文档，精炼收录当前项目 `task-loop` 核心所需的**会话生命周期管理**、**会话持久化与恢复**、**Token 成本审计**以及**多智能体子代理（Subagents）委派操作**。

> **权威数据源**：
> * 官方文档站点：[`https://antigravity.google/docs/sdk/overview`](https://antigravity.google/docs/sdk/overview)
> * 官方代码仓库：[`https://github.com/google-antigravity/antigravity-sdk-python.git`](https://github.com/google-antigravity/antigravity-sdk-python.git)

---

## 一、会话生命周期与基础操作 (Session Operations)

### 1. 基础会话启动与上下文管理
通过 `Agent` 异步上下文管理器管理底层会话连接、工具执行与状态生命周期：

```python
import asyncio
from google.antigravity import Agent, LocalAgentConfig

async def main():
    config = LocalAgentConfig()
    async with Agent(config) as agent:
        response = await agent.chat("Analyze repository status and list files.")
        print(await response.text())

if __name__ == "__main__":
    asyncio.run(main())
```

### 2. 会话状态持久化与跨进程恢复 (Session Persistence)
* **`conversation_id` 规范**：必须满足长度 ≥ 32 字符且仅含字母、数字和连字符（如标准 UUIDv4）。
* **配置参数**：
  * `save_dir`：持久化会话状态数据的本地存储目录；
  * `conversation_id`：指定会话唯一标识，用于跨进程持久化续接或定位；
  * `app_data_dir`：可选自定义 Antigravity 日志与 Brain 轨迹落盘目录。

```python
from google.antigravity import Agent, LocalAgentConfig, types

# 显式指定会话 ID 进行跨进程持久化或恢复
config = LocalAgentConfig(
    save_dir="./sessions",
    conversation_id="cdd1ca5c-3532-4489-b844-15c6f34055fa",
    session_continuation_mode=types.SessionContinuationMode.CREATE_OR_RESUME,
)

async def run():
    async with Agent(config) as agent:
        response = await agent.chat("Resume previous task workflow.")
        print(await response.text())
```

### 3. 会话轮次拦截与错误保护 (Lifecycle Hooks)
通过 Hook 装饰器在会话生命周期关键节点介入，记录用户 Prompt、捕获工具异常并避免 Agent 崩溃：

```python
from google.antigravity import Agent, LocalAgentConfig, hooks, types

@hooks.pre_turn
async def log_turn(prompt: str) -> types.HookResult:
    """轮次开始前拦截，可进行审计或决策放行。"""
    print(f"[Audit] User prompt: {prompt}")
    return types.HookResult(allow=True)

@hooks.on_tool_error
async def handle_error(err: Exception) -> None:
    """捕获工具执行失败异常，进行优雅降级。"""
    print(f"[Warn] Tool execution error intercepted: {err}")

config = LocalAgentConfig(hooks=[log_turn, handle_error])
```

### 4. 会话 Token 成本与用量审计 (Cost Auditing)
会话响应对象与 Layer 2 `Conversation` 实时暴露细分 Token 用量：

```python
async with Agent(config) as agent:
    response = await agent.chat("Audit codebase complexity.")
    print(await response.text())

    # 单轮次增量 Token 审计
    if response.usage_metadata:
        print(f"Prompt tokens: {response.usage_metadata.prompt_token_count}")
        print(f"Candidates tokens: {response.usage_metadata.candidates_token_count}")
        print(f"Total tokens: {response.usage_metadata.total_token_count}")
```

---

## 二、多智能体子代理操作 (Subagent Operations)

针对高复杂度任务，主代理可将任务拆解并委派给拥有独立上下文窗口的子代理并行执行。

### 1. 动态自我克隆子代理 (Dynamic Self-Cloning Subagents)
配置 `enable_subagents=True` 允许主代理在运行时根据需求动态派生具有相同权限和工具集的子代理：

```python
from google.antigravity import Agent, LocalAgentConfig, types

config = LocalAgentConfig(
    capabilities=types.CapabilitiesConfig(enable_subagents=True)
)

async with Agent(config) as agent:
    # 主代理在规划后可在内部自主派生子代理处理子任务
    response = await agent.chat("Decompose the module refactoring and delegate to subagents.")
    print(await response.text())
```

### 2. 静态专用子代理声明 (Static Custom Subagents)
显式声明具备独立系统指令、隔离工具集的专用子代理（如 Reviewer、Worker）：

```python
from google.antigravity import Agent, LocalAgentConfig, types

def code_lint_tool(file_path: str) -> str:
    """专用代码审查工具。"""
    return f"Validated {file_path}: OK"

# 1. 声明静态子代理规格
reviewer = types.SubagentConfig(
    name="code_reviewer",
    description="Audits source code for style and architecture compliance.",
    system_instructions="You are a strict code review specialist. Check code against project rules.",
    tools=[code_lint_tool],
)

# 2. 注入主代理配置（子代理工具必须同时注册在 parent tools 列表中）
config = LocalAgentConfig(
    tools=[code_lint_tool],
    subagents=[reviewer],
    capabilities=types.CapabilitiesConfig(enable_subagents=True)
)

async with Agent(config) as agent:
    response = await agent.chat("Review changes in src/ and summarize findings.")
    print(await response.text())
```

---

## 三、双向索引与参考关联 (Bidirectional References)

* **跨厂商会话 SDK 体系总纲**: [`references/sdk/README.md`](./README.md)
* **AGY 原生 SDK 规范**: [`references/sdk/agy.md`](./agy.md)
* **受控记忆主纲要**: [`docs/MEMORY.md`](../../docs/MEMORY.md)
* **项目治理总规范**: [`AGENTS.md`](../../AGENTS.md)
