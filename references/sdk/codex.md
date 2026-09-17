# OpenAI Codex 外层会话与集成 SDK 规范

本文档定义 `task-loop` 外层调度器如何识别、路由、续接和观察 Codex 任务。

## 0. 稳定适配边界

Hook 兼容性同样按厂商隔离：Codex 不提供 AGY/ZCode 的 `PreInvocation`、`PreToolUse` 生命周期，插件不得宣称自动注入或物理拦截已生效。Codex 仅支持通过 Skill 指令、调度前置校验和 fail-closed 结果实现等价约束；AGY/ZCode Hook 配置与行为保持原样。

```json
[
  {
    "supported": "已知 thread 的 CLI 队列派单",
    "command": "codex queue --thread <id> --message <text>",
    "success_condition": "仅 CLI exit code 0 返回 SUBMITTED"
  },
  {
    "degraded": "显式 --resume 的批处理续接",
    "command": "codex exec resume <id> - (prompt via stdin)",
    "success_condition": "仅显式选择且 CLI exit code 0 返回 SUBMITTED"
  },
  {
    "unsupported": "自动 PreInvocation / PreToolUse Hook、直接写 .codex/sessions、按 UUID 猜测 AGY"
  },
  {
    "experimental_only": "codex app-server JSON-RPC；Desktop App Tools 只有在宿主实际暴露时才可按本规范调用"
  }
]
```

`scripts/providers/codex_session_dispatch.js/.py` 在未执行、CLI 缺失或非零退出时只返回 `PREPARED_ONLY`，不会伪造成功或写入 `.codex/sessions`。`exec resume` 使用参数 `-` 并通过 stdin 传递 prompt，避免 prompt 被 CLI 解析为选项。

### 0.1 Provider 解耦入口

`scripts/providers/codex_session_provider.js/.py` 提供运行时纯适配入口 `create/create_async`、`submit/submit_async`、`read/read_async` 与 `wait`。调用方可显式注入 `desktop`、`sdk`、`api` 函数；创建回执只有 formal `threadId` 才能进入 `READY`，`clientThreadId`/queued 或无回执进入 `PENDING_CREATION`。发送只有存在真实适配器或明确 CLI 能力时才报告可用；适配器只有返回 `{submitted:true}` 才会映射为 `SUBMITTED`，否则返回 `PREPARED_ONLY`。Provider 不读取或写入 `.agents/task-loop`、`.codex/sessions`，也不猜测会话 ID。

---

## 1. 术语和边界 (JSON 规范)

```json
[
  {
    "name": "thread_id / session_id",
    "meaning": "Codex 顶层任务会话标识。在当前 Desktop 宿主中二者通常相同。",
    "routable_as_long_term_target": true
  },
  {
    "name": "rollout_id",
    "meaning": "一次持久化执行记录的标识，位于会话 JSONL 的 session_meta.payload.id。",
    "routable_as_long_term_target": false
  },
  {
    "name": "子代理 transcript",
    "meaning": "thread_source: subagent 的执行记录，具有 parent_thread_id。",
    "routable_as_long_term_target": "不可以，除非显式开启临时代理观察"
  },
  {
    "name": "task-loop registration",
    "meaning": ".agents/task-loop/sessions.json 或兼容的 .codex/task-loop/sessions.json 中登记的主/专题任务。",
    "routable_as_long_term_target": "可以，但仍需由宿主确认可用"
  }
]
```

---

## 2. 集成层选择 (JSON 规范)

