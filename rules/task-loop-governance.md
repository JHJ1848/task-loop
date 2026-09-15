# [task-loop-governance.md] Universal Task Loop Plugin Governance Rules

本文档为 `task-loop` 插件内置的全局智能体治理与研发协同规范规则。

---

## 1. 核心硬性约束 (Hard Rules)

* **纯文本与符号规范**: 禁止在文档、注释与输出中使用 Emoji 图标，一律采用结构化文本标签（如 `[Core]`, `[Main Session]`, `*`, `->`）。
* **项目内 Markdown 格式规范**: 严禁在仓库持久化 Markdown 文档（`*.md`）中使用 Markdown 表格语法，所有多维对照、清单与枚举一律强制采用结构化 `json` 代码块表示（明确排除 AI 日常对话回复）。
* **文件编辑工具约束**: 强制使用原生文件编辑工具（`replace_file_content` / `write_to_file`），严禁使用 PowerShell 命令行重写文件。
* **Git 安全约束**: 严禁 Agent 自动执行 `git add`, `git commit`, `git push`, `git reset` 等命令，所有变更保留在本地工作区由用户自主决定提交。
* **编码一致性**: 统一使用 UTF-8 编码，严禁将文本转为 GBK。
* **单主干与多厂商状态分区持久化**: 统一在 master 单主干维护所有厂商扩展能力，由 `.agents/task-loop/sessions.json` 的 `vendors` 字段与 `.agents/task-loop/sessions.<vendor>.json` 专属物理文件进行会话分区隔离，专题清单以 `docs/memory/*.md` 为法定事实源进行 1:1 对齐。

---

## 2. 主会话编排与三步派单铁律 (Main Session 3-Step Law)

主会话在接收到用户需求后，专注于需求初加工、任务编排、任务类型判定（只读 `explore` vs 修改 `work`）与物理白名单（`allowlist`）划定：
* **主会话行为硬性红线 (Explore Only & Sidebus Delegation)**: 主会话仅限执行只读探索与架构诊断 (EXPLORE)，**严禁在自身会话中直接修改业务代码 (WORK)**；所有具体编码与 BugFix 必须且强制要求通过 sidebus (`send_message` / `agentapi`) 派单至对应的专题会话 (Topic Session) 实施，各专题会话承接任务后才可在其内部按需拉起子代理 (subagents) 落地，彻底杜绝主会话直接动手或擅自派遣临时 Worker 造成的治理失控。
* **主会话子代理派遣权限限制 (Reviewer & Explorer Only)**: 主会话严禁派遣 Worker (落地/写代码子代理)，主会话只能派遣 `reviewer` (代码审查/走查) 和 `explorer` / `research` (架构只读探索) 子代理；
* **无可用会话与防擅自派发铁律 (Strict Topic Governance & No Unauthorized Worker)**: 若没有相关专题会话可用、或不清楚如何新建/请求会话，主会话**必须先检查相关文档指导 (`references/sdk/README.md`, `skills/new-session/SKILL.md`, `skills/session-control/SKILL.md`)**；若仍需确认，**必须主动向用户请求指引并询问**；**绝对禁止主会话自主擅自派遣子代理 Worker 逃避专题治理！**
1. **寻找专题会话**: 查阅 `.agents/task-loop/sessions.json`，若存在对应领域的长期专题会话，直接执行步骤 3；
2. **没有则新建**: 若为全新领域，按规范调用 `agentapi new-conversation --title="[专题名称] 功能1 & 功能2" "<prompt>"` 创建真实持久顶层专题会话并注册；若不知如何创建则先查阅文档或向用户询问；
3. **Sidebus 定向发信**: 通过 sidebus 管道调用 `send_message(recipient, message)` 下发任务，严禁主会话擅自拉起临时子代理代劳。

---

## 3. 专题会话与执行端一致性执行流 (Topic Session & Worker Workflow Parity)

