# Task Loop (`task-loop`)

通用跨 Agent 任务循环调度器（Universal Cross-Agent Task Loop），全面支持 **ZCode (Z.ai)**、**Antigravity (AGY)**、**Codex** 和 **Claude Code**。

> **[ZCode 分支说明]** 当前 `ZCode` 分支在 master（AGY 主线）之上做了差异化适配：新增 `.zcode-plugin/plugin.json` 插件清单、`hooks/hooks.json` 七事件钩子管道（SessionStart / UserPromptSubmit 瞬态上下文注入 + PreToolUse 白名单硬门禁）、`scripts/providers/get_zcode_project_sessions.*` 会话反向内省 Provider（Python 读 `db.sqlite` / Node.js 扫 rollout JSONL 双通道），以及深度契约文档 `references/sdk/zcode.md`。安装方式：ZCode 设置 -> Plugin Management -> 从本地目录添加本仓库根目录。

![架构设计与落地方案](assets/architecture.png)

---

## [Core Features] 核心特性

- **多厂商环境感知（Vendor-Agnostic）**：自动扫描并解析当前项目的历史 Agent 会话（AGY / Codex / Claude），提取交互元数据与上下文。
- **智能打标与专题会话路由（Auto-Tagging & Routing）**：主会话 AI 结合工程架构对子会话进行语义化分类与标签化（`tags` / `module_key`），构建项目专题拓扑。
- **1 / 2 / 3 复杂度分级调度（Complexity Tiering）**：
  - **Level 1（简单）**：单点 Bugfix / 单文件修改，直发单线程极速闭环。
  - **Level 2（标准）**：模块内功能开发与重构，边界约束内自测与专题记忆回写。
  - **Level 3（复杂）**：跨模块架构演进 / 耗时 > 3 分钟，强制 Subagent 编排（Research / Worker / Reviewer 并行流转）。
- **双运行时环境支持（Dual Runtime: Node.js & Python）**：为满足广大全栈开发者的习惯，所有调度与会话感知脚本均提供 Node.js（推荐主力，零 npm 依赖）与 Python 3.8+（备份备案，零 pip 依赖）双版本实现。

---

## [Structure] 项目结构

```text
task-loop/
├── plugin.json              # Antigravity Plugin 核心声明清单
├── .zcode-plugin/           # ZCode Plugin 核心声明清单 (ZCode 分支)
│   └── plugin.json
├── hooks.json               # 插件钩子管道配置 (PreInvocation / PreToolUse)
├── hooks/                   # ZCode 插件钩子管道配置 (ZCode 分支, 七事件)
│   └── hooks.json
├── SKILL.md                 # Agent 核心 Skill 说明与规范
├── README.md                # 项目主说明与版本记录
├── assets/                  # 架构图与静态资源
│   └── architecture.png
├── config/                  # 用户配置与偏好定义
│   ├── user_preferences.json # 用户偏好自解释配置文件
│   └── README.md            # 配置参数详解手册
├── rules/                   # 插件内置全局治理规则
│   └── task-loop-governance.md
├── references/              # 契约与 Schema 规范
│   ├── sdk/                 # 跨厂商会话 SDK 规范目录
│   │   ├── README.md        # SDK 抽象层与厂商索引
│   │   ├── agy.md           # Google Antigravity SDK
│   │   ├── codex.md         # OpenAI Codex SDK
│   │   ├── claude.md        # Anthropic Claude Code SDK
│   │   └── zcode.md         # ZCode (Z.ai) SDK (ZCode 分支)
│   ├── dispatch-contract.md # 派单与初始化契约
│   └── work-item-schema.md  # 任务与会话状态字段规范
├── scripts/                 # 跨平台调度与扫描脚本集 (Node.js / Python)
│   ├── install_zcode_plugin.js / .py   # 一键安装到 ZCode 本地插件目录
│   ├── hooks/               # 钩子处理脚本集 (PreInvocation / PreToolUse)
│   │   ├── inject_session_context.js / .py
│   │   ├── enforce_allowlist.js / .py
│   │   ├── inject_session_context_zcode.js / .py  (ZCode 分支协议适配)
│   │   └── enforce_allowlist_zcode.js / .py       (ZCode 分支协议适配)
│   ├── find_project_sessions.js / .py
│   ├── initialize_task_loop_state.js / .py
│   ├── summarize_project_sessions.js / .py
│   ├── acquire_task_loop_lease.js / .py
│   ├── release_task_loop_lease.js / .py
│   ├── new_task_loop_dispatch_packet.js / .py
│   ├── reconcile_task_loop_topics.js / .py
│   ├── get_task_loop_statistics.js / .py
│   ├── invoke_task_loop_tick.js / .py
│   ├── test_task_loop_preflight.js / .py
│   └── providers/           # 各 Agent 厂商适配 Provider
│       ├── get_agy_project_sessions.js / .py
│       ├── get_codex_project_sessions.js / .py
│       ├── get_claude_project_sessions.js / .py
│       └── get_zcode_project_sessions.js / .py    (ZCode 分支)
└── tests/                   # 自动化测试与用例 (Node.js / Python)
```

