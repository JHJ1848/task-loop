# Anthropic Claude Code 会话与集成 SDK 规范

本文档定义 `task-loop` 中与 Anthropic Claude Code 会话感知、任务派发与 Hooks 事件管道的标准集成方式。

---

## 1. 核心会话控制能力与接口 (JSON 规范)

```json
[
  {
    "category": "获取当前会话 ID (方式 A: Hook 注入)",
    "mechanism_or_tool": "Hooks stdin JSON",
    "signature": "stdin JSON -> .session_id",
    "description": "Hook 进程从 stdin JSON 公共字段读取当前会话 ID；无官方 CLAUDE_SESSION_ID 环境变量。SessionStart 纯文本 stdout 自动注入会话上下文；UserPromptSubmit 经 hookSpecificOutput.additionalContext 注入。"
  },
  {
    "category": "获取活动会话 (方式 B: agents 查询)",
    "mechanism_or_tool": "claude agents --json",
    "signature": "[--all] [--cwd <path>]",
    "description": "免 TTY 脚本化输出活动会话：sessionId、state (working/blocked/done/failed/stopped)、waitingFor、kind (interactive/background)、startedAt、cwd；--all 附带已完成会话。"
  },
  {
    "category": "获取工程关联会话 (方式 C: 脚本扫描)",
    "mechanism_or_tool": "Provider Scanner",
    "signature": "node scripts/providers/get_claude_project_sessions.js <root> --inspect",
    "description": "物理反向内省：按路径编码规则定位 ~/.claude/projects/ 下的项目目录，解析各 <uuid>.jsonl 中的 sessionId、cwd 与 timestamp，反查属于当前工程的全部会话并按最近活跃排序。"
  },
  {
    "category": "拉起固定 ID 会话",
    "mechanism_or_tool": "claude --session-id <uuid>",
    "signature": "须为合法 UUID",
    "description": "为新会话预指派 ID，供外层编排器(Orchestrator)预先登记与追踪；可与 -p 组合做无头派发。"
  },
  {
    "category": "无头派发与结果回读",
    "mechanism_or_tool": "claude -p --output-format json",
    "signature": "claude -p '<任务包>' --output-format json",
    "description": "单次执行返回结构化结果 JSON：session_id、result、is_error、subtype、num_turns、duration_ms、total_cost_usd、usage、model_usage。"
  },
  {
    "category": "续接 / 分叉既有会话",
    "mechanism_or_tool": "--resume / -c / --fork-session",
    "signature": "claude -p --resume <session-id> '<指令>'",
    "description": "--resume <id> 续接指定会话；-c 续接当前目录最近会话；--fork-session 续接时生成新 ID，适合对既有会话做非破坏性只读追问。"
  },
  {
    "category": "流式双向管道",
    "mechanism_or_tool": "stream-json",
    "signature": "--output-format stream-json --input-format stream-json",
    "description": "实时流式输入/输出；首条 system/init 事件即携带 session_id；可叠加 --include-partial-messages、--forward-subagent-text。"
  },
  {
    "category": "后台代理",
    "mechanism_or_tool": "--bg",
    "signature": "claude --bg '<任务包>'",
    "description": "启动后台代理会话并立即返回，经 claude agents 视图管理；与 -p 互斥。"
  },
  {
    "category": "权限与工具白名单",
    "mechanism_or_tool": "CLI 旗标",
    "signature": "--permission-mode <mode> / --allowedTools / --disallowedTools",
    "description": "权限模式：acceptEdits|auto|bypassPermissions|manual|dontAsk|plan；外层 loop 可为 worker 下发专属 --settings <file>。"
  },
  {
    "category": "钩子与事件观测",
    "mechanism_or_tool": "Hooks",
    "signature": "UserPromptSubmit / Stop / SubagentStop / SessionStart / SessionEnd / PreToolUse / PostToolUse / PreCompact",
    "description": "stdin JSON 公共字段：session_id、transcript_path、cwd、hook_event_name；exit code 2 可阻断对应动作。"
  },
  {
    "category": "Agent SDK (程序化编排)",
    "mechanism_or_tool": "claude-agent-sdk / @anthropic-ai/claude-agent-sdk",
    "signature": "query() / ClaudeSDKClient",
    "description": "Python：ClaudeAgentOptions 含 resume、fork_session、session_id 等，ClaudeSDKClient 跨多轮维持同一会话；TypeScript：query() 多轮续接靠 continue: true。"
  }
]
```

