# [Subagent-Driven Development & Workflow Plugin Slot Guide]

本文档是 `task-loop` 中专题会话派遣子代理与扩展第三方工作流 Plugin 的标准核心指导文档。

---

## 一、子级 Skill 派遣指导方法论 (Subagent-Driven Development)

当专题会话（Topic Session）承接 Level 3 复杂度或包含多个独立子任务的实现计划时，遵循以下经过生产验证的多智能体委派方法论：

### 1. 核心铁律与流程 (Core Principles)
* **任务级独立子代理 (Fresh Subagent per Task)**：为计划中的每个独立任务派发全新的子代理（`invoke_subagent`），赋予其精确、自包含的任务说明与物理文件白名单（`Allowlist`），严禁无节制地将全量历史上下文粘贴给子代理。
* **双重验收门禁 (Dual Review Gate)**：每个子代理提交变更后，派发 Reviewer 进行双重核验：
  1. **Spec Compliance（规格依从性）**：严格比对任务目标与白名单，杜绝未要求的过度设计或遗漏；
  2. **Task Quality（代码质量）**：验证单元测试全绿 (Exit Code 0)、代码健壮性与无坏味道。
* **文件交接机制 (File Handoffs)**：
  - 任务说明书（Task Brief）与子代理执行汇报（Report）通过物理文件路径交互，避免海量日志长期滞留并挤占中枢上下文。
* **持久进度账本 (Durable Progress Ledger)**：
  - 进度记录持久化于本地文件（如 `.agents/task-loop/todo.json` 或 `docs/memory/*.md`），抵御上下文压缩（Compaction）带来的记忆丢失。

### 2. 子代理角色模型路由矩阵
```json
[
  {
    "role": "Implementer (Worker)",
    "nature": "机械实现、函数编写、单模块单测",
    "recommended_model": "inherit (或 flash)",
    "workspace_mode": "inherit (常规单体) 或 branch (破坏性沙箱)"
  },
  {
    "role": "Task Reviewer (Auditor)",
    "nature": "规格核验、代码审查、边界守卫",
    "recommended_model": "pro (或 inherit)",
    "workspace_mode": "inherit"
  },
  {
    "role": "Researcher (Explorer)",
    "nature": "代码库广度搜索、调用链检索、日志内省",
    "recommended_model": "flash",
    "workspace_mode": "inherit"
  }
]
```

---

## 二、简单任务纯洁直发模式 (Simple Direct Execution)

对于 Level 1 复杂度任务（单文件/配置微调、单点 Bugfix、快速检索）：
* **严禁滥用子代理**：禁止形式主义地为 1~2 行改动拉起多级子代理；
* **极速就地闭环**：当前专题会话直接调用原生文件编辑工具在 `Allowlist` 内修改，执行单测验证，直接交付。

---

## 三、开发与修复入口

专题及其实施子代理沿用派单指定的 [bugfix-dev](../skills/bugfix-dev/SKILL.md)，按已确认的目标、写入白名单和验收条件执行。

---

## 四、双向关联索引
* **受控记忆主纲要**: [`docs/MEMORY.md`](../docs/MEMORY.md)
* **子代理专题受控记忆**: [`docs/memory/subagent.md`](../docs/memory/subagent.md)
* **项目根规则**: [`AGENTS.md`](../AGENTS.md)
* **派单与治理契约**: [`references/dispatch-contract.md`](dispatch-contract.md)
