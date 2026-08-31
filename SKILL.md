---
name: task-loop
description: "[task-loop] Universal cross-agent task loop plugin for Antigravity, ZCode, Codex, and Claude Code. Features modular skill matrix (6 independent skills), lifecycle hooks, surgical Allowlist gates, and multi-vendor session introspection."
---

# Universal Cross-Agent Task Loop Plugin (`task-loop`)

> **架构升级提示 (v1.3.0 Architecture)**：`task-loop` 已由原单一巨型 Skill 正式升级重构为**标准跨平台插件系统 (Plugin Architecture)**。本文件作为兼容历史旧版本的快速接入索引与使用介绍。

---

## 一、模块化专属技能矩阵 (Modular Skills Matrix)

本项目核心功能已解耦拆分为 6 大独立专属 Skill，可按需精准调用：

```json
[
  {
    "skill_name": "task-loop",
    "command": "/task-loop",
    "doc_path": "skills/task-loop/SKILL.md",
    "core_responsibility": "跨智能体任务循环总控中枢：负责自然语言需求初加工、1/2/3 复杂度裁决、物理白名单 (Allowlist) 划定与任务派单。"
  },
  {
    "skill_name": "session-control",
    "command": "/session-control",
    "doc_path": "skills/session-control/SKILL.md",
    "core_responsibility": "跨厂商会话感知与控制：支持 Antigravity (JSONL)、ZCode (SQLite/Rollout)、Codex (Rollout) 与 Claude Code 历史会话反向内省与生命周期状态机持久化。"
  },
  {
    "skill_name": "subagent",
    "command": "/subagent",
    "doc_path": "skills/subagent/SKILL.md",
    "core_responsibility": "子代理治理与动态模板：封装原生 invoke_subagent、define_subagent 与 manage_subagents 工具，支持临时隔离沙箱与多代理协同。"
  },
  {
    "skill_name": "hook",
    "command": "/hook",
    "doc_path": "skills/hook/SKILL.md",
    "core_responsibility": "生命周期钩子管道与安全门禁：PreInvocation 瞬态上下文感知注入（零文件污染），PreToolUse 手术式 Allowlist 物理白名单硬拦截。"
  },
  {
    "skill_name": "init",
    "command": "/init",
    "doc_path": "skills/init/SKILL.md",
    "core_responsibility": "项目初始化与会话调查：自动扫描全平台历史会话并与 docs/memory/*.md 受控记忆实现 1:1 自动映射，支持交互式主会话选定与自动补齐。"
  },
  {
    "skill_name": "new-session",
    "command": "/new-session",
    "doc_path": "skills/new-session/SKILL.md",
    "core_responsibility": "专题会话主动创建与自动补齐：支持只读调查对齐状态、为指定记忆文档拉起专属会话，或新建全新业务专题与独立顶层根会话 (nestingDepth: 0)。"
  }
]
```

---

## 二、双环境零依赖执行规范 (Dual-Runtime Engine)

所有工具脚本均采用**零外部第三方依赖**构建（纯 Node.js 标准库 / 纯 Python 3.8+ 标准库），支持在任意宿主环境中开箱即用：

```json
[
  {
    "task": "项目初始化与会话调查",
    "node_command": "node scripts/init_task_loop.js",
    "python_command": "python scripts/init_task_loop.py"
  },
  {
    "task": "专题会话创建与受控记忆对齐",
    "node_command": "node scripts/new_topic_session.js",
    "python_command": "python scripts/new_topic_session.py"
  },
  {
    "task": "全平台会话反向内省扫描",
    "node_command": "node scripts/find_project_sessions.js --root . --inspect",
    "python_command": "python scripts/find_project_sessions.py --root . --inspect"
  },
  {
    "task": "ZCode 插件本地一键安装与部署",
    "node_command": "node scripts/install_zcode_plugin.js --enable",
    "python_command": "python scripts/install_zcode_plugin.py --enable"
  }
]
```

---

## 三、主会话与子会话标准工作流契约 (Standard Workflow)

1. **主会话 (Main Session)**：负责需求初加工、明确任务类型（只读探索 `explore` vs 修改落地 `work`）、划定物理白名单 `allowlist`，通过 SDK 或派单包定向派发至专题会话；
2. **子会话 (Topic / Subagent)**：严格执行五步闭环（`1. 边界锁定 -> 2. 白名单内手术式实施 -> 3. 本地自测与门禁核验 -> 4. 专题记忆沉淀 docs/memory/*.md -> 5. 标准化结构交付`）。

---

## 四、渐进式参考手册索引 (Progressive Disclosure)

- 插件清单元数据：[`plugin.json`](plugin.json)
- ZCode 适配规范：[`references/sdk/zcode.md`](references/sdk/zcode.md)
- 会话 SDK 规范：[`references/sdk/README.md`](references/sdk/README.md)
- 派单契约与门禁：[`references/dispatch-contract.md`](references/dispatch-contract.md)
- 核心受控记忆：[`docs/MEMORY.md`](docs/MEMORY.md)
