---
name: task-loop
description: "[task-loop] Universal cross-agent task loop for Antigravity, Codex, and Claude Code. Main thread orchestrates requirements, manages 1/2/3 complexity tiering, scans and tags multi-vendor project sessions, and auto-provisions topic threads."
---

# Universal Task Loop

通用跨 Agent 任务循环调度器，全面支持 **Antigravity (AGY)**、**Codex** 和 **Claude Code**。

![架构设计与落地方案](assets/architecture.png)

---

## 一、[Environment] 双环境依赖（Node.js 主推荐 + Python 备案支持）

为满足全栈与不同开发者的环境诉求，本项目提供**零外部依赖的双运行时脚本支持**（推荐优先使用 Node.js，Python 纯标准库脚本作为无缝备案与降级）：

### 1. 运行环境要求
* **Node.js（推荐主要运行时）**: `Node.js 18+`（基于纯 Node.js 内置标准库，**零外部 npm 依赖**）。
* **Python（双环境备份运行时）**: `Python 3.8+`（基于纯 Python 标准库，**零外部 pip 依赖**）。

### 2. 各操作系统一键安装命令

#### [macOS] macOS (Homebrew)
```bash
brew install node python
```

#### [Linux] Linux (Ubuntu / Debian / CentOS / RHEL / Arch)
```bash
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y nodejs python3
# CentOS / RHEL / Fedora
sudo dnf install -y nodejs python3 || sudo yum install -y nodejs python3
# Arch Linux
sudo pacman -S --noconfirm nodejs python
```

#### [Windows] Windows (winget / scoop / choco)
```bash
winget install OpenJS.NodeJS.LTS Python.Python.3.12 || scoop install nodejs python || choco install nodejs python -y
```

---

## 二、[Authorization & Workflow] 主会话编排模式与子会话一致性工作流

当进入一个新项目或首次在该项目中使用 `task-loop` 时，Agent 必须检查项目根目录的 `AGENTS.md`（或 `AGENTS.MD`）：
1. **工作流程确立核验**：检查 `AGENTS.md` 中是否已将 `task-loop` 声明为固定开发工作流框架；
2. **主会话默认直接交互模式（Default）**：
   * 默认关闭基于 JSON 文件的严格状态机（`enable_file_state_machine: false`），主会话直接与用户进行自然语言交互，完成需求初加工、任务编排、评估专题匹配度，**明确声明任务类型（只读探索 `explore` 或修改落地 `work`）**，并直接通过 SDK 下发任务，消除状态文件读写延迟与锁冲突；
   * 可选开启严格文件状态机（`enable_file_state_machine: true`）进行全量队列与租约持久化。
3. **子会话前后一致的标准执行流 (Sub-Session Workflow Parity)**：
   * 无论主会话采用何种模式，**子会话（Subagent / Topic Session）的执行工作流 100% 保持前后一致**：
     `1. 承接任务并锁定 Allowlist 白名单 -> 2. 边界内精准实施 (零表格/零Emoji/原生工具) -> 3. 本地自测与门禁走查 -> 4. 沉淀事实至 docs/memory/*.md -> 5. 结构化汇总交付`。
4. **部署与提交前置检查清单 (Pre-Commit & Deployment Checklist)**：
   * **Check 1（零污染 Hook 治理落地）**：通过 PreInvocation Hook 按专题自动注入专属提示词与治理规则，彻底消除对用户项目 `AGENTS.md` 的修改与侵入；
   * **Check 2（官方规范严格对照走查）**：在最终提交前，对 AGY 官方文档 / SDK 规范与本地所有引用文档（原语签名、参数类型、生命周期与错误行为）进行全面严格核对，杜绝幻觉与语义偏差。

---

## 三、[Plugin Architecture & Topic Organization] Plugin 格式规范与专题独立会话/Skill 组织架构

根据 Antigravity 官方 Plugin 规范（https://antigravity.google/docs/plugins/），`task-loop` 支持被打包和部署为标准 Plugin 体系。当复杂项目按领域边界拆分为各个专题时，各专题模块拥有独立的工作空间、会话绑定、专属 Skill 目录与受控记忆：

