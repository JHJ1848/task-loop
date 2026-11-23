---
name: memory-put
plugin: session-memory-workflow
description: "[session-memory-workflow] 经用户确认后归档已证实的架构、功能变更或排障记录。"
---

# 归档项目记忆

先核对归档价值、受管临时证据和现有专题文档。输出只保留问题、原因、测试结果和必要备注。脱去密钥、完整日志和代码。跨项目通用经验用 `session-gotcha-extractor`。

```text
node <PLUGIN_ROOT>/skills/project-memory/scripts/project-memory.js put --project-root <项目根> --task <任务ID> --title <标题> --summary <摘要> --value <high|medium> --target docs/change/<专题>/<记录>.md --confirmed
```

以 `archived` 回执及更新索引核对落盘。缺少授权、证据或专题文档时停止写入。格式、草稿和兼容边界见[归档契约](references/archival-contract.md)。