```json
[
  {
    "scenario": "当前正在运行的 Codex 宿主任务需要记录自身 ID",
    "preferred_interface": "Provider --current",
    "applicability": "读取宿主注入的 ID，不接触历史日志",
    "forbidden_behavior": "按最近修改时间猜测日志"
  },
  {
    "scenario": "Desktop 主任务创建、发送、等待既有任务",
    "preferred_interface": "Desktop 宿主工具",
    "applicability": "能获得当前任务树和等待状态",
    "forbidden_behavior": "直接写 .codex/sessions"
  },
  {
    "scenario": "外层服务通过代码创建或续接本机 Codex 线程",
    "preferred_interface": "官方 Codex SDK",
    "applicability": "TypeScript 或 Python 进程内调用，适合 CI/服务化 loop",
    "forbidden_behavior": "在 Python 3.8 项目中把 SDK 当作内置依赖"
  },
  {
    "scenario": "Codex 作为更大多 Agent 编排中的一个执行者",
    "preferred_interface": "codex mcp-server（已弃用；仅用于存量兼容评估）",
    "applicability": "官方文档已将 codex mcp-server 标记为 deprecated；新集成不应选择它，优先使用 CLI、已核实 SDK 或 App Server 协议",
    "forbidden_behavior": "用扫描结果作为 codex-reply.threadId"
  },
  {
    "scenario": "外部进程对已知会话追加一轮工作",
    "preferred_interface": "codex exec resume",
    "applicability": "适合批处理和 JSONL 事件消费",
    "forbidden_behavior": "假设能观察或中断一个已在运行的 Desktop turn"
  },
  {
    "scenario": "需要持续管理多个任务、接收通知或控制 turn",
    "preferred_interface": "codex app-server",
    "applicability": "JSON-RPC；实验字段需显式启用并按当前版本 schema 集成",
    "forbidden_behavior": "硬编码从旧版本推断的方法/参数"
  },
  {
    "scenario": "发现本项目历史任务或回收登记信息",
    "preferred_interface": "Provider 扫描",
    "applicability": "只读、可离线取证",
    "forbidden_behavior": "把扫描结果标记为在线或活动"
  }
]
```

---

## 3. 当前任务 ID 读取

```bash
# Node.js 推荐命令
node scripts/find_project_sessions.js --root . --vendor Codex --current

# Python 备案命令
python scripts/find_project_sessions.py --root . --vendor Codex --current
```

输出契约：
```json
{
  "vendor": "codex",
  "session_id": "01a032b0-1879-7571-b51f-cdb88cb24505",
  "thread_id": "01a032b0-1879-7571-b51f-cdb88cb24505",
  "is_available": true,
  "is_active": true,
  "activity_state": "current_process",
  "discovery_source": "runtime_env",
  "environment_key": "CODEX_THREAD_ID"
}
```

---

## 4. Desktop 宿主工具 (JSON 规范)

### 4.0 当前 Codex App Tools 能力登记

当运行在 Codex Desktop 且宿主暴露 `codex-app-tools` 时，以下 MCP 工具是会话控制的首选入口：

```json
[
  {"tool": "mcp__codex_app__list_projects", "purpose": "列出当前宿主可用的 local/remote/ChatGPT 项目及 projectId、Git 属性"},
  {"tool": "mcp__codex_app__list_threads", "purpose": "列出当前应用可见的线程/聊天摘要、状态、项目关联和线程 ID"},
  {"tool": "mcp__codex_app__read_thread", "purpose": "按 threadId 读取最近回合、消息、状态和可选工具输出；支持 cursor 分页"},
  {"tool": "mcp__codex_app__create_thread", "purpose": "按项目或 projectless 创建新任务；/init 或 new-session 发现缺失/不可续接专题时由主会话逐项调用"},
  {"tool": "mcp__codex_app__send_message_to_thread", "purpose": "向既有线程追加用户可见的 follow-up prompt"},
  {"tool": "mcp__codex_app__wait_threads", "purpose": "等待一个或多个线程完成或需要关注，使用事件等待而非 transcript 轮询"},
  {"tool": "mcp__codex_app__navigate_to_codex_page", "purpose": "在 Codex UI 中打开指定线程或聊天"},
  {"tool": "mcp__codex_app__open_in_codex", "purpose": "在 Codex 面板打开文件、终端、浏览器或 review"}
]
```