### 1. Plugin 标准目录拓扑与资源组织
```text
plugins/task-loop/
├── plugin.json                 # 必需：Plugin 声明清单 (Manifest)
├── mcp_config.json             # 可选：Plugin 暴露的 MCP 服务器配置
├── hooks.json                  # 可选：生命周期 Hooks 拦截器
├── rules/                      # 可选：Plugin 激活时自动合并生效的规则
│   └── AGENTS.md               # 任务循环治理与子会话标准工作流
├── sidecars/                   # 可选：常驻后台守护与定时调度进程
│   └── task-loop-scheduler/
│       └── sidecar.json
└── skills/                     # 可选：按专题拆分的独立 Skill 集合
    ├── task-loop/              # 核心任务循环总控 Skill
    │   └── SKILL.md
    ├── subagent/               # 子代理专题独立 Skill
    │   └── SKILL.md
    └── session-control/        # 会话感知与控制专题独立 Skill
        └── SKILL.md
```

### 2. 专题独立会话与 Skill 目录映射矩阵
```json
[
  {
    "topic_key": "subagent",
    "topic_title": "[子代理专题] Subagent机制 & 动态模板",
    "skill_dir": "skills/subagent/SKILL.md (或 plugins/task-loop/skills/subagent/SKILL.md)",
    "memory_doc": "docs/memory/subagent.md",
    "core_responsibility": "维护 AGY 原生子代理原语、动态模板声明、Python SDK 编排与生命周期测试"
  },
  {
    "topic_key": "session_control",
    "topic_title": "[会话专题] SDK接口封装 & 会话管理",
    "skill_dir": "skills/session-control/SKILL.md (或 plugins/task-loop/skills/session-control/SKILL.md)",
    "memory_doc": "docs/memory/session_control.md",
    "core_responsibility": "跨厂商会话感知、反向内省、agentapi CLI 联动与会话生命周期状态机"
  }
]
```

---

## 四、[New Project Bootstrap] 新项目接入指南：目标项目 AGENTS.md 最小配置指导

### 1. 冷启动背景与痛点
当 Agent 进入一个全新的外部项目时，目标工程往往**仅存在根目录的 `AGENTS.md`，尚未在全局或工作区安装 `task-loop` Plugin**。为了确保 Agent 在零插件预装的环境下也能自包含、无冲突地执行 `task-loop` 工作流，Agent 必须引导用户在目标工程的 `AGENTS.md` 中嵌入以下标准化指导配置。

### 2. 目标项目 `AGENTS.md` 标准配置调整模板

```markdown
# [AGENTS.md] 项目智能体治理与研发工作流规范

## 一、核心开发工作流框架 (Primary Development Workflow: task-loop)
本项目将 `task-loop` (Universal Cross-Agent Task Loop) 作为日常维护与功能演进的主要工作流框架。

### 1. 主会话与专题会话治理 (Main & Topic Sessions)
* **主会话识别源**：统一读取 `.agents/task-loop/sessions.json` 中的 `main_thread_id`，严禁在文档中硬编码具体 UUID。
* **主会话中枢职责**：
  - 负责接收用户需求，进行自然语言初加工与伪需求裁剪；
  - 明确声明任务类型：只读探索 `explore` 还是修改落地 `work`；
  - 划定物理文件修改白名单（Allowlist）与 1/2/3 复杂度等级；
  - 评估专题匹配度，优先通过 `send_message` / `invoke_subagent` / `agentapi` 定向派发。
* **专题子会话一致性工作流 (Workflow Parity)**：
  - 无论处于何种派发模式，所有专题会话与子代理必须严格遵守五步闭环：
    `1. 任务承接与白名单锁定 -> 2. 白名单内精准实施 (零表格/零Emoji/统一UTF-8) -> 3. 本地全量自测 (Exit Code 0) -> 4. 专题记忆沉淀 docs/memory/<topic_key>.md -> 5. 结构化交付汇报`。

### 2. Plugin 缺失时的降级回退策略 (Self-Contained Fallback)
* **未安装 Plugin 环境**：
  - Agent 优先使用纯 Node.js 18+ 原生模块（或 Python 3.8+ 标准库）直接执行工作区 `.agents/task-loop/` 或本地 `scripts/` 下的调度脚本；
  - 严禁引入任何外部 npm/pip 第三方依赖，确保工作流在目标项目中零门槛开箱即用。
* **推荐安装 Plugin**：
  - 推荐将 task-loop 部署至工作区 `.agents/plugins/task-loop/` 或用户全局 `~/.gemini/config/plugins/task-loop/`，以自动激活多专题独立 Skills 集合与系统级 Sidecars 调度能力。
```