专题会话及其内部子代理（Topic Session & Subagents）执行生命周期 100% 保持前后一致：
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
    "stage": "5. 强制反向交付",
    "workflow": "自测通过后严禁仅在当前视窗输出文本停下，必须且强制在最后一轮调用 send_message(recipient=\"<main_thread_id>\", message=\"[专题交付: WORK]...\") 向主治理中枢汇报交付结果 (Summary, Changes, Evidence)，触发主会话门禁验收。"
  }
]
```

---

## 4. 白名单双向闭环与反向审批机制 (Allowlist Bi-Directional Governance)

* **PreToolUse 安全拦截与反向审批**: 当专题会话或执行端尝试修改未在任务白名单 (`allowlist`) 内的文件时，PreToolUse 钩子将硬性拦截该写操作，并在拦截提示中直接提供反向审批指令：
  `send_message('<main_thread_id>', '【请求主中枢扩展白名单/审批任务】目标文件: <path>, 变更原因: <理由>')`
* **主中枢裁决流程**: 主会话收到反向审批请求后，评估修改合理性。若批准，主会话更新派单白名单并向专题发信放行；若驳回，专题会话必须调整实施路径以遵守原物理边界。

---

## 5. 主会话批判性门禁验收与杜绝橡皮图章机制 (Critical Gate & Anti-Rubber-Stamp)

* **严禁充当橡皮图章 (Anti-Rubber-Stamp)**: 主会话收到专题会话的交付汇报后，**严禁未经独立核验直接盲目轻信、透传或直接更新 todo.json 状态**；
* **强制四步独立质检 (Mandatory 4-Step Verification)**:
  1. **独立执行验证**: 主会话必须亲自/独立执行自动化测试与构建命令，获取真实的 Exit Code 0 与测试输出证据（严禁仅听信专题文字总结）；
  2. **真实 Diff 审查**: 严格走查实际改动文件是否 100% 在 Allowlist 白名单内，严查是否存在冗余代码、多余重构、意外删除或编码格式污染；
  3. **必要时派遣 Reviewer**: 对 Level 2/3 或高风险架构改动，主会话应按需派遣 `reviewer` 子代理执行代码走查与方案交叉核验；
  4. **门禁裁决与驳回**: 核验全部通过方可标记完成；若发现单测失败、越界修改或逻辑缺陷，**必须强制向专题会话下发 `DELIVERABLE_REJECTED`** 附带具体缺陷清单与修复指令驳回重修！

---

## 6. 主会话派单双阶梯进度监测与巡检机制 (Dual-Stage Progress Monitor & Inspection Tasks)

为消除后台专题会话休眠未启动或未响应导致的派单失控与死等，主会话派单后**严禁采用无条件直接进入 120s 的固定流水线**，必须严格执行【30s 响应监测器门禁循环与 120s 巡检任务准入闭环】：

* **【Stage 1: 30s 响应监测器循环与自愈门禁 (30s Response Monitor Gate Loop & Self-Healing)】**:
  - 派单后挂载 30s 响应监测器定时器（`schedule DurationSeconds=30 Prompt="检查专题会话真激活状态" TimerCondition="any"`）；
  - 30s 到期触发时，主会话必须运行真活跃监测：`node scripts/inspect_agy_sessions.js --monitor-dispatch <session_id>`；
  - **核心准入门禁条件**: 仅当响应监测器确凿返回 `is_working === true`（存在 `source: 'MODEL'` 工作步、思考/工具调用或 `thread_running === true` 内存生成态，即 `can_enter_120s_gate: true`）时，才准入 Stage 2；
  - **未激活处理与循环自愈铁律**: 若 `is_working === false` (状态为 `DORMANT_NOT_ACTIVATED` / `should_loop_30s_monitor: true`)：
    1. **绝对严禁调用 120s 巡检任务定时器进入盲等！**
    2. 必须立即出具【🔴 专题未激活告警卡】(含 `conversation://<session_id>` 唤醒链接)；
    3. 立即通过 `agentapi.bat send-message`（或当前环境 CLI）自动补发激活包进行自愈唤醒；
    4. **必须继续挂载 30s 进度监测器循环监控**，重复本门禁直至确凿激活或用户手动干预。
