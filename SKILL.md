---
name: task-loop
description: Universal cross-agent task loop for Antigravity, Codex, and Claude Code. Main thread orchestrates requirements, manages 1/2/3 complexity tiering, scans and tags multi-vendor project sessions, and auto-provisions topic threads.
---

# Universal Task Loop

通用跨 Agent 任务循环调度器，全面支持 **Antigravity (AGY)**、**Codex** 和 **Claude Code**。

![架构设计与落地方案](assets/architecture.png)

---

## [Hard Rules] 跨平台成熟规则与边界约束

为确保在 Windows、macOS、Linux 多端环境下的鲁棒性，所有脚本与交互必须遵守以下规则：
1. **大小写敏感性约束**：所有模块路径、文件路径与 `module_key` 严格遵循 Linux 规范（区分大小写），杜绝在 Windows 上可运行而在 Linux 上找不到文件的隐患。
2. **强制标准 UTF-8 编码**：所有 Python 脚本入口显式配置 `sys.stdout.reconfigure(encoding='utf-8')`，严禁产生 GBK 截断与乱码。
3. **杜绝绝对路径硬编码**：所有持久化文件、注册表与派单包中严禁硬编码绝对系统路径，必须统一解析为相对于 `$HOME` 或 `$ProjectRoot` 的规范化路径。
4. **Skill 目录自包含**：用户偏好与主会话通用行为策略保存于 `config/user_preferences.json`，复制整个 Skill 目录即可完整迁移个人使用习惯。

---

## 依赖环境与各系统安装命令

### 1. 运行环境要求
* **Python**: `Python 3.8+`（基于纯标准库构建，**零外部 pip 第三方依赖**）。
* **Node.js**（可选扩展）: `Node.js 18+`。

### 2. 各操作系统一键安装命令

#### [macOS] macOS (Homebrew)
```bash
brew install python
```

#### [Linux] Linux (Ubuntu / Debian / CentOS / RHEL / Arch)
```bash
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y python3 python3-pip
# CentOS / RHEL / Fedora
sudo dnf install -y python3 || sudo yum install -y python3
# Arch Linux
sudo pacman -S --noconfirm python
```

#### [Windows] Windows (winget / scoop / choco)
```bash
winget install Python.Python.3.12 || scoop install python || choco install python -y
```

---

## [Main Session] 主会话角色、三大核心能力与人机混合验证

### 1. 主会话（Main Session）角色与定位
* **中枢职责**：主会话负责需求初加工、全局项目信息提取、任务编排、边界划定与质量核验。
* **灵活边界**：主会话允许进行必要的小范围直接微调（Level 1 场景）与全局项目只读感知，提炼高质量重点信息作为派单参数。
* **客观事实**：**非主会话（专题会话）完全支持用户直接进入交互与开发**，无需强行受制于主会话。

### 2. 主会话三大核心能力
1. **需求初加工与定界（Intake & Pruning）**：对用户原始模糊输入进行提炼，剔除过度设计，形成原子化目标。
2. **物理修改边界划定（Surgical Allowlist）**：严格划定本次任务允许变动的文件白名单，阻断代码扩散。
3. **复杂度裁决与授权策略（1 / 2 / 3 分级）**：
   * **Level 1（简单）**：单点快修，极速直发单线程执行。
   * **Level 2（标准）**：模块内标准开发，限制在 Allowlist 内自测与记忆回写。
   * **Level 3（复杂）**：跨模块或重构，**强制要求专题调用 Subagent 进行多角色（Research/Worker/Reviewer）并行分工**。

### 3. 质检与人机混合验证模型（Hybrid Verification）
* **优先复用既有评审 Skill**：在质检时优先查找环境中安装的 `code-review`、`superpowers:code-review`、`systematic-debugging` 等标准审查技能。
* **人机混合验证（Human-in-the-Loop）**：对 UI 审美、图形渲染、复杂交互效果等 AI 无法量化的场景，主会话负责构建与代码核验，并输出清晰的**【用户验证指引步骤】**，由人类用户做最终体验确认。

