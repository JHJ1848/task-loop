# [references/sdk/zcode.md] ZCode (Z.ai) 宿主环境会话与 Hook 管道技术参考

本文档定义了 `task-loop` 在 ZCode 宿主环境下的会话持久化拓扑、Hook 管道协议规范以及与 Google Antigravity (AGY) 主线能力的差异映射。

---

## 一、ZCode 会话持久化与数据源拓扑 (Persistence Topology)

```json
[
  {
    "path": "~/.zcode/cli/db/db.sqlite",
    "role": "会话元数据主库 (SQLite3, 仅只读模式 open uri=file:...&mode=ro 打开)",
    "key_tables": [
      "session (id, parent_id, title, directory, path, time_created, time_updated, task_type)",
      "input_history (id, session_id, text, kind, time_created)",
      "session_task_link (session_id, task_id)"
    ],
    "gotcha": "会话标题存放在 session.title；用户每轮真实提问在 input_history(kind='prompt') 按 time_created 顺序记录"
  },
  {
    "path": "~/.zcode/cli/rollout/model-io-sess_<uuid>.jsonl",
    "role": "每会话完整的模型输入/输出流水账 JSONL",
    "gotcha": "单行可包含整轮完整对话回放；宿主内置的标题生成任务会以 {\"title\":\"...\"} 形式混入，Provider 已做剥离"
  },
  {
    "path": "~/.zcode/cli/exec/sess_<uuid>/",
    "role": "每会话执行暂存区 (bash 快照 / shell-snapshots)",
    "introspection_use": "低价值，仅辅助活跃性判断"
  },
  {
    "path": "~/.zcode/cli/memories/projects/<project-key>/memory/",
    "role": "ZCode 自带项目记忆目录 (MEMORY.md 索引制)，与 task-loop 的 docs/memory/*.md 相互独立"
  }
]
```

---

## 二、六大 SessionProvider 原语映射 (Primitive Mapping)

```json
[
  {
    "primitive": "get_current_session_id",
    "zcode_mapping": "Hook stdin payload 的 session_id 字段；进程环境变量 ZCODE_SESSION_ID 或 CLAUDE_SESSION_ID（宿主双别名等价注入）",
    "implementation": "scripts/hooks/*_zcode.js|.py 的 extract_session_id()"
  },
  {
    "primitive": "scan_project_sessions(project_root)",
    "zcode_mapping": "db.sqlite 读库优先 (Python: scripts/providers/get_zcode_project_sessions.py)；rollout JSONL 行扫描兜底 (Node.js 同名 .js, Node 18+ 零依赖兼容)",
    "output_contract": "vendor/session_id/title/project_root/is_active/created_at/last_active_at/log_path/rule_files[/recent_prompts/recent_touched_files]"
  },
  {
    "primitive": "spawn(role, prompt, workspace, model)",
    "zcode_mapping": "原生 Agent 工具（即 Task 工具别名）拉起瞬态子代理；长期专题根会话由主会话调用 Skill 内置流程登记 sessions.json 后人工/编排创建（无 agentapi CLI 等价物）",
    "difference_note": "这是与 AGY 最大差异: ZCode 无独立顶层会话拉起 CLI，Level 2 跨周期专题落盘依赖 AGY 分支的 agentapi 流程不可用，需用户在 ZCode 中开新会话后由 init 登记"
  },
  {
    "primitive": "send(conversation_id, message_payload)",
    "zcode_mapping": "同进程内: SendMessage 工具投递本地代理；跨会话: 无原生 send_message，以 ReadSessionContext(sess_id) 反向取上下文 + 项目级状态文件交接替代",
    "handoff_pattern": "派发方将会话包写入 .agents/task-loop/dispatch/*.json，目标会话经 sessions.json 定位后读取"
  },
  {
    "primitive": "manage('list'|'kill'|'status')",
    "zcode_mapping": "本会话任务列表 (/tasks) 与 background 任务管理；子代理谱系可由 db.sqlite session.parent_id 与 session_task_link 表反查",
    "difference_note": "AGY manage_subagents(kill_all) 无直接等价物；子代理随会话终止自动回收"
  },
  {
    "primitive": "await_reply()",
    "zcode_mapping": "回合制同步模型: Agent 工具调用返回即结果（无 Reactive Wakeup）；后台任务以 task-notification 完成事件回调唤醒，禁止轮询"
  }
]
```

---

## 三、Hook 生命周期契约 (Hooks Contract)

### 1. 七大支持事件与注册格式

```json
[
  { "event": "SessionStart", "match_value": "startup | resume | clear | compact" },
  { "event": "UserPromptSubmit", "match_value": "提示词文本正则" },
  { "event": "PreToolUse", "match_value": "工具名大小写敏感正则 (Edit|Write|MultiEdit|NotebookEdit); 别名 Task<->Agent, ApplyPatch 归一化为 Write/Edit" },
  { "event": "PermissionRequest", "match_value": "工具名正则" },
  { "event": "PostToolUse", "match_value": "工具名正则" },
  { "event": "PostToolUseFailure", "match_value": "工具名正则" },
  { "event": "Stop", "match_value": "响应预览正则" }
]
```

