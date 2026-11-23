---
name: project-memory
plugin: session-memory-workflow
description: "[session-memory-workflow] 查找项目记忆入口、存放路径或任务证据管理方式。"
---

# 项目记忆

- 初始化或建档用 [memory-init](../memory-init/SKILL.md)，读取用 [memory-get](../memory-get/SKILL.md)，获授权后归档用 [memory-put](../memory-put/SKILL.md)。
- `docs/MEMORY.md` 是索引，`docs/memory/` 存专题事实，`docs/api/` 存接口契约，`docs/change/` 存单次变更。
- 临时证据归入 `.agents/project-memory/temp/<task>/`。使用 `skills/project-memory/scripts/project-memory.js` 的 `temp`、`draft`、`path`、`rotate` 或 `cleanup`，调用时指定目标 `--project-root`。归档前核对证据和用户授权。