---

## 2. 典型调用命令示例

```bash
# 1. 无头派发 worker 并固定会话 ID，读取结构化结果
claude -p "请根据任务包 LOOP-003 执行修复，文件白名单：src/..." \
  --session-id 6f4c9a1e-0000-4000-8000-000000000003 \
  --output-format json --allowedTools "Read Edit Bash" \
  | jq '{session_id, is_error, result, total_cost_usd}'

# 2. 续接既有 worker 会话下发下一轮指令（只读追问加 --fork-session）
claude -p --resume 6f4c9a1e-0000-4000-8000-000000000003 "汇报当前进度" --output-format json

# 3. 脚本化查询活动/后台会话（输出完整 sessionId，可直接 --resume）
claude agents --json --all --cwd "$(pwd)" | jq -r '.[] | select(.sessionId) | .sessionId'

# 4. 物理反查当前工程的全部 Claude 会话
node scripts/providers/get_claude_project_sessions.js . --inspect
```

---

## 3. 侧边栏可见性门禁与主动拉起通道 (Sidebar Gate & Provisioning Channel)

本节是 Claude Code 适配的核心结论，全部结论均在本机 Claude Desktop 实机实测确认。

### 3.1 侧边栏可见性门禁 (Sidebar Visibility Gate)

左侧「项目 -> 会话列表」的成员资格由**两条**决定：

```json
[
  {
    "gate": 1,
    "condition": "是 App 会话：存在 hostSessionId（形如 local_xxx）且 isArchived=false",
    "note": "未运行的 App 会话仍保留在列表中（可点击续接）"
  },
  {
    "gate": 2,
    "condition": "运行期附着状态：~/.claude/sessions/<pid>.json 注册表条目存活",
    "note": "注册表只标记正在运行/可附着的进程；进程结束后条目消失，但会话仍在列表里"
  }
]
```

注册表条目字段（`~/.claude/sessions/<pid>.json`）：

```json
{
  "pid": 84928,
  "sessionId": "<CLI/hook 裸 UUID，task-loop 绑定用此值>",
  "hostSessionId": "local_xxx (App 侧命名空间；无此字段则不进项目会话列表)",
  "kind": "interactive (App 宿主) | bg (后台代理)",
  "entrypoint": "claude-desktop-3p (由 Desktop 宿主环境继承)",
  "cwd": "<工程路径；决定归属哪个项目分区>",
  "name": "<标题>",
  "status": "idle | busy | blocked | done | failed | stopped"
}
```

不具备门禁资格的通道（实测对照）：

```json
[
  {
    "channel": "claude --bg",
    "registry": "有条目，entrypoint 亦为 claude-desktop-3p",
    "hostSessionId": "缺失",
    "kind": "bg",
    "verdict": "不进项目会话列表（仅出现在 claude agents 后台代理视图）"
  },
  {
    "channel": "claude -p（无头）",
    "registry": "通常无条目",
    "verdict": "不进项目会话列表；适合单次任务回读，不适合作为常驻专题会话"
  },
  {
    "channel": "claude --session-id",
    "registry": "仅预指派 UUID，不改变入口与宿主归属",
    "verdict": "单独使用不产生侧边栏会话"
  }
]
```

### 3.2 App 宿主环境的主动拉起通道 (App-Hosted Provisioning Channel)

在 Claude Desktop 宿主会话内，**唯一可程序化产出侧边栏会话**的通道是 scheduled-task（定时任务）通道：由 App 自身按"新建会话"的方式启动，因此会分配 `hostSessionId`。

