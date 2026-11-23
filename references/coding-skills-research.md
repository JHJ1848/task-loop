# GitHub 热门编程 Skill 与插件调研

2026-11-17 调研。选取五个 GitHub 高关注项目，覆盖开发准则、缺陷诊断、测试驱动、代码审查和交付验证。星数为查询时 GitHub 仓库首页显示的约数，反映整个仓库的关注度。内容以仓库默认分支的 `SKILL.md` 和安装文档为准。

## 样本与做法

### Matt Pocock Skills · 约 326.0k stars

`diagnosing-bugs` 把可重复的失败信号放在排障开头，缩小复现后逐个验证假设，修复后回到原始场景。`tdd` 从公开接口验证可观察行为，按事先选定的边界逐个完成行为切片。`code-review` 给规范和需求符合性两组审查者同一份差异，分别核对。仓库提供 Codex 原生市场入口 `mattpocock-skills@mattpocock`，也提供独立 Skill 文件的安装方式。[仓库与安装](https://github.com/mattpocock/skills#installation-30-second-setup) · [排障](https://github.com/mattpocock/skills/blob/main/skills/engineering/diagnosing-bugs/SKILL.md) · [TDD](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md) · [审查](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md)

### Superpowers · 约 318.8k stars

`systematic-debugging` 分阶段追踪根因、识别正常模式、验证假设和实施修复。三次实际修复尝试都失败后，先检查共享状态、耦合和架构前提，再与用户讨论下一步。仓库说明 Codex App 与 CLI 均可从官方插件市场发现。 [仓库与 Codex 入口](https://github.com/obra/superpowers#codex-app) · [排障 Skill](https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md)

### ECC · 约 304.8k stars

`verification-loop` 检查构建、类型、Lint、测试、安全和差异。目标环境的验收单列，记录环境、版本、结果和证据，并明确未执行的项目。Codex 原生插件 `ecc@ecc` 一起分发 Skills、Hook 运行文件和其他资源，属于完整代理工具包。 [仓库与 Codex 入口](https://github.com/affaan-m/ECC#codex-app-and-cli) · [验证 Skill](https://github.com/affaan-m/ECC/blob/main/skills/verification-loop/SKILL.md)

### Karpathy Guidelines · 约 233.8k stars

准则要求先写出关键假设，将任务写成可检验的结果，以最小改动解决当次问题。多步工作可以给每步附一个检查点。仓库提供 Claude Code 市场插件、项目 `CLAUDE.md` 和 Cursor 规则三种载入方式，便于复用同一套行为指导。 [仓库与安装](https://github.com/multica-ai/andrej-karpathy-skills#install) · [指导 Skill](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md)

### Addy Osmani Agent Skills · 约 118.4k stars

`code-review-and-quality` 从正确性、可读性、架构、安全和性能看差异。报告问题前先沿调用方、守卫条件和已有验证核实可达性，区分基线缺陷和本次回归，并标明严重度。Codex 插件 `agent-skills@agent-skills` 通过清单读取仓库 `skills/` 目录。 [仓库与安装](https://github.com/addyosmani/agent-skills#quick-start) · [审查 Skill](https://github.com/addyosmani/agent-skills/blob/main/skills/code-review-and-quality/SKILL.md)

## 对 bugfix-dev 的建议

现有 Skill 已覆盖历史设计意图、根因说明、读写范围、性能取证和独立审查。建议沿现有流程补三个具体动作。 [当前 bugfix-dev](../skills/bugfix-dev/SKILL.md)

1. **先定义失败信号。** 在根因卡中记录公开入口、输入、触发条件和可观察结果。修复后用同一场景对照。当前项目可使用人工复现和已有的脱敏日志，遵循项目的自动测试约束。 [Matt 排障 Skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/diagnosing-bugs/SKILL.md)
2. **按失败类型回到前提。** 现有规则处理三次独立排查假设被排除的情况。若三次修复都未改变失败信号，另行复核架构假设和观察点，再决定后续方案。 [Superpowers 实施阶段](https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md#phase-4-implementation)
3. **让审查与验收可追查。** 给审查人差异基线、需求验收项和关键调用路径。记录问题的触发条件、是否属于本次回归，以及目标环境的实际验收证据或待验证项。 [Matt 审查 Skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md) · [Addy 审查 Skill](https://github.com/addyosmani/agent-skills/blob/main/skills/code-review-and-quality/SKILL.md) · [ECC 验收 Skill](https://github.com/affaan-m/ECC/blob/main/skills/verification-loop/SKILL.md)