---

## [Quick Start] 快速上手

### 1. 作为 ZCode Plugin 插件使用 (ZCode 分支推荐)
```bash
# 一键安装到 ZCode 官方本地插件目录 (~/.zcode/plugin-workspace/task-loop)
node scripts/install_zcode_plugin.js
```
脚本会以快照方式将运行时白名单复制到 `~/.zcode/plugin-workspace/task-loop/` 并生成 `marketplace.json`；随后在客户端 **Settings -> Plugin Management -> Discover** 页添加该目录为本地市场并选择 `task-loop` 启用即可。

> 完整的分步说明（前置条件、参数详解、各操作系统路径、验证清单、刷新/卸载与常见问题）见下文 **[ZCode Install Guide] 详细安装指南** 章节。

### 2. 作为 Antigravity Plugin 插件使用
- **工作区级安装**：将本项目目录软链接或放置于工作区 `.agents/plugins/task-loop/`；
- **全局用户级安装**：放置于 `~/.gemini/config/plugins/task-loop/`；
- 系统自动加载 `plugin.json`、`hooks.json`、`rules/` 与 `SKILL.md`，实现零 Token 开销的会话感知与物理安全门禁。

### 3. 作为独立脚本库运行
```bash
# 推荐优先使用 Node.js 18+ (零 npm 依赖)
node scripts/find_project_sessions.js

# 或使用 Python 3.8+ 备用 (零 pip 依赖)
python scripts/find_project_sessions.py
```

### 4. 作为 Agent Skill 使用
在 Antigravity / Codex / Claude Code 中加载本项目目录或将其作为 Skill 引入后，通过 `/task-loop` 指令触发调度流转。

---

## [ZCode Install Guide] ZCode 详细安装指南

本章节面向想在 **ZCode (Z.ai)** 宿主中使用 task-loop 的用户，完整覆盖从取码、安装、客户端加载到验证与卸载的全流程。整个流程约 3 分钟，全程零外部依赖。

### 一、前置条件

```json
[
  { "item": "ZCode 客户端 / CLI", "requirement": "3.9.x 及以上（含 Plugin Management 与本地市场能力）", "check": "Settings 菜单中存在 'Plugin Management' 即满足" },
  { "item": "Node.js", "requirement": "18+ （主力运行时；脚本与全部 Hook 基于 Node 标准库，零 npm 依赖）", "check": "node --version" },
  { "item": "Python 3.8+", "requirement": "可选。仅当使用 Python 版安装器或 Hook 兜底时需要（零 pip 依赖）", "check": "python --version" },
  { "item": "Git", "requirement": "仅用于拉取源码仓库", "check": "git --version" }
]
```

### 二、第一步: 获取 ZCode 分支源码