配置物理位置二选一: 插件级 `hooks/hooks.json`（外层必须含 `"hooks"` 包裹，插件存在时 hook runner 自动启用）; 配置文件级 `~/.zcode/cli/config.json` 或 `<repo>/.zcode/config.json` 的 `hooks.events.*`（默认关闭，必须显式 `enabled: true`）。

### 2. stdin 输入 (Claude Code 兼容双命名)

```json
{
  "snake_case_primary": ["session_id", "transcript_path", "cwd", "hook_event_name", "tool_name", "tool_input", "tool_use_id", "agent_type", "permission_mode"],
  "camel_case_passthrough": ["sessionId", "transcriptPath", "hookEventName", "toolName", "toolInput"],
  "transcript_semantics": "transcript_path 指向每次触发时临时生成的 transcript.jsonl 快照，非持久路径"
}
```

### 3. stdout 输出 (严格 schema，多余键直接判失败)

```json
[
  {
    "events": ["SessionStart", "UserPromptSubmit"],
    "success_shape": "{ \"hookSpecificOutput\": { \"hookEventName\": \"<同名事件>\", \"additionalContext\": \"...\" }, \"suppressOutput\": true }"
  },
  {
    "events": ["PreToolUse"],
    "deny_shape": "{ \"hookSpecificOutput\": { \"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"allow|ask|deny\", \"permissionDecisionReason\": \"...\" } }",
    "allow_convention": "放行时输出空 stdout 且 exit code 0（最稳，规避多余键校验）"
  },
  {
    "exit_codes": "0 = 通过; 2 = PreToolUse/PermissionRequest 阻断; 其他非零 = 运行错误(记日志不阻断)"
  }
]
```

### 4. 模板变量与环境变量

`${CLAUDE_PROJECT_DIR}` / `${ZCODE_PROJECT_DIR}`（工作区根）、`${CLAUDE_SESSION_ID}` / `${ZCODE_SESSION_ID}`、插件专属 `${CLAUDE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_ROOT}`（插件根目录）。双前缀完全等价; 本插件命令统一使用 `${CLAUDE_PLUGIN_ROOT}` 以同时兼容 `.claude-plugin/` 兼容加载。`type:"command"` 的 timeout 单位为秒，`type:"process"` 的 timeoutMs 单位为毫秒。

---

## 四、task-loop 差异适配矩阵 (AGY -> ZCode)

```json
[
  { "capability": "每轮瞬态上下文注入", "agy": "PreInvocation + injectSteps[ephemeralMessage]", "zcode": "UserPromptSubmit(+SessionStart) + additionalContext (additionalContext 即同语义瞬态注入)" },
  { "capability": "写文件白名单硬门禁", "agy": "PreToolUse(matcher=replace_file_content|write_to_file|...) decision:allow/deny", "zcode": "PreToolUse(matcher=Edit|Write|MultiEdit|NotebookEdit) permissionDecision:deny/空静默放行(exit 0)" },
  { "capability": "历史会话反向内省", "agy": "~/.gemini/antigravity/brain/*/transcript.jsonl", "zcode": "db.sqlite(sqlite3 ro) + rollout/model-io-sess_*.jsonl" },
  { "capability": "当前会话 ID", "agy": "stdin.conversationId / ANTIGRAVITY_CONVERSATION_ID", "zcode": "stdin.session_id / ZCODE_SESSION_ID / CLAUDE_SESSION_ID" },
  { "capability": "子代理编排", "agy": "invoke_subagent / define_subagent / manage_subagents + Reactive Wakeup", "zcode": "Agent(Task) 工具同步并发调用; 无动态模板定义; 完成即回收" },
  { "capability": "持久顶层专题会话", "agy": "agentapi new-conversation + send_message", "zcode": "无 CLI 等价; 新开会话由 init 技能登记 sessions.json, 跨会话走 dispatch 包交接" },
  { "capability": "常驻规则注入", "agy": "plugin capabilities.rules (rules/task-loop-governance.md 自动加载)", "zcode": "Plugin 无 rules 执行位; 由 SessionStart/UserPromptSubmit Hook 注入压缩版治理提示与文档指针" }
]
```

---

## 五、插件接入与验证 (Integration & Verification)

1. **目录形态**: 仓库根提供 `.zcode-plugin/plugin.json`（`name` 必须匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`），声明 `skills` 组件; Hook 以 `hooks/hooks.json` 存在即可被自动发现（插件钩子免 enabled 门禁）。
2. **本地装载**: ZCode 设置 -> Plugin Management -> Discover -> 从本地目录添加仓库根; 或按 Marketplace 规范发布。
3. **自检步骤**: Settings -> Plugin Management 打开 task-loop 详情页确认各 Hook 为 runnable; 手工运行 `node scripts/hooks/inject_session_context_zcode.js --event SessionStart < sample-payload.json` 校验 stdout JSON。
4. **实验证据**: 任何 Hook 改动的交付证据 = 采样 payload 全链路实跑记录 + tests/test_hooks_zcode.* 测试 Exit Code 0。

---

## 六、关联文档

* 跨厂商总索引: `references/sdk/README.md`
* AGY 主力实现: `references/sdk/agy.md`（master 分支主线）
* Codex / Claude 平行适配: `references/sdk/codex.md` / `references/sdk/claude.md`
