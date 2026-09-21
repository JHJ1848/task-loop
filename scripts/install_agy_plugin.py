#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[Installer] Install task-loop into Google Antigravity (AGY) official plugins directory

把当前仓库以标准快照方式安装与同步至 Antigravity 官方用户插件目录：
  默认目标: ~/.gemini/config/plugins/<plugin-name>/

核心功能与安全防护:
1. 冲突排查与防死锁清理:
   - 自动排查并清理历史遗留的 ~/.gemini/antigravity/plugins/task-loop (双副本死锁根因);
   - 自动排查并清理历史遗留的 ~/.gemini/config/skills/task-loop (旧技能冲突);
   - 严禁触碰或删除持久化数据目录 ~/.gemini/antigravity/plugin_data/ 与项目 .agents/。
2. 白名单快照同步:
   - dirs : skills, rules, scripts, templates, references, config, assets, .claude-plugin
   - files: plugin.json, hooks.json, marketplace.json, SKILL.md, README.md, LICENSE
3. 插件健康校验 (Validation):
   - 验证 6 大核心 Skill (task-loop, session-control, subagent, hook, init, new-session);
   - 验证 2 大核心 Hook (session-context-injector, allowlist-safety-gate);
   - 若系统已安装 agy CLI，尝试调用 agy plugin validate 进行官方验证。