```bash
# 克隆仓库并切换到 ZCode 分支
# (master 分支是 AGY/Antigravity 主线; ZCode 分支才包含 .zcode-plugin 适配层)
git clone <仓库地址> task-loop
cd task-loop
git checkout ZCode

# 自检: 确认 ZCode 插件适配层存在
# Windows (PowerShell) : Test-Path .zcode-plugin/plugin.json
# macOS / Linux        : test -f .zcode-plugin/plugin.json && echo OK
```

若在错误分支执行安装，脚本会直接报错拒绝：

```
[Install FAIL] 未找到 <路径>\.zcode-plugin\plugin.json ：请确认当前仓库为包含
ZCode 适配层 (.zcode-plugin/) 的分支后再执行安装。
```

### 三、第二步: 执行一键安装

```bash
# 基础安装 (Node.js 18+, 推荐)
node scripts/install_zcode_plugin.js

# 或 Python 3.8+ 备选 (零 pip 依赖, 与 Node 版行为一致)
python scripts/install_zcode_plugin.py
```

脚本自动完成三件事:

1. **校验源仓库**: 读取 `.zcode-plugin/plugin.json` 并校验 name 满足 ZCode 清单规范 `^[a-z0-9][a-z0-9._-]{0,127}$`;
2. **白名单快照复制**: 只拷贝运行时必需集合到默认目标 `~/.zcode/plugin-workspace/task-loop/`（幂等覆盖，重跑即刷新），同时排除一切开发态内容;
3. **生成市场清单**: 在目标根部写入 `marketplace.json`（市场名 `task-loop-local`, 插件 `task-loop`, source `./`）与导出说明 `EXPORT-INFO.md`。

复制白名单与排除项明细:

```json
[
  {
    "copied_dirs": [".zcode-plugin", "hooks", "skills", "rules", "scripts", "templates", "references", "config", "assets"],
    "copied_files": ["plugin.json", "hooks.json", "SKILL.md", "README.md", "LICENSE"],
    "excluded": ["tests/", "docs/", "AGENTS.md", ".git", "__pycache__/", "*.pyc", ".idea/"]
  },
  {
    "target_layout": [
      "~/.zcode/plugin-workspace/task-loop/",
      "├── marketplace.json     # 客户端 Discover 页识别的本地市场清单",
      "├── EXPORT-INFO.md       # 导出时间与来源说明",
      "├── .zcode-plugin/plugin.json",
      "├── hooks/hooks.json     # SessionStart/UserPromptSubmit/PreToolUse 三钩子",
      "├── skills/              # task-loop/session-control/subagent/hook/init 五技能",
      "└── scripts/             # Hook 协议适配层 + 调度 Provider 全集"
    ]
  }
]
```

可用参数一览:

```json
[
  { "flag": "--check", "runtime": "js/py 皆可", "effect": "仅校验源仓库并打印安装计划（目标/目录/文件/市场名），不写任何文件" },
  { "flag": "--dest <path>", "runtime": "js/py 皆可", "effect": "自定义目标根目录（实际仍写入 <path>/task-loop 子目录）；默认为 ~/.zcode/plugin-workspace" },
  { "flag": "--enable", "runtime": "js/py 皆可", "effect": "额外将 task-loop@task-loop-local=true 写入 ~/.zcode/cli/config.json 的 plugins.enabledPlugins（写前自动备份 config.json.bak-task-loop-install）" },
  { "safety_guards": ["目标目录与源仓库相同或互为父子包含关系时拒绝执行（防自吞）", "复制过滤垃圾文件并在完成后二次清扫"] }
]
```

### 四、第三步: 在 ZCode 客户端加载本地市场

安装脚本结尾会打印同样的指引。图形界面操作路径如下:

1. 打开 **Settings（设置） -> Plugin Management（插件管理）**；
2. 切换到 **Discover（发现）** 标签页，点击 **[+]** 添加市场；
3. 选择 **Local directory（本地目录）** 类型，浏览选择安装根目录:
   - 该目录根部必须能直接看到 `marketplace.json` 文件；
   - 默认即 `~/.zcode/plugin-workspace/task-loop`。
