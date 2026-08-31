#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[task-loop] Install task-loop Plugin into ZCode Workspace (Python twin)

自动化打包/复制本项目为符合 ZCode 插件规范的独立目录副本，
放置在 ~/.zcode/plugin-workspace/task-loop (或指定的 --dest 路径)。
"""

import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

MANIFEST_NAME_REGEX = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")

COPY_DIRS = [
    ".zcode-plugin",
    "hooks",
    "skills",
    "scripts",
    "templates",
    "references",
    "config",
]

COPY_FILES = [
    "plugin.json",
    "hooks.json",
    "SKILL.md",
    "README.md",
]

JUNK_ENTRY_NAMES = {"__pycache__", ".idea", ".DS_Store"}


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def resolve_source_root(source_root=None):
    root = os.path.abspath(source_root or os.path.join(os.path.dirname(__file__), ".."))
    manifest_path = os.path.join(root, ".zcode-plugin", "plugin.json")
    if not os.path.exists(manifest_path):
        raise RuntimeError(
            f"未找到 {manifest_path} ：请确认当前仓库包含 ZCode 适配层 (.zcode-plugin/)。"
        )
    manifest = read_json(manifest_path)
    name = manifest.get("name", "")
    if not MANIFEST_NAME_REGEX.match(name):
        raise RuntimeError(
            f".zcode-plugin/plugin.json 的 name 字段不满足 ZCode 清单正则 ^[a-z0-9][a-z0-9._-]{{0,127}}$: '{name}'"
        )
    return root, manifest


def resolve_dest_root(dest_root=None, plugin_name="task-loop"):
    workspace_default = os.path.join(os.path.expanduser("~"), ".zcode", "plugin-workspace")
    base = os.path.abspath(dest_root) if dest_root else workspace_default
    return os.path.join(base, plugin_name)


def assert_no_overlap(source_root, dest_root):
    s = os.path.abspath(source_root).rstrip("\\/")
    d = os.path.abspath(dest_root).rstrip("\\/")
    if s == d:
        raise RuntimeError(f"目标目录与源仓库相同 ({s}) ，拒绝安装。")
    if d.startswith(s + os.sep) or s.startswith(d + os.sep):
        raise RuntimeError(f"目标目录 ({d}) 与源仓库 ({s}) 存在包含关系，拒绝安装以免自吞。")


def build_marketplace(plugin_name):
    return {
        "name": f"{plugin_name}-local",
        "description": f"{plugin_name} 本地插件市场（ZCode 宿主引用源）。",
        "plugins": [
            {
                "name": plugin_name,
                "source": "./",
                "description": f"{plugin_name}: 会话感知注入、Allowlist 白名单硬门禁与跨厂商会话反向内省（ZCode 宿主版）。",
            }
        ],
    }


def strip_junk(directory):
    removed = 0
    for root, dirs, files in os.walk(directory, topdown=False):
        for name in list(dirs):
            if name in JUNK_ENTRY_NAMES:
                full = os.path.join(root, name)
                shutil.rmtree(full, ignore_errors=True)
                removed += 1
        for name in files:
            if name in JUNK_ENTRY_NAMES or name.endswith(".pyc"):
                full = os.path.join(root, name)
                try:
                    os.remove(full)
                    removed += 1
                except OSError:
                    pass
    return removed


def install_plugin(source_root=None, dest_root=None, check=False, enable=False):
    root, manifest = resolve_source_root(source_root)
    plugin_name = manifest["name"]
    dest = resolve_dest_root(dest_root, plugin_name)

    workspace_base = os.path.abspath(dest_root) if dest_root else os.path.join(os.path.expanduser("~"), ".zcode", "plugin-workspace")
    assert_no_overlap(root, workspace_base)

    copied_dirs = []
    copied_files = []

    if not check:
        if os.path.exists(dest):
            shutil.rmtree(dest, ignore_errors=True)
        os.makedirs(dest, exist_ok=True)

    for d in COPY_DIRS:
        src_dir = os.path.join(root, d)
        if not os.path.exists(src_dir):
            continue
        if check:
            copied_dirs.append(d)
            continue
        dst_dir = os.path.join(dest, d)

        def _ignore(folder, names):
            return {n for n in names if n in JUNK_ENTRY_NAMES or n.endswith(".pyc")}

        shutil.copytree(src_dir, dst_dir, ignore=_ignore)
        copied_dirs.append(d)

    for f in COPY_FILES:
        src_file = os.path.join(root, f)
        if not os.path.exists(src_file):
            continue
        if not check:
            shutil.copy2(src_file, os.path.join(dest, f))
        copied_files.append(f)

    marketplace = build_marketplace(plugin_name)
    if check:
        return {
            "plugin_name": plugin_name,
            "dest": dest,
            "copied_dirs": copied_dirs,
            "copied_files": copied_files,
            "cleaned_entries": 0,
            "marketplace": marketplace,
            "dry_run": True,
        }

    cleaned = strip_junk(dest)
    with open(os.path.join(dest, "marketplace.json"), "w", encoding="utf-8") as fh:
        json.dump(marketplace, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    stamp = datetime.now(timezone.utc).isoformat()
    with open(os.path.join(dest, "EXPORT-INFO.md"), "w", encoding="utf-8") as fh:
        fh.write(
            "\n".join([
                "# 导出副本说明",
                "",
                "- 用途: ZCode 本地插件市场引用源，避免引用 Git 工作区（分支切换会改变文件）。",
                f"- 来源仓库: {root}",
                "- 来源分支: master 单主干统一仓库。",
                "- 导出方式: python scripts/install_zcode_plugin.py (工作区快照)",
                f"- 导出时间: {stamp}",
                f"- 市场清单: 根目录 marketplace.json (市场名 {marketplace['name']}, 插件 {plugin_name})。",
                "- 刷新方式: 在源仓库重新执行本脚本后在 ZCode 客户端重载插件。",
                "",
            ])
        )

    return {
        "plugin_name": plugin_name,
        "dest": dest,
        "copied_dirs": copied_dirs,
        "copied_files": copied_files,
        "cleaned_entries": cleaned,
        "marketplace": marketplace,
        "dry_run": False,
    }


def maybe_enable_flag(plugin_name, market_name):
    config_path = os.environ.get("ZCODE_CLI_CONFIG") or os.path.join(
        os.path.expanduser("~"), ".zcode", "cli", "config.json"
    )
    if not os.path.exists(config_path):
        print(f"--enable: 未找到 {config_path} ，跳过注册（可稍后在客户端界面手动启用）。")
        return False
    backup_path = f"{config_path}.bak-task-loop-install"
    shutil.copy2(config_path, backup_path)
    cfg = read_json(config_path)
    cfg.setdefault("plugins", {}).setdefault("enabledPlugins", {})[
        f"{plugin_name}@{market_name}"
    ] = True
    with open(config_path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"--enable: 已注册 {plugin_name}@{market_name}=true （原配置备份于 {backup_path} ）。")
    return True


def print_next_steps(result):
    lines = [
        "",
        "[Install OK] task-loop 已安装至 ZCode 官方本地插件目录:",
        f"  {result['dest']}",
        "",
        "[Next] 请在 ZCode 客户端完成最后一步加载:",
        "  1. 打开 Settings(设置) -> Plugin Management(插件管理) -> Discover(发现) 页;",
        "  2. 点击 [+] 添加本地市场，目录选择:",
        f"     {result['dest']}",
        "     (该目录根部含 marketplace.json，市场名 " + result["marketplace"]["name"] + ");",
        f"  3. 在市场列表中选择 {result['plugin_name']} 并点击 Install(安装)/Enable(启用);",
        "  4. 重启会话或 Reload(重载) 插件使 SessionStart/UserPromptSubmit/PreToolUse 生效.",
        "",
        "[Verify] 验证方式:",
        "  - Settings -> Plugin Management 中 task-loop 详情页各 Hook 显示为 runnable;",
        "  - 新会话任意一轮顶部出现 '[Plugin: task-loop | 会话上下文感知]' 注入;",
        "  - 刷新副本: 在源仓库重新执行本脚本即可整目录幂等覆盖.",
    ]
    print("\n".join(lines))


def main():
    args = sys.argv[1:]
    dest_root = None
    if "--dest" in args:
        idx = args.index("--dest")
        if idx + 1 < len(args):
            dest_root = args[idx + 1]
    check = "--check" in args or "--dry-run" in args
    enable = "--enable" in args

    try:
        result = install_plugin(dest_root=dest_root, check=check, enable=enable)
        if check:
            print("[Check] 源仓库校验通过，安装计划如下（未写入任何文件）:")
            print(f"  目标: {result['dest']}")
            print(f"  目录: {', '.join(result['copied_dirs'])}")
            print(f"  文件: {', '.join(result['copied_files'])}")
            print(f"  市场: {result['marketplace']['name']}")
            return 0
        print(
            f"[Copy] dirs={len(result['copied_dirs'])} files={len(result['copied_files'])} junkPruned={result['cleaned_entries']}"
        )
        if enable:
            maybe_enable_flag(result["plugin_name"], result["marketplace"]["name"])
        else:
            print("[Hint] 未使用 --enable 时，请在客户端市场中手动 Install 后即为启用状态.")
        print_next_steps(result)
        return 0
    except Exception as err:
        print(f"[Install FAIL] {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
