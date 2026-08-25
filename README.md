# Task Loop (`task-loop`)

通用跨 Agent 任务循环调度器（Universal Cross-Agent Task Loop），全面支持 **Antigravity (AGY)**、**Codex** 和 **Claude Code**。

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
├── hooks.json               # 插件钩子管道配置 (PreInvocation / PreToolUse)
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
│   │   └── claude.md        # Anthropic Claude Code SDK
│   ├── dispatch-contract.md # 派单与初始化契约
│   └── work-item-schema.md  # 任务与会话状态字段规范
├── scripts/                 # 跨平台调度与扫描脚本集 (Node.js / Python)
│   ├── hooks/               # 钩子处理脚本集 (PreInvocation / PreToolUse)
│   │   ├── inject_session_context.js / .py
│   │   └── enforce_allowlist.js / .py
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
│       └── get_claude_project_sessions.js / .py
└── tests/                   # 自动化测试与用例 (Node.js / Python)
```

---

## [Quick Start] 快速上手

### 1. 作为 Antigravity Plugin 插件使用 (推荐)
- **工作区级安装**：将本项目目录软链接或放置于工作区 `.agents/plugins/task-loop/`；
- **全局用户级安装**：放置于 `~/.gemini/config/plugins/task-loop/`；
- 系统自动加载 `plugin.json`、`hooks.json`、`rules/` 与 `SKILL.md`，实现零 Token 开销的会话感知与物理安全门禁。

### 2. 作为独立脚本库运行
```bash
# 推荐优先使用 Node.js 18+ (零 npm 依赖)
node scripts/find_project_sessions.js

# 或使用 Python 3.8+ 备用 (零 pip 依赖)
python scripts/find_project_sessions.py
```

### 3. 作为 Agent Skill 使用
在 Antigravity / Codex / Claude Code 中加载本项目目录或将其作为 Skill 引入后，通过 `/task-loop` 指令触发调度流转。

---

## [Version & Roadmap] 版本与演进记录

```json
[
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