4. 客户端识别出市场 **task-loop-local** 后，列表会出现插件 **task-loop**；
5. 点击该插件的 **Install（安装）**, 再确认状态为 **Enabled（已启用）**；
6. 打开 task-loop 的详情页，确认其列出的三个 Hook（SessionStart / UserPromptSubmit / PreToolUse）均显示 **runnable**；
7. 重启一个会话（或在设置里 Reload 插件）使钩子生效。

各操作系统下安装副本的绝对位置参考（`~` 为用户主目录）:

```json
[
  { "os": "Windows", "default_dest": "C:\\Users\\<用户名>\\.zcode\\plugin-workspace\\task-loop", "cli_config": "C:\\Users\\<用户名>\\.zcode\\cli\\config.json" },
  { "os": "macOS", "default_dest": "/Users/<用户名>/.zcode/plugin-workspace/task-loop", "cli_config": "/Users/<用户名>/.zcode/cli/config.json" },
  { "os": "Linux", "default_dest": "/home/<用户名>/.zcode/plugin-workspace/task-loop", "cli_config": "/home/<用户名>/.zcode/cli/config.json" }
]
```

### 五、第四步: 验证安装生效

按顺序逐项自检（任一不通过先做第 6 步的重载再复查）:

```json
[
  { "check_id": "V1", "item": "插件列表可见", "method": "Plugin Management -> Installed 列表存在 task-loop 且开关为 Enabled" },
  { "check_id": "V2", "item": "Hook 可运行", "method": "task-loop 详情页三条 Hook 状态均为 runnable" },
  { "check_id": "V3", "item": "上下文注入生效", "method": "新会话任意一轮顶部出现 '[Plugin: task-loop | 会话上下文感知]' 注入块（首轮显示'未注册会话'属正常, 提示运行 /init 登记）" },
  { "check_id": "V4", "item": "命令行冒烟", "method": "手动回放采样 payload: echo '{\"session_id\":\"test\",\"cwd\":\".\"}' | node scripts/hooks/inject_session_context_zcode.js ，应输出合法 hookSpecificOutput JSON 且退出码 0" },
  { "check_id": "V5", "item": "会话内省可用", "method": "node scripts/find_project_sessions.js --vendor zcode 能列出本项目历史会话（依赖本机已有 ZCode 会话记录）" }
]
```

### 六、日常刷新与卸载

**刷新（升级代码后同步副本）**——Git 工作区只是开发目录，ZCode 客户端永远只读取安装副本，因此改完代码必须重新执行安装脚本:

```bash
git checkout ZCode && git pull
node scripts/install_zcode_plugin.js     # 幂等整目录覆盖, 无需先删除
```
然后在客户端重载插件（或重启会话）。开启新对话即可使用最新版本。

**卸载**——两处清理（副本目录可直接整删；如使用了 --enable 再手动移除对应键或恢复备份文件）:

```text
1. 删除安装副本: rm -rf ~/.zcode/plugin-workspace/task-loop   (Windows: 直接删除同义目录)
2. 启用开关: 移除 ~/.zcode/cli/config.json 中 plugins.enabledPlugins 内的
   "task-loop@task-loop-local" 键, 或用备份 config.json.bak-task-loop-install 还原;
   也可在客户端 Plugin Management 界面中对 task-loop 执行 Disable/Uninstall。
```

### 七、常见问题 (FAQ)

