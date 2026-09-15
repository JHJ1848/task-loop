# [SDK Question] 跨厂商原生问答与人机交互选项原语规范

本文档定义了 `task-loop` 中跨厂商智能体人机交互（Question & Interactive Choice）的标准抽象接口 `QuestionProvider`，聚焦 Google Antigravity、OpenAI Codex 与 Anthropic Claude Code 三大主流厂商，规范化接入并强制使用宿主原生选项交互机制，杜绝低效的纯文本手打回复惯性。

---

## 一、人机交互核心红线与设计哲学 (Core Law & Design Philosophy)

### 1. 杜绝纯文本手打回复红线 (Anti-Plaintext Prompt Law)
在涉及人机决策、方案确认、白名单反向审批、专题会话创建与落盘等关键门禁节点，**严禁**智能体在回复正文中输出诸如：
* "请回复‘确认落盘’以继续..."
* "若同意请回复‘确认创建’..."
* "请输入‘proceed’开始执行..."

此类纯文本提问具有以下严重弊端：
1. **交互脆弱易错**：人类用户可能输入同义词（如“好”、“可以”、“行”、“ok”），导致智能体陷入分支歧义与循环追问；
2. **打字负担与上下文浪费**：强迫用户手动敲击长词句，违背智能体敏捷高效设计原则；
3. **缺乏结构化门禁断言**：文本回复无法被自动化测试、状态机与看门狗准确判定。

### 2. 原生选项交互优先原则 (Native Choice First)
智能体在需要用户做出离散选择、决策分支或确认审批时，**必须且强制优先调用宿主平台提供的原生交互问答组件**（如交互式模态弹窗、单选/复选框、回车确认按钮等），提供清晰预设选项，实现“点击即确认、零打字负担”。

---

## 二、三大厂商原生问答原语与能力映射 (Three Vendors Mapping)

```json
[
  {
    "vendor": "Google Antigravity (AGY)",
    "native_primitive": "ask_question(questions: [{ question, options, is_multi_select }])",
    "ui_interaction": "交互式模态弹窗 (Interactive Modal)，含单选/多选框、可选 write-in 文本框、Submit/Skip 按钮",
    "execution_model": "阻塞挂起当前 Turn 执行，直到用户提交选项或跳过",
    "status": "主力支持 (Primary Native)"
  },
  {
    "vendor": "OpenAI Codex",
    "native_primitive": "Codex Desktop 交互选择组件 / CLI Prompt 编号选项",
    "ui_interaction": "宿主暴露选择框时直接弹窗，未暴露时降级为编号紧凑选项 [1] [2] [3]，按单键或数字即可确认",
    "execution_model": "单按键即时响应，杜绝长文本拼写",
    "status": "稳定降级适配 (Stable Degradation Adapter)"
  },
  {
    "vendor": "Anthropic Claude Code",
    "native_primitive": "Confirm / AskUserPrompt 原生确认原语",
    "ui_interaction": "终端原生交互式选项列表 (Interactive Select/Confirm)，箭头键切换与回车确定",
    "execution_model": "进程内标准输入流监听，按键捕获",
    "status": "预留适配 (Standard Adapter)"
  }
]
```

### 1. Google Antigravity (AGY) 原生 `ask_question` 规范
AGY 提供了原生内置工具 `ask_question`，具有极高的可用性与美观的 UI 模态框：
* **参数结构**：
  - `questions` (Array): 问答项数组。每个元素包含：
    - `question` (string): 提问内容，直接提出核心问题，不添加“请选择以下选项”等冗余提示；
    - `options` (string[]): 选项文本数组（至少 2 项，不包含手动添加的 'Other'，系统会自动提供 write-in 兜底）；
    - `is_multi_select` (boolean): 是否允许多选，默认为 false（单选）。
* **格式约束**：
  - 若存在首选推荐项，必须置于第一项并前缀 `(Recommended)`，例如 `(Recommended) 采用方案 A：轻量直接交互模式`；
  - 选项文本必须以**用户直接响应**的第一人称视角表述（如“立即落盘配置文件”、“暂缓修改，先做只读调研”），严禁使用描述 Agent 自身行为的话术；
  - 关联文件时采用绝对路径 Markdown 链接语法（`[config.json](file:///path/to/config.json)`）。

