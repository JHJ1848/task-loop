# [SDK] ZCode (Z.ai) 深度对接规范

本文档为 `task-loop` 在 **ZCode 宿主**环境下的 Tier 3 深度契约，覆盖会话存储拓扑、SessionProvider 六大标准原语映射、Hook 生命周期 I/O 协议、子代理编排与插件接入方式。单主干架构下 (master 唯一维护分支)，ZCode 厂商能力的代码适配器 (Provider/Hook/安装器) 与本指导文档同库分层存放: 代码对其他宿主惰性无害，本档是唯一厂商知识收敛点。

> 适用版本基线: ZCode Desktop / CLI 3.9.x（win32-x64 实测）。文中所有路径均为用户主目录相对路径，严禁硬编码绝对系统路径。

---

## 一、会话持久化拓扑 (Persistence Topology)

```json
[
  {
    "path": "~/.zcode/cli/db/db.sqlite",
    "role": "权威会话注册表 (SQLite, 只读内省入口)",
    "key_tables": [
      "session: id(sess_uuid), parent_id(子代理谱系), project_id, title, directory/path(项目根), task_type, time_created/time_updated(epoch 毫秒)",
      "input_history: session_id, text(kind='prompt' 的真实用户输入), time_created",
      "message / part: 会话消息与分段内容",
      "session_target / workflow_*: 目标预算与后台工作流编排记录"
    ],
    "safety_rule": "task-loop Provider 一律以 uri=file:...?mode=ro 只读模式打开，严禁写入宿主库"
  },
  {
    "path": "~/.zcode/cli/rollout/model-io-sess_<uuid>.jsonl",
    "role": "每会话模型 I/O 逐行转储 (Node.js 零依赖反向内省入口)",
    "line_shape": "{ requestId, model{modelId,providerId}, request.body{messages[],headers{'x-session-id'}}, completedAt }",
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
    "zcode_mapping_tier1_in_process": "原生 Agent 工具（Task 别名）同步拉起子代理，返回即结果；谱系落 db.sqlite session.parent_id 与 session_task_link",
    "zcode_mapping_tier2_headless_cli": "zcode --cwd <project_dir> -p \"<prompt>\" 无头创建全新顶层会话；封装实现 scripts/providers/spawn_zcode_session.js|.py",
    "prerequisite": "CLI 无头运行需先完成认证，二选一: (a) `spawn_zcode_session login-api-key --key <API_KEY>` 将 API key 安全写入 ~/.zcode/cli/config.json（自动备份、schema 合规合并）; (b) zcode login（OAuth 写 ~/.zcode/v2/credentials.json）。桌面端密钥走进程内路由不落盘，CLI 无法直接复用桌面登录态"
  },
  {
    "primitive": "send(conversation_id, message_payload)",
    "zcode_mapping_tier1_in_process": "同进程 SendMessage(to: agent_<uuid>)；跨会话读走 ReadSessionContext(sess_id) + dispatch 状态包交接",
    "zcode_mapping_tier2_headless_cli": "zcode --resume <sess_id> -p \"<prompt>\" 续接既有会话（含无头创建的专题会话）；封装同 spawn 的 Provider 脚本"
  },
  {
    "primitive": "manage('list'|'kill'|'status')",
    "zcode_mapping": "本会话任务列表 (/tasks) 与 background 任务管理；子代理谱系可由 db.sqlite session.parent_id 与 session_task_link 表反查；CLI 会话清单可经 db.sqlite 只读内省获得",
    "difference_note": "AGY manage_subagents(kill_all) 无直接等价物；子代理随会话终止自动回收"
  },
  {
    "primitive": "await_reply()",
    "zcode_mapping": "回合制同步模型: Agent 工具调用返回即结果（无 Reactive Wakeup）；后台任务以 task-notification 完成事件回调唤醒，禁止轮询；CLI spawn/send 为阻塞式执行直至回合完成"
  }
]
```

---

## 二点五、无头 CLI 会话操作 (Headless CLI Session Operations, zcode 0.16.5 实测)

