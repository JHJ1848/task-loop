#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[Installer] Install task-loop into ZCode official local plugin workspace

把当前仓库（须为 ZCode 分支适配版）以快照方式复制到 ZCode 官方本地插件目录：
  默认目标: ~/.zcode/plugin-workspace/<plugin-name>/

设计动机: ZCode 客户端严禁直接引用 Git 工作区（分支切换会改变文件），
安装后客户端只引用 ~/.zcode 下的独立副本。

复制白名单（运行时必需集合，不含 tests/、docs/、AGENTS.md 等开发态内容）:
  dirs : .zcode-plugin  hooks  skills  rules  scripts  templates  references  config  assets
  files: plugin.json  hooks.json  SKILL.md  README.md  LICENSE

同时在目标根生成 marketplace.json（市场名 <plugin-name>-local），供 ZCode
客户端 Discover 页以"本地目录"形式添加市场并选择本插件。

Usage:
  python scripts/install_zcode_plugin.py                 # 安装到默认位置
  python scripts/install_zcode_plugin.py --dest <path>   # 自定义目标根（仍写入 <name>/ 子目录）
  python scripts/install_zcode_plugin.py --enable        # 额外写 config.json 的 enabledPlugins 开关（自动备份）
  python scripts/install_zcode_plugin.py --check         # 仅校验源仓库与预览计划，不复制