### 2. OpenAI Codex 交互选项规范
Codex 在 Desktop 与 CLI 环境下的差异化适配：
* **Desktop App 宿主环境**：若宿主通过 App Tools 或 RPC 暴露了交互选择工具，优先封装调用；
* **CLI / Headless 交互环境**：格式化输出结构化单按键选择提示：
  ```text
  [决策门禁] 请选择后续执行路径:
    [1] (推荐) 立即执行方案 A
    [2] 补充单元测试
    [3] 放弃本次变更
  请输入选项序号 (1-3):
  ```
  通过拦截单字符输入（Single Keypress）即可完成裁决，杜绝要求用户输入全称。

### 3. Anthropic Claude Code 交互确认规范
* Claude Code 内置交互机制支持 Confirm 模态与交互列表：
  - 针对二元决策（确认/取消），调用原生 Confirm 组件；
  - 针对多支决策，输出序号选项并在控制台捕获回车或数字键。

---

## 三、QuestionProvider 统一抽象接口与数据模型 (Unified Question Schema)

### 1. 数据模型定义

```json
{
  "QuestionItem": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "问题唯一标识符" },
      "question": { "type": "string", "description": "核心提问内容" },
      "options": {
        "type": "array",
        "items": { "type": "string" },
        "description": "候选选项列表 (至少 2 项)"
      },
      "default_option_index": { "type": "integer", "description": "默认推荐项索引 (0-based)" },
      "is_multi_select": { "type": "boolean", "description": "是否支持多选" },
      "allow_custom_input": { "type": "boolean", "description": "是否允许自定义手写输入" }
    },
    "required": ["question", "options"]
  },
  "QuestionResult": {
    "type": "object",
    "properties": {
      "selected_indices": { "type": "array", "items": { "type": "integer" } },
      "selected_options": { "type": "array", "items": { "type": "string" } },
      "custom_input": { "type": "string" },
      "skipped": { "type": "boolean" },
      "vendor": { "type": "string" }
    },
    "required": ["selected_options", "skipped", "vendor"]
  }
}
```

### 2. QuestionProvider 抽象基类标准契约
```text
┌────────────────────────────────────────────────────────────────────────┐
│                        QuestionProvider 接口规范                       │
├────────────────────────────────────────────────────────────────────────┤
│ • ask_user_choice(question, options, options_config) -> QuestionResult │
│ • confirm_action(prompt, default_yes) -> boolean                      │
│ • select_from_list(title, items, multi_select) -> selected_items       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 四、双轨实现参考 (Dual-Runtime Implementation)

本项目坚持全栈零外部第三方依赖，分别基于 Node.js 18+ 与 Python 3.8+ 标准库实现跨厂商问答分发与降级保障。

### 1. Node.js 18+ 原生轻量实现 (`question_provider.js`)

```javascript
// question_provider.js - 零依赖 Node.js 18+ 标准实现
const readline = require('readline');

class QuestionProvider {
  constructor(vendor = 'antigravity') {
    this.vendor = vendor;
  }

  /**
   * 提请用户选择离散项
   * @param {string} question - 问题标题
   * @param {string[]} options - 选项列表
   * @param {object} config - 包含 is_multi_select, recommendedIndex 等
   * @returns {Promise<{ selected_options: string[], skipped: boolean, custom_input: string }>}
   */
  async askUserChoice(question, options, config = {}) {
    // 1. Google Antigravity 环境检测
    if (this.vendor === 'antigravity' && typeof globalThis.ask_question === 'function') {
      const formattedOptions = options.map((opt, idx) => 
        idx === (config.recommendedIndex ?? 0) ? `(Recommended) ${opt}` : opt
      );
      const res = await globalThis.ask_question({
        questions: [{
          question,
          options: formattedOptions,
          is_multi_select: Boolean(config.is_multi_select)
        }],
        toolAction: 'Soliciting user preference',
        toolSummary: 'Question interaction'
      });
      return {
        selected_options: res?.[0]?.selected ?? [formattedOptions[0]],
        skipped: Boolean(res?.[0]?.skipped),
        custom_input: res?.[0]?.write_in || ''
      };
    }

    // 2. 通用 CLI / Codex / Claude 交互式终端单键降级
    return this._fallbackCliPrompt(question, options, config);
  }

  _fallbackCliPrompt(question, options, config) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log(`\n[人机交互确认] ${question}`);
      options.forEach((opt, idx) => {
        const isRec = idx === (config.recommendedIndex ?? 0) ? ' [推荐]' : '';
        console.log(`  [${idx + 1}] ${opt}${isRec}`);
      });

