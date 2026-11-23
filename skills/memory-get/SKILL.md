---
name: memory-get
plugin: session-memory-workflow
description: "[session-memory-workflow] 只读获取任务所需的项目规则、专题知识或历史变更。"
---

# 读取项目记忆

先读项目规则与 `docs/MEMORY.md` 的匹配项。按需追到专题、API 或变更记录。保留来源，区分已确认事实与推测。

```text
node <PLUGIN_ROOT>/skills/project-memory/scripts/project-memory.js get --project-root <项目根> --query <关键词> --task <任务ID>
```

指定文档用 `--target`，需要结构时用 `--tree`。旧记忆经确认保留时用 `--mode keep` 只读查询。返回 `not_ready` 时报告缺口，初始化或迁移走 `memory-init`。按需读[检索契约](references/framework-and-retrieval.md)。