```json
[
  {
    "faq_id": "FAQ 1",
    "question": "安装时报错 '未找到 .zcode-plugin/plugin.json'",
    "answer": "当前检出的是 AGY 主线 master 分支。执行 git checkout ZCode 切换到 ZCode 适配分支后重试。"
  },
  {
    "faq_id": "FAQ 2",
    "question": "Discover 页添加目录后看不到任务循环市场",
    "answer": "选择的层级不对：请选中根部直接含有 marketplace.json 的目录本身 (~/.zcode/plugin-workspace/task-loop)，而不是它的上级 plugin-workspace 目录。"
  },
  {
    "faq_id": "FAQ 3",
    "question": "插件已启用但会话没有任何注入",
    "answer": "三查: 1) 详情页 Hook 是否 runnable; 2) 是否用了旧会话未重载，请新开一轮会话验证; 3) 运行 V4 命令行冒烟排除断言宿主环境缺 node 进 PATH 的可能。"
  },
  {
    "faq_id": "FAQ 4",
    "question": "直接把 Git 工作区当市场目录添加可行吗",
    "answer": "强烈不建议。工作区会被切分支/编译污染，客户端引用的是实时文件；请始终经由安装脚本生成 ~/.zcode 下的稳定快照副本。"
  },
  {
    "faq_id": "FAQ 5",
    "question": "为什么首轮流注入提示 '未注册会话 (Unregistered)'",
    "answer": "这是预期行为：新会话尚未登记进项目状态机。需要在项目中作为治理中枢时，在会话内触发 task-loop 的 init 技能 (/init) 完成登记，之后注入将变为完整的角色定位与专题规则。"
  }
]
```

---

## [Version & Roadmap] 版本与演进记录

```json
[
  {
    "version": "1.2.0-zcode",
    "created_at": "2026-08-27",
    "updated_at": "2026-08-27",
    "status": "ZCode Native Adapter Branch",
    "highlights": [
      "新增 .zcode-plugin/plugin.json 插件清单与 hooks/hooks.json 七事件钩子管道 (SessionStart/UserPromptSubmit 瞬态注入 + PreToolUse 白名单硬门禁)",
      "Hook 协议适配层 scripts/hooks/*_zcode.js|.py 完整复用共享核心, 兼容 Claude Code 双命名 stdin 协议",
      "会话反向内省 Provider get_zcode_project_sessions.js/.py 双通道 (db.sqlite 只读读库 + rollout JSONL 行扫描)",
      "一键安装器 scripts/install_zcode_plugin.js/.py 快照安装至 ~/.zcode/plugin-workspace 并生成本地市场清单",
      "深度契约文档 references/sdk/zcode.md (六原语映射 + AGY->ZCode 差异适配矩阵)",
      "Node.js 与 Python 全量测试套件 Exit Code 0"
    ],
    "install_entry": "详见 [ZCode Install Guide] 章节"
  },
  {
    "version": "1.2.0-plugin",
    "created_at": "2026-08-25",
    "updated_at": "2026-08-25",
    "status": "Antigravity Plugin Architecture",
    "highlights": [
      "升级为 Antigravity Plugin 插件包体系 (plugin.json, hooks.json, rules/)",
      "新增 PreInvocation 零开销会话元数据自动感知注入 Hook (inject_session_context)",
      "新增 PreToolUse Allowlist 物理修改边界硬门禁拦截 Hook (enforce_allowlist)",
      "支持 Antigravity、Codex、Claude Code 三大厂商会话反向内省与统一抽象",
      "全量调度与 Hooks 脚本支持 Node.js (主力) 与 Python 3.8+ (备案) 双运行时",
      "1/2/3 复杂度分级调度与自动化派单包生成",
      "持久化状态机与渐进式披露参考注册表",
      "新增子代理专题 (subagent) 与钩子专题 (hook) 独立闭环"
    ],
    "pre_commit_checklist": [
      "TODO 1: 零污染 Hook 治理落地：通过 PreInvocation Hook 按专题自动注入专属提示词与治理规则，彻底消除对用户项目 AGENTS.md 的侵入与污染",
      "TODO 2: 官方规范严格对照：对 AGY 官方文档 / SDK 文档与本地所有引用文档（原语签名、参数类型、生命周期与错误行为）进行全面严格核对与走查，彻底杜绝幻觉与语义偏差"
    ]
  }
]
```

---

## [License] License
MIT License.
