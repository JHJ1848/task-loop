# OpenAI Codex 外层会话与集成 SDK 规范

本文档定义 `task-loop` 外层调度器如何识别、路由、续接和观察 Codex 任务。

## 0. 稳定适配边界

```json
[
  {
    "supported": "已知 thread 的 CLI 队列派单",
    "command": "codex queue --thread <id> --message <text>",
    "success_condition": "仅 CLI exit code 0 返回 SUBMITTED"
  },
  {
    "degraded": "显式 --resume 的批处理续接",
    "command": "codex exec resume <id> <prompt>",
    "success_condition": "仅显式选择且 CLI exit code 0 返回 SUBMITTED"
  },
  {
    "unsupported": "自动 PreInvocation / PreToolUse Hook、直接写 .codex/sessions、按 UUID 猜测 AGY"
  },
  {
    "experimental_only": "app-server / MCP；不得作为稳定自动派单或成功状态依据"
  }
]
```

`scripts/providers/codex_session_dispatch.js/.py` 在未执行、CLI 缺失或非零退出时只返回 `PREPARED_ONLY`，不会伪造成功或写入 `.codex/sessions`。

### 0.1 Provider 解耦入口

`scripts/providers/codex_session_provider.js/.py` 提供运行时纯适配入口 `submit/submit_async`。调用方可显式注入 `desktop`、`sdk`、`api` 函数；选择顺序固定为 Desktop -> SDK -> API -> CLI。适配器只有返回 `{submitted:true}` 才会映射为 `SUBMITTED`，否则返回 `PREPARED_ONLY`。Provider 不读取或写入 `.agents/task-loop`、`.codex/sessions`，也不猜测会话 ID。

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