工具集合受宿主版本、权限和当前线程环境影响；未暴露的工具不得通过脚本伪造。`send_message_to_thread` 没有可自定义的 sender/role 字段，来源标识只能作为 prompt 正文中的约定前缀；它不能把消息伪装成系统消息。标准链路是先 `send_message_to_thread`，再按需 `wait_threads` -> `read_thread`；发送成功只表示请求已提交，不表示模型已回复。

### 4.1 创建、请求、接收三段契约

```json
[
  {
    "stage": "创建",
    "preferred": "主会话调用 mcp__codex_app__list_projects，再逐项调用 mcp__codex_app__create_thread",
    "required_result": "只接受 structuredContent.threadId/thread_id，或嵌套 response/thread 的同名 formal 字段",
    "pending_result": "clientThreadId、queued 或无 formal ID -> PENDING_CREATION；保存 creation_request，不写入物理绑定"
  },
  {
    "stage": "请求",
    "preferred": "send_message_to_thread（已登记且项目一致的 formal threadId）",
    "fallback": "codex queue --thread <id> --message <text>；批处理明确选择时才用 codex exec resume <id> -，prompt 从 stdin 输入",
    "success": "仅收到明确 submitted=true 或 CLI exit code 0 才算 SUBMITTED；提交不等于模型回复"
  },
  {
    "stage": "接收",
    "preferred": "wait_threads 获取状态变化，必要时 read_thread/read_async 读取最终文本",
    "fallback": "codex exec resume 的 stdout/JSONL 由调用方消费；无接收能力不得伪造完成",
    "forbidden": "把扫描历史、创建返回或派单成功当作模型回复"
  }
]
```

#### 4.1.1 `/init` 与 `/new-session` 的 Codex 主动创建步骤

主会话按一个 `module_key` 一个创建请求执行：

```json
[
  {
    "tool": "mcp__codex_app__list_projects",
    "args": {},
    "read": ["projectId", "isGitRepository"]
  },
  {
    "tool": "mcp__codex_app__create_thread",
    "args": {
      "prompt": "<memory-derived initialization or topic prompt>",
      "title": "<memory H1 or normalized topic title>",
      "target": {
        "type": "project",
        "projectId": "<projectId>",
        "environment": { "type": "worktree or local" }
      },
      "model": "<user explicit, then existing model_config, then role default>",
      "thinking": "<user explicit, then existing model_config, then role default>"
    },
    "environment_rule": "isGitRepository=true -> worktree; otherwise -> local"
  },
  {
    "tool_result": "CallToolResult",
    "formal_fields": ["threadId", "thread_id"],
    "formal_locations": ["structuredContent", "nested response/thread", "content text containing JSON"],
    "client_fields": ["clientThreadId", "client_thread_id"],
    "client_rule": "clientThreadId/queued 只能进入 PENDING_CREATION；不可 send、wait 或 bind"
  },
  {
    "bind": "node scripts/new_topic_session.js --workspace <root> --vendor codex --doc <doc> --bind-current <threadId> --id-kind threadId",
    "bind_python": "python scripts/new_topic_session.py --workspace <root> --vendor codex --doc <doc> --bind-current <threadId> --id-kind threadId",
    "persist": "写入 sessions.json、topics.json 及 sessions.codex.json/topics.codex.json 后重新运行 init"
  }
]
```

`create_thread` 的精确环境映射是 `target.environment.type = worktree`（项目 `isGitRepository=true`）或 `local`（否则）；已有 `resumable=true` 且 `id_kind=threadId` 的绑定优先复用，同一专题不重复创建。去重或迁移不得依据任务标题相同；标题只用于展示，不能替代 `module_key`、项目身份和已登记的线程 ID。专题续发必须解析 `vendors.codex.modules.<module_key>` 中已绑定的正式 `threadId`，不得使用 `clientThreadId`、`rollout_id` 或扫描结果代替，也不得把工作树交接当作线程迁移。`send_message_to_thread` 可在绑定后追加初始化 Prompt，但只表示请求提交；需要模型结果时使用 `wait_threads`/`read_thread`。本仓库脚本层没有原生 MCP 调用能力，因此不会在脚本内调用 `create_thread`；无 Host Adapter 时只能返回显式 `PENDING_CREATION`/`UNSUPPORTED`，由主会话完成原生调用、绑定和再次扫描。

