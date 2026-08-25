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
