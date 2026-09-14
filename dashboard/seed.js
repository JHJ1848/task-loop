// ==========================================
// task-loop 控制面板默认内置种子数据 (Zero-Dep Seed Data)
// ==========================================
window.DEFAULT_SESSIONS = {
  "schema_version": 4,
  "updated_at": "2026-09-09T10:15:39.470Z",
  "vendors": {
    "antigravity": {
      "schema_version": 3,
      "vendor": "antigravity",
      "main_thread_id": "ee94b2c5-c0c2-473f-8f71-213250ba5295",
      "updated_at": "2026-09-08T09:20:00.000Z",
      "modules": {
        "main": {
          "session_id": "ee94b2c5-c0c2-473f-8f71-213250ba5295",
          "title": "[主会话] 任务编排 & 治理中枢",
          "tags": ["main", "orchestrator"],
          "memory_doc": "docs/MEMORY.md",
          "vendor": "antigravity",
          "resumable": true,
          "summary": "治理中枢与门禁质检"
        },
        "session_control": {
          "session_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
          "title": "[Session] SDK & Scripting",
          "tags": ["session_control", "topic"],
          "memory_doc": "docs/memory/session_control.md",
          "vendor": "antigravity",
          "resumable": true,
          "summary": "跨厂商会话日志反向内省与六大标准原语"
        },
        "hook": {
          "session_id": "1057c10a-523d-47a4-858e-eabeaa784932",
          "title": "[钩子专题] 生命周期 & 安全门禁",
          "tags": ["hook", "topic"],
          "memory_doc": "docs/memory/hook.md",
          "vendor": "antigravity",
          "resumable": true,
          "summary": "生命周期钩子与 Allowlist 白名单物理拦截"
        },
        "subagent": {
          "session_id": "83bae782-1e95-4923-a76f-2141fe8c5c61",
          "title": "[子代理专题] Subagent机制 & 动态模板",
          "tags": ["subagent", "topic"],
          "memory_doc": "docs/memory/subagent.md",
          "vendor": "antigravity",
          "resumable": true,
          "summary": "AGY 原生子代理编排原语与瞬态沙箱生命周期"
        },
        "plugin_spec": {
          "session_id": "da7311b9-7b54-4d9e-8fa5-22e7ba3b7c0b",
          "title": "[插件专题] 多厂商插件规范与导出安装",
          "tags": ["plugin_spec", "topic"],
          "memory_doc": "docs/memory/plugin_spec.md",
          "vendor": "antigravity",
          "resumable": true,
          "summary": "规范导出、双目录同步与多宿主适配"
        },
        "dashboard": {
          "session_id": "b86d3f08-fd8d-4dc9-aaeb-8ed1608f674d",
          "title": "[控制面板专题] 状态监控 & 拖拽交互 (dashboard)",
          "tags": ["dashboard", "topic"],
          "memory_doc": "docs/memory/dashboard.md",
          "vendor": "antigravity",
          "resumable": true,
          "summary": "专题模块: [控制面板专题] 状态监控 & 拖拽交互 (dashboard)"
        }
      }
    },
    "zcode": {
      "schema_version": 3,
      "vendor": "zcode",
      "main_thread_id": "sess_5625de9f-b41d-415a-9b8c-c9304bb29748",
      "updated_at": "2026-09-01T02:49:32.407Z",
      "modules": {
        "main": {
          "session_id": "sess_5625de9f-b41d-415a-9b8c-c9304bb29748",
          "title": "[主会话] 任务编排 & 治理中枢",
          "tags": ["main", "orchestrator"],
          "memory_doc": "docs/MEMORY.md",
          "vendor": "zcode",
          "resumable": true,
          "summary": "ZCode 治理主会话"
        },
        "session_control": {
          "session_id": "sess_zcode_session_ctrl",
          "title": "[专题] 会话控制与内省",
          "tags": ["session_control", "topic"],
          "memory_doc": "docs/memory/session_control.md",
          "vendor": "zcode",
          "resumable": true,
          "summary": "ZCode db.sqlite 与 rollout 日志反向检索"
        }
      }
    },
    "codex": {
      "schema_version": 3,
      "vendor": "codex",
      "main_thread_id": "thread_codex_main_sample",
      "modules": {
        "main": {
          "session_id": "thread_codex_main_sample",
          "title": "[主会话] 任务编排 & 治理中枢",
          "vendor": "codex",
          "resumable": true,
          "summary": "Codex App Server 中枢会话"
        }
      }
    },
    "claude": {
      "schema_version": 3,
      "vendor": "claude",
      "main_thread_id": "11111111-2222-3333-4444-555555555555",
      "modules": {
        "main": {
          "session_id": "11111111-2222-3333-4444-555555555555",
          "title": "[主会话] 任务编排 & 治理中枢",
          "vendor": "claude",
          "resumable": true,
          "summary": "Claude Code -p 无头中枢"
        }
      }
    }
  }
};

window.DEFAULT_TODO = {
  "schema_version": 2,
  "items": [
    {
      "id": "task-001",
      "title": "优化测试与质检分流: 杜绝强前端交互形式化单测",
      "objective": "建立后端算法单测自证与强前端交互页面刷新验证指引卡的分流矩阵",
      "status": "done",
      "complexity": 2,
      "verification_mode": "unit_test",
      "assignee_thread_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
      "allowlist": ["references/dispatch-contract.md"],
      "created_at": "2026-09-06T10:00:00Z"
    },
    {
      "id": "task-002",
      "title": "重构控制面板 UI: 极简黑白底 + 红蓝绿 + 双语",
      "objective": "单文件无依赖，SVG图标替代文字，支持中英文双语一键无缝切换与本地记忆",
      "status": "in_progress",
      "complexity": 2,
      "verification_mode": "ui_reload",
      "assignee": "dashboard",
      "assignee_thread_id": "1057c10a-523d-47a4-858e-eabeaa784932",
      "allowlist": [
        "scripts/hooks/inject_session_context.js",
        "references/dispatch-contract.md"
      ],
      "created_at": "2026-09-07T08:14:00Z"
    },
    {
      "id": "task-003",
      "title": "术语机制升级: 看门狗 -> 进度监测器 + 巡检任务",
      "objective": "废止陈旧生硬的看门狗词汇，全面升级为双阶梯进度监测与巡检机制",
      "status": "done",
      "complexity": 2,
      "verification_mode": "unit_test",
      "assignee": "session_control",
      "assignee_thread_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
      "allowlist": ["scripts/inspect_agy_sessions.js"],
      "created_at": "2026-09-08T02:57:00Z"
    },
    {
      "id": "task-004",
      "title": "跨厂商会话历史聚合分析 CLI 优化",
      "objective": "对拍四大厂商会话扫描器输出 Schema 并规范化输出格式",
      "status": "pending",
      "complexity": 1,
      "verification_mode": "unit_test",
      "assignee": "",
      "assignee_thread_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
      "allowlist": ["scripts/find_project_sessions.js"],
      "created_at": "2026-09-10T03:00:00Z"
    }
  ]
};

window.DEFAULT_POLICY = {
  "schema_version": 1,
  "active_vendor": "antigravity",
  "lease_minutes": 25,
  "allow_remote_push": false,
  "model_profiles": {
    "simple": "gpt-5.6-luna",
    "standard": "gpt-5.6-terra",
    "complex": "gpt-5.6-sol"
  }
};

window.DEFAULT_LEASE = {
  "holder": null,
  "acquired_at": null,
  "expires_at": null,
  "status": "UNLOCKED"
};
