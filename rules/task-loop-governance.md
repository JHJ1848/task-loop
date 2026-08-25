# [task-loop-governance.md] Universal Task Loop Plugin Governance Rules

本文档为 `task-loop` 插件内置的全局智能体治理与研发协同规范规则。

---

## 1. 核心硬性约束 (Hard Rules)

* **纯文本与符号规范**: 禁止在文档、注释与输出中使用 Emoji 图标，一律采用结构化文本标签（如 `[Core]`, `[Main Session]`, `*`, `->`）。
* **项目内 Markdown 格式规范**: 严禁在仓库持久化 Markdown 文档（`*.md`）中使用 Markdown 表格语法，所有多维对照、清单与枚举一律强制采用结构化 `json` 代码块表示（明确排除 AI 日常对话回复）。
* **文件编辑工具约束**: 强制使用原生文件编辑工具（`replace_file_content` / `write_to_file`），严禁使用 PowerShell 命令行重写文件。
* **Git 安全约束**: 严禁 Agent 自动执行 `git add`, `git commit`, `git push`, `git reset` 等命令，所有变更保留在本地工作区由用户自主决定提交。
* **编码一致性**: 统一使用 UTF-8 编码，严禁将文本转为 GBK。

---

## 2. 主会话编排与三步派单铁律 (Main Session 3-Step Law)

主会话在接收到用户需求后，专注于需求初加工、任务编排、任务类型判定（只读 `explore` vs 修改 `work`）与物理白名单（`allowlist`）划定：
1. **寻找专题会话**: 查阅 `.agents/task-loop/sessions.json`，若存在对应领域的长期专题会话，直接执行步骤 3；
2. **没有则新建**: 若为全新领域，调用 `agentapi new-conversation --title="[专题名称] 功能1 & 功能2" "<prompt>"` 创建真实持久顶层专题会话并注册；
3. **定向发信请求**: 通过 `send_message(recipient, message)` 下发任务，严禁首选本能派发空白临时子代理。

---

## 3. 子会话一致性执行流 (Sub-Session Workflow Parity)

子会话（Subagent / Topic Session）执行生命周期 100% 保持前后一致：
```json
[
  {
    "stage": "1. 承接锁定",
    "workflow": "解析上级下发的单一职责目标 (Objective)、物理白名单 (Allowlist)、验收准则与 1/2/3 复杂度。"
  },
  {
    "stage": "2. 边界实施",
    "workflow": "严格限制在 Allowlist 白名单内修改，严禁跨模块泛化修改；遵守硬性规则。"
  },
  {
    "stage": "3. 本地自测",
    "workflow": "执行全量单元测试与编译检查 (Exit Code 0)；Diff 走查核验无越界改动。"
  },
  {
    "stage": "4. 记忆沉淀",
    "workflow": "若产生证实的新事实/架构决策，回写所属专题文档 docs/memory/*.md。"
  },
  {
    "stage": "5. 标准交付",
    "workflow": "向主会话汇报交付结果：Summary、Changes、Evidence 与人机混合操作指引。"
  }
]
```