```json
[
  {
    "step": 1,
    "action": "创建一次性任务（不带 cron，仅手动触发）",
    "tool": "scheduled_tasks_create_scheduled_task",
    "args": {
      "taskId": "taskloop-topic-<module_key>",
      "prompt": "<专题引导词：自报 cwd + 会话 ID + 声明专题定位，严禁改文件>",
      "description": "<用途>"
    }
  },
  {
    "step": 2,
    "action": "运行任务以拉起会话",
    "tool": "scheduled_tasks_run_scheduled_task",
    "returns": "local_<uuid>（App 侧会话 ID，非裸 UUID）"
  },
  {
    "step": 3,
    "action": "由 hostSessionId 反查裸 UUID（绑定必须用裸 UUID）",
    "command": "node scripts/providers/claude_session_provider.js resolve --host local_<uuid>",
    "fallback": "读取 ~/.claude/sessions/*.json 中 hostSessionId 匹配项的 sessionId 字段"
  },
  {
    "step": 4,
    "action": "就地绑定为专题会话",
    "command": "node scripts/new_topic_session.js --workspace . --vendor claude --doc docs/memory/<key>.md --bind-current <裸UUID>"
  },
  {
    "step": 5,
    "action": "派单（跨会话定向发信，宿主原生原语）",
    "tool": "send_message 指向该 App 会话",
    "note": "脚本层无法调用宿主 MCP 工具；派单必须由主会话执行"
  }
]
```

`cwd` 继承规则（实测）：新会话的 `cwd` 继承**创建该任务的会话所在工程**，因此任务必须从目标工程的会话中创建，否则会话会落到别的项目分区下。

### 3.3 已知坑位 (Gotchas)

```json
[
  {
    "gotcha": "删除定时任务会连带归档它拉起的会话",
    "evidence": "delete_scheduled_task 回执: '1 run session was archived'",
    "impact": "会话被移出列表，send_message 直接投递失败",
    "mitigation": "改为保留任务；确需删除则随后调用 unarchive 恢复（归档仅是可逆移除，不丢会话内容）"
  },
  {
    "gotcha": "App 侧 local_* 与 CLI/hook 裸 UUID 是两套命名空间",
    "impact": "用 local_* 绑定专题会失败（Hook 的 PreToolUse 按裸 UUID 校验会话注册）",
    "mitigation": "一律先 resolve 成裸 UUID 再写入 sessions.json"
  },
  {
    "gotcha": "CLI 子进程拿不到宿主凭据",
    "evidence": "子进程中 claude -p / claude stop 均返回 'Not logged in'；CLAUDE_CODE_HOST_AUTH_ENV_VAR 指向的令牌只注入宿主自身拉起的子进程",
    "impact": "不能靠 shell 调用 claude CLI 完成抓取会话或管理后台代理",
    "mitigation": "会话管理一律走宿主 MCP 工具面"
  },
  {
    "gotcha": "插件治理门禁要求会话已注册",
    "evidence": "未注册会话的文件写入被 PreToolUse 拒绝：'is missing, unregistered, or mismatched for vendor'",
    "impact": "vendors.claude 分区不存在时，Claude 侧所有写操作被拒，表现为插件对 Claude Code 完全不可用",
    "mitigation": "先执行 scripts/init_task_loop.js --vendor claude --main-session <当前会话UUID> 建立分区"
  },
  {
    "gotcha": "主会话只能写治理/状态文件",
    "scope": ".agents, docs, rules, templates, references, config, AGENTS.md, plugin.json, hooks.json",
    "impact": "scripts/ 与 skills/ 与 tests/ 必须派单给专题会话，主会话直接写同样被拒"
  },
  {
    "gotcha": "App 会话列表在磁盘上无可读来源",
    "evidence": "全盘检索 ~/.claude、%APPDATA%/Claude、%LOCALAPPDATA%/Claude，local_* 标识仅出现在 transcript 记录中；App 数据目录仅有 claude_desktop_config.json 与 logs/",
    "impact": "脚本只能读注册表，而注册表只反映存活进程，无法判定空闲（未运行）会话是否仍在侧边栏列表中",
    "mitigation": "注册表判定只用于回答'当前是否有存活进程附着'；核验已绑定专题会话是否存在时，不得仅凭 not_registered / pid_dead 判定失效而重复拉起新会话"
  }
]
```
