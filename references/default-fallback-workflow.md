# [Reference] 专题会话默认兜底工作流规范 (Default Fallback Workflow)

本文档定义了 `task-loop` 各专题会话在**无第三方工作流插件**（如 `jiaohuan-dev` 等）环境下的原生默认执行工作流，确保在纯净、零依赖环境下保持极简、高效、安全的代码实施闭环。

---

## 一、双分支执行决策矩阵 (Decision Matrix)

当任务到达专题会话后，专题负责人依据任务特征进行快速二元分流：

```text
┌────────────────────────────────────────────────────────┐
│                   专题会话任务接入                     │
└──────────────────────────┬─────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
    【分支 A: 简单明确】        【分支 B: 复杂未知】
    (Simple & Clear)            (Complex & Unknown)
             │                           │
             ▼                           ▼
    直接改动并自测验证         启动 explore + worker + viewer
    (最纯洁极速的工作方式)       三角色子代理闭环协作
```

```json
[
  {
    "branch": "分支 A: 简单明确 (Simple & Clear)",
    "condition": "目标清晰单一、修改点明确、单文件/配置微调、单点 Bugfix",
    "workflow": "直接就地改动：在 Allowlist 白名单内单线程直接修改代码，运行本地单元测试 (Exit Code 0)，直接交付闭环，严禁形式主义派生子代理。"
  },
  {
    "branch": "分支 B: 复杂未知 (Complex & Unknown)",
    "condition": "跨多文件协作、架构逻辑未明、深层报错根因未知、影响范围不确定",
    "workflow": "三角色协作流：依次调度 explore (探测) -> worker (实施) -> viewer (审查) 子代理协同推进。"
  }
]
```

---

## 二、三角色子代理协作流 (Explore + Worker + Viewer)

针对分支 B（复杂未知），专题会话作为二级调度中枢，按固定流转链路推进：

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                   三角色子代理标准协作流水线                             │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│ 1. [explore 探测] 检查当前项目现状与根因                                 │
│         │                                                                │
│         ▼                                                                │
│ 2. [专题会话统筹] 评估现状并规划实施方案                                 │
│         │                                                                │
│         ▼                                                                │
│ 3. [worker 实施] 依据现状实施代码修改与本地单测                           │
│         │                                                                │
│         ├─► (中途异常中断机制: 发现意外/额外逻辑 -> 立即停止并反馈专题会话)│
│         │                                                                │
│         ▼                                                                │
│ 4. [viewer 审查] 对修改结果与测试证据进行独立客观评判                    │
│         │                                                                │
│         ▼                                                                │
│ 5. [专题会话判定] 评估审查结果:                                          │
│         ├─► 评判通过: 交付闭环                                           │
│         └─► 评判未通过 (短路迭代): 直接通知 worker 针对性改动 (不重新explore)
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1. 角色职责与并发约束 (Roles & Quantity Constraint)
各角色可根据任务规模派发任意数量，但**各类型建议不超过 3 个**，防止子代理过度膨胀与上下文浪费：

```json
[
  {
    "role_name": "explore",
    "recommended_limit": "建议不超过 3 个",
    "role_type": "只读探测 (Read-Only Explorer)",
    "recommended_model": "flash (或 inherit)",
    "responsibility": "针对未知疑难进行广度/深度排查、调用链内省与现状梳理，向专题会话回传客观现状报告。"
  },
  {
    "role_name": "worker",
    "recommended_limit": "建议不超过 3 个",
    "role_type": "编码实施 (Implementer)",
    "recommended_model": "inherit (或 flash)",
    "responsibility": "根据 explore 查明的现状与专题规划，在 Allowlist 内精准实施代码修改并自测通过。"
  },
  {
    "role_name": "viewer",
    "recommended_limit": "建议不超过 3 个",
    "role_type": "客观评判 (Reviewer)",
    "recommended_model": "pro (或 inherit)",
    "responsibility": "对 worker 提交的修改 Diff、单元测试日志与边界合规性进行客观审查与评分。"
  }
]
```

### 2. 短路重试机制 (Short-Circuit Iteration)
* **核心原则**：当 `viewer` 评判未通过或自测存在缺陷时，**专题会话直接将失败点派发给 `worker` 进行针对性修改**。
* **效率保证**：严禁在评审失败后重新走长链路退回 `explore`，避免重复的探索成本，确保开发流转极速收敛。

### 3. 中途异常中断与统筹机制 (Mid-Flight Escalation Guardrail)
* **核心原则**：`worker` 在实施过程中，一旦发现以下意外情况，**必须立即停止当前修改并向专题会话反馈**：
  1. 发现历史遗留冲突或未预期的隐藏业务逻辑；
  2. 发现修改会导致其他核心模块编译或测试连锁崩溃；
  3. 发现实际修改范围必须超出原定 `Allowlist` 物理白名单。
* **处理闭环**：专题会话接收到异常反馈后，重新进行全局统筹评估并明确新方案，再指派 `worker` 继续往下推进。

---

## 三、第三方插件插槽协同 (Third-Party Plugin Interoperability)

```json
[
  {
    "scenario": "未安装第三方插件 (默认纯净环境)",
    "action": "100% 严格执行本文档定义的【简单直接改动 / 复杂 explore + worker + viewer】原生兜底流程。"
  },
  {
    "scenario": "已安装第三方插件 (如 jiaohuan-dev)",
    "action": "可按需结合其 /project-memory, /debug, /dev 等方法论，但核心协作流与短路重试机制依然有效。"
  }
]
```

---

## 四、双向关联索引
* **受控记忆主纲要**: [`docs/MEMORY.md`](../docs/MEMORY.md)
* **子代理专题受控记忆**: [`docs/memory/subagent.md`](../docs/memory/subagent.md)
* **项目根规则**: [`AGENTS.md`](../AGENTS.md)
* **派单与治理契约**: [`references/dispatch-contract.md`](dispatch-contract.md)