---

## 五、[Main Session Resolution] 主会话判定、强制交互与初始化选择机制

当主会话 ID（`main_thread_id`）在 `.agents/task-loop/sessions.json` 中不存在、为 `null` 或无法识别时，**强制触发以下交互与初始化流转**：

```mermaid
flowchart TD
    Start[检测到 sessions.json 中 main_thread_id 缺失/为 null] --> Step1[步骤 1: 强制询问用户是否执行项目会话初始化扫描]
    Step1 -->|用户确认| Step2[步骤 2: 运行初始化扫描脚本 提取所有 AGY 会话基础信息]
    Step2 --> Step3[步骤 3: 提取并生成规范化命名: [具体专题] 功能点1 & 功能点2]
    Step3 --> Step4[步骤 4: 强制调用 ask_question 引导用户选择哪个会话作为主会话]
    Step4 --> Step5[步骤 5: 将选择的 main_thread_id 与全量会话信息持久化写入 sessions.json]
```

1. **步骤 1（强制询问初始化）**：调用 `ask_question` 或确认提示，询问用户是否开始扫描当前项目的存量会话。
2. **步骤 2（全量扫描与内省）**：执行初始化脚本 `python scripts/initialize_task_loop_state.py --root .agents/task-loop`，通过 AGY Provider 扫描当前项目关联的所有会话。
3. **步骤 3（标准化命名生成）**：为每个识别出的会话生成标准命名格式：`[具体专题] 功能点1 & 功能点2`（例如 `[主会话] 任务编排 & 治理中枢`、`[会话专题] SDK接口封装 & 会话管理`）。
4. **步骤 4（强制用户交互选择）**：调用 `ask_question` 渲染交互式单选列表，由用户显式选择当前会话或指定会话作为主会话（Main Session）。
5. **步骤 5（持久化登记）**：将用户选定的 `main_thread_id` 及全部会话的基础信息完整写入 `.agents/task-loop/sessions.json`。

---

## 六、[State Persistence] `sessions.json` 结构化全量持久化规范

为避免状态信息仅“软记录”在私有 `AGENTS.md` 中，项目的所有会话基础信息必须在 `.agents/task-loop/sessions.json` 中进行严格的机器可读持久化：

```json
{
  "schema_version": 1,
  "main_thread_id": "<main_session_uuid>",
  "sessions": [
    {
      "session_id": "<main_session_uuid>",
      "vendor": "antigravity",
      "title": "[主会话] 任务编排 & 治理中枢",
      "is_main": true,
      "created_at": "2026-08-21T08:54:04Z",
      "last_active_at": "2026-08-25T01:43:46Z",
      "log_path": "path/to/transcript.jsonl",
      "recent_prompts": ["..."]
    },
    {
      "session_id": "<sub_session_uuid>",
      "vendor": "antigravity",
      "title": "[专题会话] 具体模块研发与治理",
      "is_main": false,
      "created_at": "2026-08-25T01:41:05Z",
      "last_active_at": "2026-08-25T01:43:39Z",
      "log_path": "path/to/transcript.jsonl",
      "recent_prompts": ["..."]
    }
  ],
  "modules": {}
}
```

---

## 七、[Hard Rules & Vendors] 跨平台约束与厂商适配范围