```json
[
  {
    "entry": "ELECTRON_RUN_AS_NODE=1 \"<安装根>/ZCode.exe\" \"<安装根>/resources/glm/zcode.cjs\" <args>",
    "mode_dispatch": "zcode.cjs 兼任 GUI 运行时与 CLI: argv 含 app-server/agent-server 为 electron 模式, 否则 cli 模式; CLI 不在 PATH",
    "discovery_helper": "scripts/providers/spawn_zcode_session.js|.py 的 discoverZcodeCli() (env ZCODE_CLI_BIN/ZCODE_CJS_PATH 可覆盖)"
  },
  {
    "commands": "app-server(ZCode Protocol stdio JSON-RPC) | tui | plugins list | skills list | login | logout | doctor | version",
    "session_flags": "-p/--print <text> 无头单轮(自动建新会话) | --cwd <dir> 指定工作目录 | --resume <sess_id> 续接既有会话 | --surface terminal | --mode yolo|build|edit|plan",
    "gotchas": ["--max-turns 与 --settings 在 help 中列出但被解析器拒绝(help 与实现不同步)", "-p 无头运行需先认证: login-api-key --key 或 zcode login 一次", "桌面端登录态不落盘, CLI 无法直接复用"]
  },
  {
    "provider_wrapper": {
      "script": "scripts/providers/spawn_zcode_session.js|.py",
      "check": "--check 输出 {cli, auth, spawn_send_ready, in_process_alternatives, protocol_alternative} 体检 JSON",
      "spawn": "spawn --cwd <dir> --prompt <text> [--dry-run] -> {ok, session_id?, output}",
      "send": "send --session <sess_id> --prompt <text> [--dry-run] -> {ok, output}",
      "exit_codes": "0 成功 | 1 CLI 未发现/参数非法 | 2 未登录 | 3 执行失败"
    }
  },
  {
    "known_limitation_desktop_sync": "无头 CLI 创建的会话直接落 db.sqlite 且字段与桌面端自建会话完全同级（同 project_id/task_type/未归档），但桌面端侧边栏会话列表为启动时加载的内存快照，不监听外部写入——新会话需重启 ZCode（或切换项目再切回）后才会显示。功能本身（续接/上下文/db 内省）不受影响。"
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
  { "capability": "子代理编排", "agy": "invoke_subagent / define_subagent / manage_subagents + Reactive Wakeup", "zcode": "Tier1: Agent(Task) 工具同步并发; Tier2: zcode -p 无头顶层会话 (scripts/providers/spawn_zcode_session.*); 无动态模板定义" },
  { "capability": "持久顶层专题会话", "agy": "agentapi new-conversation + send_message", "zcode": "Tier2: zcode --cwd -p 无头新建 + --resume 续接 (需先 login-api-key 或 zcode login); 会话登记 sessions.json 后经 dispatch 包或 CLI 续接交接" },
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

## 六、ZCode 宿主附加规范 (原 ZCode 分支 Skill 小节折叠归档)

通用技能文档 (skills/*) 保持厂商中立; 本节收敛原 ZCode 分支在 Skill 层的全部附加约束，ZCode 宿主的智能体在执行 init / new-session / 派单流程时必须叠加遵循。

```json
[
  {
    "rule_id": "ZC-1 强制用户提示 (不可省略)",
    "behavior": "经 spawn_zcode_session Provider 拉起会话成功后, 输出 JSON 携带 user_notice_must_relay 字段; 智能体必须将该字段内容原样转达给用户, 严禁省略。",
    "notice_content": "新会话已落库但桌面端侧边栏为内存快照, 需完全重启 ZCode (或切换项目后切回) 才会显示; 会话本身可立即经 send 子命令续接派单。",
    "rationale": "ZCode 0.16.5 桌面端不监听 db.sqlite 外部写入; 该限制可能随版本更新消除, 届时仅需删除本条与 Provider 内对应字段, 通用流程零改动。"
  },
  {
    "rule_id": "ZC-2 首次使用建议 (复用优先)",
    "behavior": "首次在 ZCode 中加载本插件时, 优先盘点并复用现有项目已有的历史会话 (scripts/find_project_sessions.py --vendor zcode) 与既有 docs/memory/*.md 记忆文档, 经 init 完成 1:1 对齐; 确无既有资产时才走 new-session 新建。"
  },
  {
    "rule_id": "ZC-3 零本机信息约束 (安全红线)",
    "behavior": "本厂商适配层产出的记忆文档、会话引导词、确认卡与所有用户可见输出中, 严禁出现本机绝对路径 (盘符路径/用户家目录)、API Key、用户名等敏感信息; 一律使用相对路径与环境变量引用。"
  },
  {
    "rule_id": "ZC-4 派单三步铁律 (ZCode 版)",
    "behavior": "1. 查 .agents/task-loop/sessions.json 寻找专题 -> 2. 无则经 spawn_zcode_session Provider spawn 子命令无头拉起 (spawn --cwd <项目根> --prompt \"<引导词>\", 引导词以 [专题名称] 功能1 & 功能2 开头) 或以原生 Agent 子代理进程内派发 -> 3. 经 send --session <sess_id> --prompt <任务> 续接下发; CLI 未认证时引导 login-api-key, 严禁退化为控制电脑点击 UI。"
  },
  {
    "rule_id": "ZC-5 init 缺失会话兜底",
    "behavior": "init --create-missing 在 ZCode 宿主对缺失会话的记忆文档经 new_topic_session 双宿主流程无头拉起; 未认证时降级为输出指引并支持用户手动新建后登记 sessions.json。"
  }
]
```

---

## 七、关联文档

* 跨厂商总索引: `references/sdk/README.md`
* AGY 主力实现: `references/sdk/agy.md`
* Codex / Claude 平行适配: `references/sdk/codex.md` / `references/sdk/claude.md`
* 单主干治理: `AGENTS.md` (七、单主干统一维护与多厂商状态分区持久化架构)
