---
name: workflow
description: "开发、诊断或探索开始时，按目的选择最小执行流程和下一道确认门。"
---

# 选择工作流

- 目标、调用链或范围不清，交给 [explore](../explore/SKILL.md) 只读取证。
- 目标明确，需要开发、诊断或修复，交给 [bugfix-dev](../bugfix-dev/SKILL.md)。先核对目标或根因、修改范围和验收证据。
- 涉及跨专题交付，交给 [task-loop](../task-loop/SKILL.md)。用户要求独立开任务或派单时用 [create-task](../create-task/SKILL.md)。

只加载当前入口需要的规则。写入、审查和归档按授权及项目规范执行。需要交接时附依据、范围与下一步。