* **【Stage 2: 120s 巡检任务准入门禁 (120s Inspection Task Admission Gate)】**:
  - 仅当 Stage 1 响应监测器确凿通过 (`is_working === true`) 后，才允许准入挂载 120s 巡检定时器（`schedule DurationSeconds=120 Prompt="巡检专题会话执行偏差" TimerCondition="any"`）；
  - 120s 到期触发时，主会话读取目标专题的最新执行轨迹与推演思路（`transcript.jsonl`），执行偏差走查：
    1. 检查专题是否偏离初始单一职责目标 (Objective)；
    2. 检查专题是否陷入死循环、重复调用或尝试越界修改；
    3. 检查推演思路是否存在严重技术漏洞；
  - 若发现偏差，主会话立即通过 sidebus (`send_message`) 下发纠偏与修正指令；若执行正常但未结束，则允许其继续并等待最终交付。
* **定时器生命周期与冲突管理**:
  - 严禁在未清理旧定时器的情况下挂载带有相同条件的定时器；
  - 挂载新一轮 30s 进度监测器或新阶段定时器前，必须先调用 `manage_task(Action='kill', TaskId='<old_task_id>')` 显式销毁旧定时器，杜绝 `conflicting early termination condition`。

---

## 7. 强制原生问答交互与杜绝纯文本提问红线 (Mandatory Native Question & Anti-Plaintext Prompt Law)

为了消除智能体以纯文本长句提问并强迫用户手动打字确认的不良交互惯性，全量智能体（主会话、专题会话与即时子代理）在关键决策门禁处**强制执行原生问答与选项交互**：

* **核心红线 (Anti-Plaintext Prompt Law)**:
  - 严禁在涉及人机决策、方案确认、白名单反向审批、专题会话创建与落盘等关键门禁节点输出“请回复‘确认落盘’/‘确认创建’/‘proceed’”等纯文本手打指令；
  - 严禁通过脆弱的文本匹配作为自动化门禁放行条件；
* **优先且强制调用宿主原生问答工具**:
  - **Google Antigravity (AGY)**: 必须且强制调用原生 `ask_question` 工具：
    * `questions` 数组包含单一职责问题，选项聚焦于用户直接响应动作；
    * 推荐项必须置于第一项并前缀 `(Recommended)`；
    * 选项文本必须以**用户响应的第一人称视角**表述（如“立即落盘配置并执行测试”），严禁描述 Agent 自身行为；
    * 严禁在 options 数组中手动添加 "Other" 或 "其他"（系统原生内置 write-in 文本框）；
  - **OpenAI Codex**: 优先调用宿主暴露的交互选择原语或 Desktop 组件；在 CLI / Headless 模式下降级为紧凑编号选项 `[1] [2] [3]`，通过单按键捕获即时完成裁决，杜绝要求用户打全称；
  - **Anthropic Claude Code**: 采用原生交互确认原语 (Confirm / AskUserPrompt) 或交互单选结构，实现终端箭头键切换与回车秒级确认；
* **QuestionProvider 统一抽象模型**:
  ```text
  ask_user_choice(question, options, options_config: { recommendedIndex, is_multi_select }) -> QuestionResult
  ```
* **门禁节点强制应用场景清单**:
  ```json
  [
    {
      "gate_type": "1. 架构方案二选一裁决",
      "enforcement": "当存在多种备选设计或破坏性重构方案时，必须调用 ask_question 由用户选择决策分支。"
    },
    {
      "gate_type": "2. 白名单反向审批决策",
      "enforcement": "主中枢接收到专题发起的 ALLOWLIST_EXPANSION_REQUEST 后，提请用户选择【批准扩展】或【驳回调整】。"
    },
    {
      "gate_type": "3. 物理模块落盘与破坏性写操作",
      "enforcement": "生成全新独立模块、覆盖核心规则或初始化状态机前，弹出交互选项确认。"
    },
    {
      "gate_type": "4. 人机混合交付门禁核验",
      "enforcement": "对含 UI/渲染/强交互项的任务交付，出具原生问答选项供用户进行真实视觉打标通过或驳回。"
    }
  ]
  ```