---

## [SDK] 会话 SDK 接口标准与走弯路干预

### 1. 会话控制 SDK 接口（详见 [session-sdk-reference.md](references/session-sdk-reference.md)）
* **Antigravity (AGY)**：`invoke_subagent`（拉起子会话）、`send_message`（发信）、`manage_subagents`（管理/终止）、系统原生 **Reactive Wakeup** 零 Token 响应式唤醒。
* **Codex**：`send_message_to_thread`（发信）、`create_conversation`（建会话）。
* **Claude Code**：预留 CLI 管道与 Hook 监听插槽。

### 2. 走弯路检测与合法 SDK 干预
当专题出现“交互轮次畸高”、“改动超出 Allowlist”、“报错反复震荡”时，主会话使用官方原生 SDK 工具（`send_message` 发送纠偏指令，或 `manage_subagents(kill)` 熔断）实施干预。

---

## [Workflow] 项目初始化与会话打标工作流

1. **扫描元数据**：`python scripts/find_project_sessions.py --root . --inspect`（获取 `session_id`, `log_path`, `recent_prompts`）。
2. **语义打标**：主会话 AI 归纳功能模块，分配 `module_key`、`tags`、`summary` 与关联专题记忆 `docs/memory/*.md`。
3. **原子持久化**：写入 `.agents/task-loop/sessions.json` 与 `topics.json`。
4. **输出拓扑图**：向用户展示清晰的功能模块与会话映射矩阵。

---

## 核心脚本清单（跨平台 Python）

| 脚本文件 | 说明 | 常用执行命令 |
|---|---|---|
| `scripts/find_project_sessions.py` | 跨厂商会话扫描与内省入口 | `python scripts/find_project_sessions.py --root . --inspect` |
| `scripts/providers/get_agy_project_sessions.py` | AGY 会话感知与近期交互提取 Provider | `python scripts/providers/get_agy_project_sessions.py . --inspect` |
| `scripts/providers/get_codex_project_sessions.py` | Codex 专属会话感知 Provider | `python scripts/providers/get_codex_project_sessions.py .` |
| `scripts/providers/get_claude_project_sessions.py` | Claude Code 预留 Provider Stub | `python scripts/providers/get_claude_project_sessions.py .` |
| `scripts/reconcile_task_loop_topics.py` | 专题自动拉起与注册对齐 | `python scripts/reconcile_task_loop_topics.py --root . --manifest <topics.json> --registry <sessions.json>` |
| `scripts/new_task_loop_dispatch_packet.py` | 1/2/3 复杂度派单包生成器 | `python scripts/new_task_loop_dispatch_packet.py --root . --run-id <UUID> --target-thread-id <ID>` |
| `scripts/test_task_loop_preflight.py` | 轻量门禁预检脚本（1/2/3 复杂度感知） | `python scripts/test_task_loop_preflight.py --root .` |
| `scripts/acquire_task_loop_lease.py` / `release_task_loop_lease.py` | 原子租约锁获取与释放 | `python scripts/acquire_task_loop_lease.py ...` |
| `scripts/initialize_task_loop_state.py` | 项目运行态目录初始化 | `python scripts/initialize_task_loop_state.py --root .agents/task-loop` |
| `scripts/get_task_loop_statistics.py` / `invoke_task_loop_tick.py` | 状态统计与调度 Tick 入口 | `python scripts/invoke_task_loop_tick.py --root .` |

---

## 参考文档与资产

- 跨厂商会话 SDK 标准：[session-sdk-reference.md](references/session-sdk-reference.md)
- 派单与初始化契约：[dispatch-contract.md](references/dispatch-contract.md)
- 状态格式与字段规范：[work-item-schema.md](references/work-item-schema.md)
- 用户全局偏好配置：[user_preferences.json](config/user_preferences.json)
- 版本说明：[VERSION.md](VERSION.md)
- 架构图：[architecture.png](assets/architecture.png)
