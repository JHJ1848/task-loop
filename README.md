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
- **零外部依赖（Zero pip dependencies）**：底层调度脚本全基于 Python 3.8+ 标准库与原子租约锁设计，具备高跨平台兼容性（Windows / macOS / Linux）。

---

## [Structure] 项目结构

```text
task-loop/
├── SKILL.md                 # Agent 核心 Skill 说明与规范
├── VERSION.md               # 版本记录
├── assets/                  # 架构图与静态资源
│   └── architecture.png
├── config/                  # 用户配置与偏好定义
│   └── user_preferences.json
├── references/              # 契约与 Schema 规范
│   ├── dispatch-contract.md # 派单与初始化契约
│   └── work-item-schema.md  # 任务与会话状态字段规范
├── scripts/                 # 跨平台调度与扫描脚本集 (Python / PowerShell)
│   ├── find_project_sessions.py
│   ├── acquire_task_loop_lease.py
│   ├── release_task_loop_lease.py
│   ├── new_task_loop_dispatch_packet.py
│   ├── reconcile_task_loop_topics.py
│   ├── initialize_task_loop_state.py
│   ├── get_task_loop_statistics.py
│   ├── invoke_task_loop_tick.py
│   ├── test_task_loop_preflight.py
│   ├── test_task_loop_topic_registry.py
│   └── providers/           # 各 Agent 厂商适配 Provider
│       ├── get_agy_project_sessions.py
│       ├── get_codex_project_sessions.py
│       └── get_claude_project_sessions.py
└── tests/                   # 自动化测试与用例
```

---

## [Quick Start] 快速上手

### 1. 环境准备
确保已安装 Python 3.8+（无需任何 `pip install`）。

### 2. 初始化项目任务拓扑
在目标项目根目录下执行：
```bash
python scripts/find_project_sessions.py --root . --inspect
```

### 3. 作为 Agent Skill 使用
在 Antigravity / Codex / Claude Code 中加载本项目目录或将其作为 Skill 引入后，通过 `/task-loop` 指令触发调度流转。

---

## [License] License
MIT License.