Desktop 工具集合随宿主版本、权限和当前线程环境变化；未暴露的工具不得通过脚本伪造。脚本返回 `PENDING_CREATION` 时必须保留 `creation_request`，而不是把等待中的请求当作已创建。

### 4.3 Codex 专属创建期模型策略

该策略只属于 Codex Provider 和 `vendors.codex` 状态分区。AGY、ZCode、Claude 的模型选择与 Hook 行为不读取本节，也不会被本节默认值改写。

```json
{
  "scope": "codex-only",
  "creation_defaults": {
    "main": {"model": "gpt-6-astra", "reasoning_effort": "medium"},
    "topic": {"model": "gpt-5.6-terra", "reasoning_effort": "xhigh"},
    "subagent": {"model": "gpt-5.6-luna", "reasoning_effort": "max"}
  },
  "precedence": [
    "user explicit selection",
    "existing session model_config",
    "role creation default"
  ],
  "after_creation": "user-controlled"
}
```

实现入口为 `scripts/providers/codex_model_policy.js/.py`。`init` 和 `new_topic_session` 只在 Codex 创建/首次绑定时写入 `model_config`；已有用户配置保持不变。Provider 的后续 `submit` 不自动重新注入默认模型，因此用户在 Desktop `/model` 或 CLI 中的后续切换不会被 task-loop 覆盖。

CLI 创建期/续接期可使用 `--model <model>` 与 `--config model_reasoning_effort="<effort>"`。当前 `create_thread` 请求模板输出 `model` 与 `thinking`，其中 `thinking` 是宿主字段候选值；本项目已验证 CLI 参数，尚未把 Desktop 工具 schema 中的思考字段声明为稳定 API。若宿主拒绝该字段，应保留 `model` 并由用户在新任务中选择思考档位，不得修改全局 `~/.codex/config.toml`。

```text
[创建期]
create_thread({ prompt, title, target, model: "gpt-5.6-terra", thinking: "xhigh" })

[CLI 等价模板]
codex queue --thread <id> --message "<text>" --model gpt-5.6-terra --config 'model_reasoning_effort="xhigh"'

[创建后]
由用户通过 Desktop /model 或对应 CLI 参数自行切换；task-loop 不再自动改写。
```

### 4.2 可复制指令模板

```text
[创建专题任务]
目标项目: <project_id>
标题: [<专题名称>] <功能摘要>
提示词:
你是 Codex 专题任务。只处理 <module_key>，读取 <memory_doc>，
修改白名单: <allowlist>；禁止修改其他厂商状态与业务代码。
创建成功后记录真实 threadId，并登记到 vendors.codex.modules.<module_key>。
```

```text
[Desktop 请求]
调用 send_message_to_thread({
  threadId: "<registered_thread_id>",
  prompt: "<任务内容>"
})
仅当返回 submitted=true 才报告 SUBMITTED；否则报告 PREPARED_ONLY。
```

```bash
# [CLI 请求：已知线程]
codex queue --thread <registered_thread_id> --message "<任务内容>"

# [CLI 续接：显式批处理选择]
printf '%s' '<任务内容>' | codex exec resume <registered_thread_id> -
```

```text
[接收结果]
Desktop: wait_threads({targets:[{threadId:"<id>"}], timeoutMs:<ms>})
完成后再用 read_thread({threadId:"<id>", turnLimit:<n>}) 读取最终文本。
CLI: 消费 stdout/JSONL，按事件顺序记录状态；无输出或非零退出不得标记完成。
```