1. **当前实现范围**：当前阶段核心深度聚焦 **Google Antigravity (AGY)** 原生环境（包括 `invoke_subagent`、`manage_subagents`、`transcript.jsonl` 日志扫描与 Reactive Wakeup 响应式唤醒）；
2. **预留厂商插槽**：对 **OpenAI Codex** 与 **Anthropic Claude Code** 预留标准化 Provider 接口插槽（`get_codex_project_sessions.py`、`get_claude_project_sessions.py`）与配置扩展规范。
3. **大小写敏感性**：所有模块路径与 `module_key` 严格遵循 Linux 规范（区分大小写）。
4. **强制标准 UTF-8 编码**：所有脚本显式配置 `sys.stdout.reconfigure(encoding='utf-8')`。
5. **杜绝绝对路径硬编码**：统一解析为相对于 `$HOME` 或 `$ProjectRoot` 的规范化路径。
6. **项目持久化文档严禁使用 Markdown 表格（禁止泛化至聊天回复）**：严禁在本项目仓库内的持久化 `.md` 文档中使用 Markdown 表格语法（`| col1 | col2 |`），所有多维数据、配置映射、脚本列表一律使用标准 `json` 代码块；此约束仅且严格作用于项目内部持久化文件编辑，严禁限制 AI 与人类交互时的自然语言回复格式。

---

## 八、[Complexity 1/2/3] 复杂度裁决与派发规则（JSON 规范）

```json
[
  {
    "complexity": 1,
    "tier_name": "Level 1 (Simple)",
    "characteristics": "单点 Bugfix、单文件/文本/配置微调、只读排查、快速查询",
    "subagent_policy": "none",
    "execution_rule": "极速直发：直接派发到专题会话单线程执行，无需复杂 Q&A，快速验证闭环。"
  },
  {
    "complexity": 2,
    "tier_name": "Level 2 (Standard)",
    "characteristics": "模块内标准功能开发、多文件协作改动、标准重构与自测",
    "subagent_policy": "optional",
    "execution_rule": "标准派发：专题在边界（Allowlist）内执行标准开发、单元测试与所属记忆回写。"
  },
  {
    "complexity": 3,
    "tier_name": "Level 3 (Complex)",
    "characteristics": "跨模块架构变动、大型新功能开发、深度疑难故障排查（耗时 >3 分钟）",
    "subagent_policy": "mandatory",
    "execution_rule": "强制 Subagent 编排：专题会话作为二级调度中枢，必须调用 invoke_subagent 拆分 Research / Worker / Reviewer 子代理并行处理。"
  }
]
```

---

## 九、[Core Scripts] 核心脚本清单（Node.js 主力 + Python 备案双环境 JSON 配置）

所有脚本均保持**零外部依赖**（纯 Node.js 标准库 / 纯 Python 标准库），可在任意环境下直接执行：

```json
[
  {
    "function": "会话扫描与内省",
    "node_cmd": "node scripts/find_project_sessions.js --root . --inspect",
    "python_cmd": "python scripts/find_project_sessions.py --root . --inspect"
  },
  {
    "function": "会话聚合与 Markdown/JSON 摘要",
    "node_cmd": "node scripts/summarize_project_sessions.js --root .",
    "python_cmd": "python scripts/summarize_project_sessions.py --root ."
  },
  {
    "function": "AGY 会话感知 Provider",
    "node_cmd": "node scripts/providers/get_agy_project_sessions.js . --inspect",
    "python_cmd": "python scripts/providers/get_agy_project_sessions.py . --inspect"
  },
  {
    "function": "Codex 会话感知 Provider",
    "node_cmd": "node scripts/providers/get_codex_project_sessions.js .",
    "python_cmd": "python scripts/providers/get_codex_project_sessions.py ."
  },
  {
    "function": "Claude 会话感知 Provider",
    "node_cmd": "node scripts/providers/get_claude_project_sessions.js . --inspect",
    "python_cmd": "python scripts/providers/get_claude_project_sessions.py . --inspect"
  },
  {
    "function": "运行态初始化与主会话管理",
    "node_cmd": "node scripts/initialize_task_loop_state.js --root .agents/task-loop",
    "python_cmd": "python scripts/initialize_task_loop_state.py --root .agents/task-loop"
  },
  {
    "function": "专题自动对齐与注册",
    "node_cmd": "node scripts/reconcile_task_loop_topics.js --root . --manifest <topics.json> --registry <sessions.json>",
    "python_cmd": "python scripts/reconcile_task_loop_topics.py --root . --manifest <topics.json> --registry <sessions.json>"
  },
  {
    "function": "1/2/3 复杂度派单包生成",
    "node_cmd": "node scripts/new_task_loop_dispatch_packet.js --root . --run-id <UUID> --target-thread-id <ID>",
    "python_cmd": "python scripts/new_task_loop_dispatch_packet.py --root . --run-id <UUID> --target-thread-id <ID>"
  },
  {
    "function": "门禁预检（复杂度感知）",
    "node_cmd": "node scripts/test_task_loop_preflight.js --root .",
    "python_cmd": "python scripts/test_task_loop_preflight.py --root ."
  },
  {
    "function": "原子租约锁获取与释放",
    "node_cmd": "node scripts/acquire_task_loop_lease.js ... / release",
    "python_cmd": "python scripts/acquire_task_loop_lease.py ... / release"
  },
  {
    "function": "状态统计与调度 Tick",
    "node_cmd": "node scripts/invoke_task_loop_tick.js --root .",
    "python_cmd": "python scripts/invoke_task_loop_tick.py --root ."
  },
  {
    "function": "PreInvocation 会话上下文瞬态注入",
    "node_cmd": "node scripts/hooks/inject_session_context.js",
    "python_cmd": "python scripts/hooks/inject_session_context.py"
  },
  {
    "function": "PreToolUse Allowlist 物理白名单门禁拦截",
    "node_cmd": "node scripts/hooks/enforce_allowlist.js",
    "python_cmd": "python scripts/hooks/enforce_allowlist.py"
  },
  {
    "function": "PreToolUse 专题会话自动解析与懒加载拉起",
    "node_cmd": "node scripts/hooks/resolve_or_create_session.js",
    "python_cmd": "python scripts/hooks/resolve_or_create_session.py"
  }
]
```