      rl.question(`\n请选择序号 (1-${options.length}, 默认 1): `, (answer) => {
        rl.close();
        const trimmed = answer.trim();
        const choiceIdx = trimmed === '' ? 0 : parseInt(trimmed, 10) - 1;
        if (choiceIdx >= 0 && choiceIdx < options.length) {
          resolve({
            selected_options: [options[choiceIdx]],
            skipped: false,
            custom_input: ''
          });
        } else {
          resolve({
            selected_options: [],
            skipped: false,
            custom_input: trimmed
          });
        }
      });
    });
  }
}

module.exports = { QuestionProvider };
```

### 2. Python 3.8+ 原生轻量实现 (`question_provider.py`)

```python
# question_provider.py - 零 pip 依赖 Python 3.8+ 标准实现
import sys
from typing import List, Dict, Any, Optional

class QuestionProvider:
    def __init__(self, vendor: str = "antigravity"):
        self.vendor = vendor

    def ask_user_choice(
        self,
        question: str,
        options: List[str],
        recommended_index: int = 0,
        is_multi_select: bool = False
    ) -> Dict[str, Any]:
        """提请用户选择离散项，具备原生适配与 CLI 自动降级"""
        print(f"\n[人机交互确认] {question}", file=sys.stderr)
        for idx, opt in enumerate(options):
            rec_tag = " [推荐]" if idx == recommended_index else ""
            print(f"  [{idx + 1}] {opt}${rec_tag}", file=sys.stderr)

        prompt_str = f"\n请选择序号 (1-{len(options)}, 默认 1): "
        try:
            choice_str = input(prompt_str).strip()
            if not choice_str:
                choice_idx = recommended_index
            else:
                choice_idx = int(choice_str) - 1
            
            if 0 <= choice_idx < len(options):
                return {
                    "selected_options": [options[choice_idx]],
                    "skipped": False,
                    "custom_input": "",
                    "vendor": self.vendor
                }
            return {
                "selected_options": [],
                "skipped": False,
                "custom_input": choice_str,
                "vendor": self.vendor
            }
        except (EOFError, KeyboardInterrupt):
            return {
                "selected_options": [],
                "skipped": True,
                "custom_input": "",
                "vendor": self.vendor
            }
```

---

## 五、门禁审批与决策推演应用范式 (Gate Approval Integration)

在任务流转中，以下四类核心场景**强制调用原生问答**：

```json
[
  {
    "scene": "1. 方案二选一与架构决策 (Design Trade-offs)",
    "usage": "当存在多种实现路径且各有利弊时，调用 ask_question 提供结构化方案供人类决策，禁止 Agent 自行武断选择。"
  },
  {
    "scene": "2. 物理白名单反向审批 (Allowlist Expansion Approval)",
    "usage": "当专题发现必须修改超出派单 Allowlist 白名单的文件时，向主中枢申请后，主中枢提请人类进行选项确认批准。"
  },
  {
    "scene": "3. 关键模块落盘与破坏性写前确认 (Critical Write Gate)",
    "usage": "在创建全新持久化模块、初始化项目配置或覆盖关键规则前，提请确认落盘。"
  },
  {
    "scene": "4. 不可逆验证与人机混合交付 (Human-in-the-Loop Deliverable)",
    "usage": "涉及 UI 渲染、复杂业务流程的最终验收，出具交互式验收选项供用户打标通过或驳回。"
  }
]
```

---

## 六、开发陷阱与警示 (Gotchas)

1. **[Gotcha 1] 严禁手动构造 'Other' 选项**：在 AGY 的 `ask_question` 中，UI 默认已提供 write-in 输入框，若在 `options` 数组中手工硬编码 `"Other"` 或 `"其他"`，会导致界面重复出现两个自定义输入入口。
2. **[Gotcha 2] 选项视角必须为用户响应**：选项内容应撰写为用户的回复（例如 `确认落盘并执行测试`），而非命令语气或描述智能体行为（例如 `我将开始修改文件`）。
3. **[Gotcha 3] 避免泛化至日常简单对话**：对于简单的确认或说明，直接在聊天中交流即可；问答原语专门用于**离散选项决策与关键质检门禁**，切忌小题大做频繁弹窗打扰用户。
