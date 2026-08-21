# Universal Task Loop State Format

所有路径相对于项目根目录，默认存放在被 Git 忽略的 `.agents/task-loop/`（向下兼容 `.codex/task-loop/`）：

| 文件 | 所有者 | 用途 |
|---|---|---|
| `todo.json` | main | 用户事项、标准化目标、Q&A 和生命周期状态。 |
| `sessions.json` | main | `main_thread_id`、模块键、会话 ID、标签/功能简述与模块记忆相对路径。 |
| `topics.json` | main | 专题文档、模块键和长期专题会话标题的声明式来源。 |
| `policy.json` | main | 节奏策略、活动厂商配置（`active_vendor`）、租约时长与模型分级配置。 |
| `lease.json` | lease 持有者 | 当前单一派发的原子锁，防止多会话写入冲突。 |
| `run-journal.jsonl` | main | 调度扫描、状态流转、阻塞与派单证据。 |

---

## `sessions.json` 结构规范（支持会话打标与功能映射）

```json
{
  "schema_version": 1,
  "main_thread_id": "4e31cfaa-7d44-4bd1-83d9-f1d617978df2",
  "modules": {
    "md-preview": {
      "thread_id": "3201e08e-c506-4a85-9a3b-18f0a975b7e8",
      "title": "md-preview-MarkdownPreview",
      "title_prefix": "md-preview-",
      "tags": ["markdown", "preview", "web-view", "controller"],
      "summary": "负责 Markdown 文件的解析、预览控制器及前端页面展示",
      "memory_docs": ["docs/memory/md-preview.md"],
      "log_path": "C:/Users/.../transcript.jsonl"
    },
    "electron-desktop": {
      "thread_id": "d85bf8d9-f8e2-4acc-9842-b41b5c3fd28e",
      "title": "electron-desktop-AppShell",
      "title_prefix": "electron-desktop-",
      "tags": ["electron", "ipc", "desktop-shell", "window-control"],
      "summary": "负责桌面端 Electron 主进程、IPC 通信与窗口控制",
      "memory_docs": ["docs/memory/electron-desktop.md"],
      "log_path": "C:/Users/.../transcript.jsonl"
    }
  }
}
```

---

## 1/2/3 复杂度分级与 Subagent 策略

| 复杂度等级 (`complexity`) | 语义别名 | 子代理策略 (`subagent_policy`) | 派发与执行规则 |
|---|---|---|---|
| **`1`** | `simple` | `none` | **极速直发**：直接派发到专题会话单线程执行，无需复杂 Q&A，快速修改并验证闭环。 |
| **`2`** | `standard` | `optional` | **标准派发**：专题会话在边界内执行标准开发、验证与专题记忆回写。按需由专题决定是否启动子代理。 |
| **`3`** | `complex` | `mandatory` | **强制 Subagent 编排**：跨模块或重构任务，专题会话作为调度中枢，**必须**调用 `invoke_subagent` 拆分 Research/Worker/Reviewer 子代理并行处理。 |