"""

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

COPY_DIRS = [
    ".zcode-plugin", "hooks", "skills", "rules", "scripts",
    "templates", "references", "config", "assets",
]
COPY_FILES = ["plugin.json", "hooks.json", "SKILL.md", "README.md", "LICENSE"]
MANIFEST_NAME_REGEX_OK = r"^[a-z0-9][a-z0-9._-]{0,127}$"
JUNK_ENTRY_NAMES = {"__pycache__", ".idea", ".DS_Store"}

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def resolve_source_root(source_root=None):
    root = Path(source_root or Path(__file__).resolve().parent.parent).resolve()
    manifest_path = root / ".zcode-plugin" / "plugin.json"
    if not manifest_path.is_file():
        raise RuntimeError(
            f"未找到 {manifest_path} ：请确认当前仓库为包含 ZCode 适配层 (.zcode-plugin/) 的分支后再执行安装。"
        )
    import re
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not re.match(MANIFEST_NAME_REGEX_OK, manifest.get("name", "")):
        raise RuntimeError(
            ".zcode-plugin/plugin.json 的 name 字段不满足 ZCode 清单正则 "
            "^[a-z0-9][a-z0-9._-]{0,127}$: \"%s\"" % manifest.get("name")
        )
    return root, manifest


def resolve_dest_root(dest_root, plugin_name):
    base = Path(dest_root).resolve() if dest_root else (
        Path.home() / ".zcode" / "plugin-workspace"
    )
    return base / plugin_name, base


def assert_no_overlap(source_root: Path, dest_base: Path):
    s = str(source_root).rstrip("\\/")
    d = str(dest_base).rstrip("\\/")
    if s.lower() == d.lower():
        raise RuntimeError(f"目标目录与源仓库相同 ({s}) ，拒绝安装。")
    low_s, low_d = s.lower(), d.lower()
    if low_d.startswith(low_s + "\\") or low_d.startswith(low_s + "/") or \
       low_s.startswith(low_d + "\\") or low_s.startswith(low_d + "/"):
        raise RuntimeError(f"目标目录 ({d}) 与源仓库 ({s}) 存在包含关系，拒绝安装以免自吞。")


def build_marketplace(plugin_name):
    return {
        "name": f"{plugin_name}-local",
        "description": f"{plugin_name} 本地插件市场（ZCode 分支引用源）。",
        "plugins": [
            {
                "name": plugin_name,
                "source": "./",
                "description": (
                    f"{plugin_name}: 会话感知注入、Allowlist 白名单硬门禁"
                    "与跨厂商会话反向内省（ZCode 宿主版）。"
                ),
            }
        ],
    }


JUNK_SUFFIXES = (".pyc",)


def _ignore_junk(directory, entries):
    ignored = []
    for entry in entries:
        if entry in JUNK_ENTRY_NAMES or entry.lower().endswith(JUNK_SUFFIXES):
            ignored.append(entry)
    return ignored


def strip_junk(dir_path: Path) -> int:
    removed = 0
    if not dir_path.exists():
        return removed
    for entry in list(dir_path.rglob("*")):
        if entry.name in JUNK_ENTRY_NAMES or entry.suffix.lower() in JUNK_SUFFIXES:
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)
            removed += 1
    return removed


def install_plugin(source_root=None, dest_root=None, check=False):
    root, manifest = resolve_source_root(source_root)
    plugin_name = manifest["name"]
    dest, dest_base = resolve_dest_root(dest_root, plugin_name)
    assert_no_overlap(root, dest_base)

    copied_dirs = [d for d in COPY_DIRS if (root / d).exists()]
    copied_files = [f for f in COPY_FILES if (root / f).is_file()]

    if check:
        return {
            "plugin_name": plugin_name,
            "dest": str(dest),
            "copied_dirs": copied_dirs,
            "copied_files": copied_files,
            "cleaned_entries": 0,
            "marketplace": build_marketplace(plugin_name),
            "dry_run": True,
        }

    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)

    for d in copied_dirs:
        shutil.copytree(
            root / d, dest / d,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".idea", ".DS_Store"),
        )
    for f in copied_files:
        shutil.copy2(root / f, dest / f)

    cleaned = strip_junk(dest)

    marketplace = build_marketplace(plugin_name)
    (dest / "marketplace.json").write_text(
        json.dumps(marketplace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    stamp = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    (dest / "EXPORT-INFO.md").write_text("\n".join([
        "# 导出副本说明",
        "",
        "- 用途: ZCode 本地插件市场引用源，避免引用 Git 工作区（分支切换会改变文件）。",
        f"- 来源仓库: {root}",
        "- 来源分支: 由执行时工作区决定（建议固定在 ZCode 分支导出）。",
        "- 导出方式: python scripts/install_zcode_plugin.py (工作区快照)",
        f"- 导出时间: {stamp}",
        f"- 市场清单: 根目录 marketplace.json (市场名 {marketplace['name']}, 插件 {plugin_name})。",
        "- 刷新方式: 在源仓库重新执行本脚本后在 ZCode 客户端重载插件。",
    ]) + "\n", encoding="utf-8")

    return {
        "plugin_name": plugin_name,
        "dest": str(dest),
        "copied_dirs": copied_dirs,
        "copied_files": copied_files,
        "cleaned_entries": cleaned,
        "marketplace": marketplace,
        "dry_run": False,
    }


def maybe_enable_flag(plugin_name, market_name):
    config_path = Path(os.environ.get("ZCODE_CLI_CONFIG") or
                       (Path.home() / ".zcode" / "cli" / "config.json"))
    if not config_path.is_file():
        print(f"--enable: 未找到 {config_path} ，跳过注册（可稍后在客户端界面手动启用）。")
        return False
    backup_path = config_path.with_suffix(config_path.suffix + ".bak-task-loop-install")
    shutil.copy2(config_path, backup_path)
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    plugins = cfg.setdefault("plugins", {})
    enabled = plugins.setdefault("enabledPlugins", {})
    enabled[f"{plugin_name}@{market_name}"] = True
    config_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
        f"     (该目录根部含 marketplace.json，市场名 {result['marketplace']['name']});",
        f"  3. 在市场列表中选择 {result['plugin_name']} 并点击 Install(安装)/Enable(启用);",
        "  4. 重启会话或 Reload(重载) 插件使 SessionStart/UserPromptSubmit/PreToolUse 生效.",
        "",
        "[Verify] 验证方式:",
        "  - Settings -> Plugin Management 中 task-loop 详情页各 Hook 显示为 runnable;",
        '  - 新会话任意一轮顶部出现 "[Plugin: task-loop | 会话上下文感知]" 注入;',
        "  - 刷新副本: 在源仓库重新执行本脚本即可整目录幂等覆盖.",
    ]
    print("\n".join(lines))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Install task-loop into the ZCode local plugin workspace.")
    parser.add_argument("--dest", default=None, help="自定义目标根目录（仍写入 <plugin-name>/ 子目录）")
    parser.add_argument("--check", "--dry-run", action="store_true", help="仅校验与预览计划，不写文件")
    parser.add_argument("--enable", action="store_true", help="额外注册 config.json 的 enabledPlugins 开关（自动备份）")
    args = parser.parse_args(argv)

    try:
        result = install_plugin(dest_root=args.dest, check=args.check)
    except Exception as err:
        print(f"[Install FAIL] {err}", file=sys.stderr)
        return 1

    if args.check:
        print("[Check] 源仓库校验通过，安装计划如下（未写入任何文件）:")
        print(f"  目标: {result['dest']}")
        print(f"  目录: {', '.join(result['copied_dirs'])}")
        print(f"  文件: {', '.join(result['copied_files'])}")
        print(f"  市场: {result['marketplace']['name']}")
        return 0

    print(f"[Copy] dirs={len(result['copied_dirs'])} files={len(result['copied_files'])} junkPruned={result['cleaned_entries']}")
    if args.enable:
        maybe_enable_flag(result["plugin_name"], result["marketplace"]["name"])
    else:
        print("[Hint] 未使用 --enable 时，请在客户端市场中手动 Install 后即为启用状态.")
    print_next_steps(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
