---
name: session-gotcha-extractor
description: "从已证实的开发或排障结果中提炼可复用的避坑条目。"
---

# 提炼避坑条目

用户要求沉淀经验，或开发排查发现可复用的已证实陷阱时，记录场景、误判、原因和处理约束。选择 `bugfix`、`dev` 或 `explore` 分类，排除凭据和推测。

- 项目专属经验用 `--scope project --project-root <项目根>`，写项目的 `.agents/gotchas.jsonl`。
- 可跨项目复用的经验用 `--scope global`，写用户的 `~/.agents/gotchas.jsonl`。

从插件根运行 `node skills/session-gotcha-extractor/scripts/gotcha.js append`。必填字段见[条目契约](references/gotcha-contract.md)。正式项目架构事实走 `memory-put`。