---

## 十、[Topic & Plugin Architecture] 专题拆分与 Plugin 格式升级规范

遵循 Google Antigravity 官方 Plugin 规范 (`https://antigravity.google/docs/plugins/`)，当工程规模扩大并将能力拆分为各个独立专题时，本工作流全面支持升级并打包为标准 Plugin 格式：

### 1. 标准 Plugin 目录组织结构
```text
plugins/<plugin_name>/
├── plugin.json       # 必须: 插件清单声明 (Manifest)
├── mcp_config.json   # 可选: 插件声明暴露的 MCP 服务
├── hooks.json        # 可选: 声明周期的 PreInvocation/PreToolUse 钩子配置
├── rules/            # 可选: 插件激活时生效的规则 (推荐 rules/AGENTS.md)
│   └── AGENTS.md
└── skills/           # 可选: 插件向宿主暴露的 Skill 集合
    ├── <topic_skill_1>/
    │   └── SKILL.md
    └── <topic_skill_2>/
        └── SKILL.md
```

### 2. 专题与会话/Skill/记忆三位一体映射规范 (Topic Mapping JSON)
```json
[
  {
    "topic_key": "main",
    "session_role": "主会话 / 调度中枢",
    "skill_dir": "skills/task-loop/",
    "memory_doc": "docs/MEMORY.md",
    "scope": "需求初加工、任务编排、专题匹配评估与最终门禁质检"
  },
  {
    "topic_key": "session_control",
    "session_role": "会话控制专题负责人",
    "skill_dir": "skills/session-control/",
    "memory_doc": "docs/memory/session_control.md",
    "scope": "跨厂商会话感知、反向内省、生命周期管理与 Provider 适配"
  },
  {
    "topic_key": "subagent",
    "session_role": "子代理专题负责人",
    "skill_dir": "skills/subagent/",
    "memory_doc": "docs/memory/subagent.md",
    "scope": "原生子代理编排、SubagentConfig 规范与隔离沙箱开发"
  },
  {
    "topic_key": "hook",
    "session_role": "钩子专题负责人",
    "skill_dir": "skills/hook/",
    "memory_doc": "docs/memory/hook.md",
    "scope": "Antigravity Hooks 体系、会话上下文自动感知注入与 Allowlist 拦截门禁"
  }
]
```

---

## 十一、[AGENTS.md Adoption Guide for New Projects] 新工程接入与 AGENTS.md 调整指引

当在一个全新项目中引入 `task-loop` 时，新项目通常仅有根目录的 `AGENTS.md`（或 `AGENTS.MD`），尚未安装或部署当前 Plugin。为确保任何 AI Agent 进入新工程后均能无缝承接并执行 `task-loop` 工作流，新工程的 `AGENTS.md` 必须按照以下指导规范进行配置和调整：