"""

import os
import sys
import json
import shutil
import subprocess
from datetime import datetime

# 强制标准输出与标准错误使用 UTF-8 编码，防止 Windows 控制台乱码
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

COPY_DIRS = [
    'skills', 'rules', 'scripts', 'templates', 'references',
    'config', 'assets', '.claude-plugin'
]
COPY_FILES = ['plugin.json', 'hooks.json', 'marketplace.json', 'SKILL.md', 'README.md', 'LICENSE']
REQUIRED_SKILLS = ['task-loop', 'session-control', 'subagent', 'hook', 'init', 'new-session']
JUNK_ENTRY_NAMES = {'__pycache__', '.idea', '.DS_Store', 'tests'}


def read_json(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def resolve_source_root(source_root=None):
    root = os.path.abspath(source_root or os.path.join(os.path.dirname(__file__), '..'))
    manifest_path = os.path.join(root, 'plugin.json')
    if not os.path.exists(manifest_path):
        raise RuntimeError(f"未找到 {manifest_path} ：请确认在 task-loop 仓库根目录下执行。")
    manifest = read_json(manifest_path)
    if not manifest.get('name'):
        raise RuntimeError("plugin.json 缺少 name 字段")
    return root, manifest


def resolve_dest_root(dest_root, plugin_name):
    config_plugins_dir = os.path.join(os.path.expanduser('~'), '.gemini', 'config', 'plugins')
    base = os.path.abspath(dest_root) if dest_root else config_plugins_dir
    return os.path.join(base, plugin_name)


def assert_no_overlap(source_root, dest_root):
    s = os.path.abspath(source_root).rstrip('\\/')
    d = os.path.abspath(dest_root).rstrip('\\/')
    if s == d:
        raise RuntimeError(f"目标目录与源仓库相同 ({s}) ，拒绝安装。")
    if d.startswith(s + os.sep) or s.startswith(d + os.sep):
        raise RuntimeError(f"目标目录 ({d}) 与源仓库 ({s}) 存在包含关系，拒绝安装以免自吞。")


def detect_legacy_deadlocks(plugin_name):
    deadlocks = []
    home = os.path.expanduser('~')

    # 1. 旧版硬编码插件目录 (导致双副本死锁)
    legacy_plugin_dir = os.path.join(home, '.gemini', 'antigravity', 'plugins', plugin_name)
    if os.path.exists(legacy_plugin_dir):
        deadlocks.append({
            'type': 'legacy_plugin_dir',
            'path': legacy_plugin_dir,
            'description': '历史旧版插件目录 (优先加载会导致更新不生效，需清理)'
        })

    # 2. 旧版独立技能目录
    legacy_skill_dir = os.path.join(home, '.gemini', 'config', 'skills', plugin_name)
    if os.path.exists(legacy_skill_dir):
        deadlocks.append({
            'type': 'legacy_skill_dir',
            'path': legacy_skill_dir,
            'description': '历史旧版独立 Skill 目录 (可能覆盖插件内置技能，需清理)'
        })

    return deadlocks


def strip_junk(directory):
    removed = 0
    if not os.path.exists(directory):
        return 0
    for root, dirs, files in os.walk(directory, topdown=False):
        for name in dirs:
            if name in JUNK_ENTRY_NAMES:
                full_path = os.path.join(root, name)
                shutil.rmtree(full_path, ignore_errors=True)
                removed += 1
        for name in files:
            if name.endswith('.pyc') or name.endswith('.tmp') or name in JUNK_ENTRY_NAMES:
                full_path = os.path.join(root, name)
                try:
                    os.remove(full_path)
                    removed += 1
                except Exception:
                    pass
    return removed


def validate_installed_plugin(dest):
    issues = []

    # 1. 验证 manifest
    manifest_path = os.path.join(dest, 'plugin.json')
    if not os.path.exists(manifest_path):
        issues.append('缺失 plugin.json')
    else:
        try:
            manifest = read_json(manifest_path)
            if manifest.get('name') != 'task-loop':
                issues.append(f"plugin.json name 异常: {manifest.get('name')}")
        except Exception as e:
            issues.append(f"plugin.json 语法损坏: {str(e)}")

    # 2. 验证 hooks.json
    hooks_path = os.path.join(dest, 'hooks.json')
    if not os.path.exists(hooks_path):
        issues.append('缺失 hooks.json')
    else:
        try:
            hooks = read_json(hooks_path)
            if 'session-context-injector' not in hooks:
                issues.append('hooks.json 缺失 session-context-injector')
            if 'allowlist-safety-gate' not in hooks:
                issues.append('hooks.json 缺失 allowlist-safety-gate')
        except Exception as e:
            issues.append(f"hooks.json 语法损坏: {str(e)}")

    # 3. 验证 6 大 Skills
    for skill in REQUIRED_SKILLS:
        skill_md = os.path.join(dest, 'skills', skill, 'SKILL.md')
        if not os.path.exists(skill_md):
            issues.append(f"缺失 skills/{skill}/SKILL.md")

    return {
        'valid': len(issues) == 0,
        'issues': issues
    }


def install_agy_plugin(options=None):
    options = options or {}
    root, manifest = resolve_source_root(options.get('sourceRoot'))
    plugin_name = manifest['name']
    dest = resolve_dest_root(options.get('destRoot'), plugin_name)

    assert_no_overlap(root, dest)

    dry_run = options.get('check') is True
    deadlocks = detect_legacy_deadlocks(plugin_name)
    cleaned_deadlocks = []

    copied_dirs = []
    copied_files = []

    if dry_run:
        for d in COPY_DIRS:
            if os.path.exists(os.path.join(root, d)):
                copied_dirs.append(d)
        for f in COPY_FILES:
            if os.path.exists(os.path.join(root, f)):
                copied_files.append(f)
        return {
            'pluginName': plugin_name,
            'source': root,
            'dest': dest,
            'deadlocks': deadlocks,
            'cleanedDeadlocks': cleaned_deadlocks,
            'copiedDirs': copied_dirs,
            'copiedFiles': copied_files,
            'dryRun': True
        }

    # 1. 清理死锁冲突目录
    for item in deadlocks:
        try:
            if os.path.isdir(item['path']):
                shutil.rmtree(item['path'], ignore_errors=True)
            else:
                os.remove(item['path'])
            cleaned_deadlocks.append(item)
        except Exception as e:
            print(f"[Warn] 清理死锁目录失败: {item['path']} ({e})", file=sys.stderr)

    # 2. 快照同步至目标目录
    if os.path.exists(dest):
        shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest, exist_ok=True)

    for d in COPY_DIRS:
        src_dir = os.path.join(root, d)
        if not os.path.exists(src_dir):
            continue
        dest_dir = os.path.join(dest, d)
        shutil.copytree(src_dir, dest_dir, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.idea'))
        copied_dirs.append(d)

    for f in COPY_FILES:
        src_file = os.path.join(root, f)
        if not os.path.exists(src_file):
            continue
        shutil.copy2(src_file, os.path.join(dest, f))
        copied_files.append(f)

    junk_pruned = strip_junk(dest)

    # 3. 写入导出元数据
    stamp = datetime.now().isoformat()
    with open(os.path.join(dest, 'EXPORT-INFO.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join([
            '# Antigravity 插件导出副本说明',
            '',
            f"- 插件名称: {plugin_name}",
            f"- 插件版本: {manifest.get('version', '1.6.0')}",
            f"- 来源仓库: {root}",
            f"- 安装目标: {dest}",
            f"- 安装时间: {stamp}",
            '- 刷新方式: 在 task-loop 仓库根目录下重新运行 python scripts/install_agy_plugin.py 即可覆盖更新。',
            ''
        ]))

    # 4. 健康验证
    validation = validate_installed_plugin(dest)

    # 5. 尝试运行 agy CLI validate (可选)
    agy_cli_result = None
    try:
        cli_check = subprocess.run(['agy', '--version'], capture_output=True, text=True, encoding='utf-8', errors='replace', shell=True)
        if cli_check.returncode == 0:
            val_res = subprocess.run(['agy', 'plugin', 'validate', dest], capture_output=True, text=True, encoding='utf-8', errors='replace', shell=True)
            agy_cli_result = {
                'available': True,
                'exitCode': val_res.returncode,
                'output': (val_res.stdout or val_res.stderr or '').strip()
            }
    except Exception:
        pass

    return {
        'pluginName': plugin_name,
        'source': root,
        'dest': dest,
        'deadlocks': deadlocks,
        'cleanedDeadlocks': cleaned_deadlocks,
        'copiedDirs': copied_dirs,
        'copiedFiles': copied_files,
        'junkPruned': junk_pruned,
        'validation': validation,
        'agyCliResult': agy_cli_result,
        'dryRun': False
    }


def print_report(res):
    if res.get('dryRun'):
        print('================================================================================')
        print('[Antigravity Plugin Installer] 预检计划 (Dry Run)')
        print('================================================================================')
        print(f"源仓库路径: {res['source']}")
        print(f"目标安装路径: {res['dest']}")
        print(f"待复制目录: {', '.join(res['copiedDirs'])}")
        print(f"待复制文件: {', '.join(res['copiedFiles'])}")
        if res['deadlocks']:
            print('\n[检测到历史死锁/冲突目录 (执行安装时将自动安全清理)]:')
            for idx, d in enumerate(res['deadlocks']):
                print(f"  {idx + 1}. [{d['type']}] {d['path']} ({d['description']})")
        else:
            print('\n[死锁检测]: 未发现历史冲突目录，环境健康。')
        return

    print('================================================================================')
    print('[Antigravity Plugin Installer] 安装与同步成功！')
    print('================================================================================')
    print(f"插件名称: {res['pluginName']}")
    print(f"安装路径: {res['dest']}")
    print(f"已复制目录 ({len(res['copiedDirs'])}): {', '.join(res['copiedDirs'])}")
    print(f"已复制文件 ({len(res['copiedFiles'])}): {', '.join(res['copiedFiles'])}")
    print(f"清理冗余项: {res['junkPruned']}")

    if res['cleanedDeadlocks']:
        print('\n[已成功清理历史死锁/冲突目录]:')
        for idx, d in enumerate(res['cleanedDeadlocks']):
            print(f"  {idx + 1}. {d['path']}")

    print('\n[插件健康校验 (Plugin Health Check)]:')
    if res['validation']['valid']:
        print('  ✔ 核心 Manifest、2 大 Hooks 与 6 大 Skills 结构完整无损！')
    else:
        print('  ✖ 发现异常项:')
        for issue in res['validation']['issues']:
            print(f"    - {issue}")

    if res['agyCliResult'] and res['agyCliResult'].get('available'):
        print(f"  ✔ agy CLI validate 响应: Exit Code {res['agyCliResult']['exitCode']}")

    print('\n[生效提示]: 新开会话或在 Antigravity 中重新载入即可立即使用 task-loop 插件！')


def main():
    args = sys.argv[1:]
    options = {}
    i = 0
    while i < len(args):
        if args[i] in ('--check', '--dry-run'):
            options['check'] = True
        elif args[i] == '--dest' and i + 1 < len(args):
            options['destRoot'] = args[i + 1]
            i += 1
        i += 1

    try:
        res = install_agy_plugin(options)
        print_report(res)
        if res.get('validation') and not res['validation'].get('valid'):
            return 1
        return 0
    except Exception as e:
        print(f"[Install FAIL] {str(e)}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