```text
[Hook 门禁]
Codex 不执行 PreInvocation/PreToolUse。执行前先校验 vendor=codex、thread_id 已登记、
module_key 在 allowlist；任一条件不满足即拒绝并返回 PREPARED_ONLY，禁止自动注入或物理拦截声明。
```

```json
[
  {
    "action": "新建专题任务",
    "host_tool": "create_thread",
    "min_input": "prompt, target, title?",
    "constraint": "仅在 topics.json 已启用且注册表预检允许时创建。"
  },
  {
    "action": "续发任务包",
    "host_tool": "send_message_to_thread",
    "min_input": "threadId, prompt",
    "constraint": "仅向已登记、项目一致且不忙碌的任务发送。"
  },
  {
    "action": "等待结果",
    "host_tool": "wait_threads",
    "min_input": "targets, timeoutMs",
    "constraint": "使用工具状态等待，不轮询 transcript。"
  },
  {
    "action": "读取或管理任务",
    "host_tool": "由当前宿主暴露的 thread 工具",
    "min_input": "目标 threadId",
    "constraint": "工具集合随 Codex 宿主版本和权限配置变化。"
  }
]
```

---

## 5. 官方 Codex SDK 与 task-loop 映射 (JSON 规范)

```json
[
  {
    "sdk": "TypeScript @openai/codex-sdk",
    "install": "npm install @openai/codex-sdk",
    "runtime_requirement": "Node.js 18+",
    "target_outer_loop_layer": "Node 编排服务、CI、已有 TypeScript 控制面"
  },
  {
    "sdk": "Python openai-codex",
    "install": "pip install openai-codex",
    "runtime_requirement": "Python 3.10+",
    "target_outer_loop_layer": "Python 编排服务、需要 Sandbox 明确控制每轮文件权限的场景"
  }
]
```

### SDK 状态映射：
```json
[
  {
    "task_loop_phase": "已通过用户确认且取得 lease",
    "sdk_action": "startThread() / thread_start()",
    "check_and_record": "返回的 thread_id、cwd、任务项、模型、sandbox、lease 持有者"
  },
  {
    "task_loop_phase": "已登记线程的下一轮",
    "sdk_action": "resumeThread(id).run() / 恢复对应 thread 后 run()",
    "check_and_record": "ID 是否来自注册表、项目根是否一致、是否仍持有同一 lease"
  },
  {
    "task_loop_phase": "只读方案或审阅",
    "sdk_action": "run() / thread.run() + 只读 sandbox",
    "check_and_record": "不授予写入权限；结果只写 journal，不改派单状态"
  },
  {
    "task_loop_phase": "任务完成或失败",
    "sdk_action": "读取最终响应/异常",
    "check_and_record": "完成状态、错误摘要、journal、lease 释放；不按最近会话重试"
  }
]
```

---

## 6. Codex MCP Server 与 App Server

### MCP Server 工具规范（deprecated）：
```json
[
  {
    "mcp_tool": "codex",
    "purpose": "启动新的 Codex 会话",
    "task_loop_fields": "必填 prompt；可传 cwd、model、approval-policy、sandbox、developer-instructions 等控制参数。"
  },
  {
    "mcp_tool": "codex-reply",
    "purpose": "向既有 Codex 会话追加一轮",
    "task_loop_fields": "必填 threadId 与 prompt；conversationId 仅是兼容旧客户端的弃用别名。"
  }
]
```

当前 Codex CLI 的 `mcp-server` 入口仅保留兼容性价值，官方文档标记为 deprecated；本项目不将其作为稳定自动派单路径，也不把 MCP 工具可用性作为 `SUBMITTED` 成功依据。参考：[Codex SDK 官方文档](https://learn.chatgpt.com/docs/codex-sdk.md)。

### App Server (JSON-RPC) 命令：
```bash
# 由标准输入输出承载 JSON-RPC
codex app-server --listen stdio://

# 从当前安装版本生成协议 Schema
codex app-server generate-json-schema --out <output-directory> --experimental
codex app-server generate-ts --out <output-directory> --experimental
```
