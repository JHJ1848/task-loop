---
name: explore
description: "只读澄清目标、调用链、业务逻辑、历史意图或依赖边界。"
---

# 只读探索

1. 用 [memory-get](../memory-get/SKILL.md) 取相关约束与历史，再沿真实入口、输入、调用链与状态核对事实。
2. 按需检查外部组件与本地代码的边界。记录证据、未知项及能区分候选结论的下一步。
3. 输出简短的现状、证据、未知项和建议。需进入实施时先对齐目标、白名单与授权，再用 [bugfix-dev](../bugfix-dev/SKILL.md)。

复杂场景选读[探索手册](references/exploration-playbook.md)或[报告卡](references/exploration-report-card.md)。
