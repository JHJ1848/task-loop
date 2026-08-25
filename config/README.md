# [config/README.md] task-loop 用户偏好与主会话策略配置指南

本文档定义了 [`config/user_preferences.json`](user_preferences.json) 的完整配置规范、Main 会话动态模型裁决机制、优先级流转以及各配置项的 `<a/b/c>` 选项说明。

---

## 一、完整 JSON 配置示例 (Full JSON Specification)

```json
{
  "version": "1.0.0",
  "main_session_policy": {
    "default_vendor": "antigravity",
    "explainable_reasoning": true,
    "allow_simple_direct_edits": true,
    "complexity_bias": "balanced",
    "model_selection_policy": {
      "strategy": "dynamic_runtime_decision",
      "default_mode": "inherit"
    },
    "anti_wandering_intervention": {
      "enabled": true,
      "max_turns_for_level_1": 3,
      "max_unconverged_errors": 2,
      "allowlist_violation_action": "intervene_and_revert"
    }
  },
  "hybrid_verification_policy": {
    "prefer_installed_review_skills": [
      "code-review",
      "superpowers:code-review",
      "receiving-code-review",
      "systematic-debugging"
    ],
    "unverifiable_ui_action": "prompt_user_with_steps"
  }
}
```

---

## 二、模型与思考深度动态运行时裁决机制 (Dynamic Runtime Decision)

### 1. 为什么不进行静态配置硬编码？
1. **模型持续迭代演进**：各厂商模型版本迭代频繁，静态硬编码模型名称极易失效或导致调用不存在的模型 ID。
2. **多端与反向代理兼容**：用户可能通过反向代理网关、中转服务或企业专网将底层模型映射为自定义名称，静态配置无法保证模型全局存在。
3. **主会话感知最全面**：Main 会话在实际派单拉起子代理时，最清楚当前任务的真实复杂度、上下文大小以及用户在当前指令中的明确意图。

---

### 2. 动态裁决流程与优先级 (Precedence Hierarchy)

* **第一优先级【用户显式指令】**：
  * 若用户在指令中明确要求（如“使用轻量模型快速排查”、“开启深度思考重构”），Main 会话在调用 `invoke_subagent` 时显式指定对应的 `Model` 参数。
* **第二优先级【主会话依据 1/2/3 复杂度动态推断】**：
  * **Level 1（简单单点）**：推荐分派轻量/低延迟模型（如 `flash` / `flash_lite` / `haiku` / `mini`）。
  * **Level 2（标准开发）**：推荐分派通用标准主力模型（如 `flash` / `sonnet` / `standard`）或直接继承。
  * **Level 3（复杂架构）**：推荐分派深度推理旗舰模型（如 `pro` / `opus` / `sol`）或开启高思考深度。
* **第三优先级【默认兜底继承】**：
  * 在未明确指定时，默认使用 `Model: "inherit"`，自动无缝继承主会话正在使用的模型与思考深度。

---

## 三、配置项与 `<a/b/c>` 选项详解 (Field Details & Options)

### 1. `main_session_policy` (主会话行为策略)

* **`default_vendor`**：默认活动的 AI 厂商平台
  * **选项**：`<antigravity / codex / claude>`
  * **说明**：指定 task-loop 的默认调度底层平台。
* **`enable_file_state_machine`**：基于本地 JSON 文件的严格状态机机制
  * **选项**：`<false (默认) / true>`
  * **说明**：
    * `false`（默认推荐）：针对高延迟/上下文紧张的 AI，主会话直接与用户进行**自然语言交互**，动态分析需求、评估专题匹配度并直接下发任务到对应专题会话，零本地状态文件读写与锁争用；
    * `true`：开启完整的本地文件持久化状态机（`lease.json` 原子锁、`todo.json` 任务队列、`dispatch/*.json` 派单包与 `run-journal.jsonl` 流水日志），适用于需要严格离线追踪的场景。
* **`explainable_reasoning`**：透明思考与决策推演卡输出
  * **选项**：`<true / false>`
  * **说明**：派单或质检前是否输出结构化【决策推演卡】与 Allowlist 白名单分析。
* **`allow_simple_direct_edits`**：简单任务单线程直修权限
  * **选项**：`<true / false>`
  * **说明**：Level 1 简单任务是否允许主会话就地闭环，无需强制派分子代理。
* **`complexity_bias`**：复杂度裁决分级倾向
  * **选项**：`<conservative / balanced / aggressive>`
  * **说明**：
    * `conservative`（保守）：倾向于裁决为高复杂度，拆分子代理。
    * `balanced`（均衡）：客观按照修改面与影响范围裁决。
    * `aggressive`（激进）：倾向于在主会话快速收敛。
* **`model_selection_policy.strategy`**：模型选择策略
  * **选项**：`<dynamic_runtime_decision / static_manual_override>`
  * **说明**：`dynamic_runtime_decision` 声明由 Main 会话在派单时按需动态决定模型与思考深度。
* **`model_selection_policy.default_mode`**：默认模式
  * **选项**：`<inherit / custom>`
  * **说明**：`inherit` 为自动继承主会话模型。
* **`anti_wandering_intervention.allowlist_violation_action`**：改动越界处置动作
  * **选项**：`<intervene_and_revert / warn_only / block_and_terminate>`
  * **说明**：子代理越界修改时的处理策略（纠偏回滚 / 仅告警 / 阻断终止）。

### 2. `hybrid_verification_policy` (质检门禁与人机混合验证)

* **`prefer_installed_review_skills`**：优先调用的代码审查 Skill 清单
  * **选项**：`<字符串数组, 如 ["code-review", "receiving-code-review", "systematic-debugging"]>`
* **`unverifiable_ui_action`**：不可量化 UI/交互项动作
  * **选项**：`<prompt_user_with_steps / fail_closed / skip>`
  * **说明**：输出【用户验证指引卡】人工验收 / 阻断未通过 / 忽略跳过。