### 1. 新工程 AGENTS.md 必须包含的五大核心要素
1. **工作流框架授权声明**：显式声明以 `task-loop` 作为日常维护与持续演进的主工作流；
2. **主会话识别与模式策略**：明确主会话由 `.agents/task-loop/sessions.json` 动态持久化，默认采用轻量直接交互模式（`enable_file_state_machine: false`）；
3. **子会话一致性工作流契约 (Parity)**：明确子会话/专题会话执行标准的五阶段（任务承接 -> Allowlist 内手术式实施 -> 单元自测与门禁 -> 沉淀记忆至 docs/memory/*.md -> 结构化汇报）；
4. **硬性工程约束**：强制 UTF-8 编码、零 Emoji、项目内持久化 `.md` 文档严禁使用 Markdown 表格（强制 JSON 代码块）、禁止 Agent 自动执行 `git` 提交命令；
5. **渐进式受控记忆索引**：与 `docs/MEMORY.md` 建立双向索引，按需加载深度契约。

### 2. 新工程 AGENTS.md 推荐集成模板 (Markdown Template)
```markdown
# [AGENTS.md] 项目智能体治理与研发工作流规范

## 一、主会话与工作流框架
* **工作流框架**: 本项目采用 `task-loop` (Universal Cross-Agent Task Loop) 作为核心研发与治理工作流。
* **主会话注册源**: `.agents/task-loop/sessions.json` (由 `main_thread_id` 动态记录)。
* **主会话模式**: 默认轻量直接交互模式 (`enable_file_state_machine: false`)，由主会话进行自然语言需求初加工、任务编排，并通过 SDK 直接向对应专题会话派单。

## 二、子会话前后一致的标准执行流
所有子会话与专题会话必须严格执行统一的五阶段执行闭环：
1. 任务承接与边界锁定 (解析单一职责目标、Allowlist 物理白名单与复杂度)；
2. 白名单内精准实施 (严格限制在 Allowlist 范围内，零表格、零Emoji、原生文件编辑工具)；
3. 本地自测与门禁核验 (单元测试 Exit Code 0，无越界改动)；
4. 专题记忆沉淀 (回写已证实事实至 docs/memory/<topic>.md)；
5. 标准化结构交付 (汇报 Summary, Changes, Evidence)。

## 三、硬性代码与工程约束
* 强制 UTF-8 编码，严禁将文本转为 GBK。
* 严禁 Agent 自动执行 git add / git commit 等版本库修改命令。
* 仅限仓库内部持久化 Markdown 文档：严禁使用 Markdown 表格语法（| col1 | col2 |），多维数据与配置强制采用标准 json 代码块。
* 优先使用 Node.js 18+ 原生脚本执行，Python 3.8+ 纯标准库作为备选。
```

---

## 十二、[Progressive References] 参考文档索引 (Progressive References)

本项目所有深度契约遵循渐进式披露原则，按需触发读取：

```json
[
  {
    "name": "跨厂商会话 SDK 体系规范",
    "path": "references/sdk/README.md",
    "sub_docs": [
      "references/sdk/agy.md",
      "references/sdk/codex.md",
      "references/sdk/claude.md"
    ]
  },
  {
    "name": "钩子专题受控记忆",
    "path": "docs/memory/hook.md"
  },
  {
    "name": "会话控制专题受控记忆",
    "path": "docs/memory/session_control.md"
  },
  {
    "name": "子代理专题受控记忆",
    "path": "docs/memory/subagent.md"
  },
  {
    "name": "专题会话默认兜底工作流规范",
    "path": "references/default-fallback-workflow.md"
  },
  {
    "name": "派单与初始化契约",
    "path": "references/dispatch-contract.md"
  },
  {
    "name": "状态格式与字段规范",
    "path": "references/work-item-schema.md"
  },
  {
    "name": "用户全局偏好配置与参数手册",
    "path": "config/user_preferences.json",
    "manual_path": "config/README.md"
  },
  {
    "name": "项目说明与版本演进",
    "path": "README.md"
  },
  {
    "name": "架构图与静态资产",
    "path": "assets/architecture.png"
  }
]
```
