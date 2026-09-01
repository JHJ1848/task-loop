#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[Provider] ZCode Session Spawn/Send via Headless CLI (Python 3.8+)

实现 SessionProvider 的 spawn / send 原语在 ZCode 宿主的进程外映射：
  spawn(projectDir, prompt) -> 无头创建全新会话   (zcode --cwd <dir> -p "<prompt>")
  send(sessionId, prompt)   -> 续接既有会话       (zcode --resume <sess_id> -p "<prompt>")

CLI 入口形态（zcode 0.16.5 实测）：
  ELECTRON_RUN_AS_NODE=1 "<ZCode.exe>" "<resources/glm/zcode.cjs>" <args>

认证前置：无头运行需先完成一次 `zcode login`（OAuth 写 ~/.zcode/v2/credentials.json）。
桌面端模型 API 走进程内本地路由鉴权、密钥不落盘，CLI 无法直接复用桌面登录态。

子命令：
  --check                                     输出能力体检 JSON（CLI 发现 + 登录态）
  spawn --cwd <dir> --prompt "<text>"         无头创建新会话
  send  --session <sess_id> --prompt "<text>" 续接既有会话
  （任意子命令 + --dry-run 只打印将执行的命令，不实际运行）

退出码：0 成功；1 CLI 未发现/参数非法；2 未登录；3 执行失败。
stdout 恒为单个 JSON 对象。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

SESSION_ID_RE = re.compile(
    r"sess_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

LOGIN_HINT = (
    '运行一次无头登录: ELECTRON_RUN_AS_NODE=1 "<ZCode.exe>" '
    '"<resources/glm/zcode.cjs>" login (OAuth 完成后凭据写入 ~/.zcode/v2/credentials.json)'
)

# 桌面端同步限制的强制用户提示: 无头会话直接落库, 但桌面端侧边栏列表为启动时的
# 内存快照, 不监听外部写入。该字段出现在所有 spawn 成功输出中, 调用方(智能体)
# 必须原样转达给用户, 严禁省略。
DESKTOP_SYNC_NOTICE = (
    "【必须转达给用户】无头会话已成功创建并持久化，但由于 ZCode 桌面端侧边栏的会话列表是"
    "启动时的内存快照，新会话不会立即显示在侧边栏——需要完全重启 ZCode（或切换到其他项目再切回）"
    "后才会出现。会话本身不受影响: 可立即经本工具 send 子命令续接派单。"
    "此限制可能随 ZCode 版本更新消除，当前版本 (0.16.5) 需遵循。"
)


def win_install_roots(env):
    local = env.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    program_files = env.get("ProgramFiles") or r"C:\Program Files"
    return [
        r"D:\Application\ZCode",
        os.path.join(local, "Programs", "ZCode"),
        os.path.join(program_files, "ZCode"),
    ]


def unix_install_roots(platform):
    if platform == "darwin":
        return ["/Applications/ZCode.app/Contents/Resources"]
    return ["/opt/ZCode", "/usr/lib/zcode"]


def discover_zcode_cli(env=None):
    """定位 ZCode CLI。env.ZCODE_CLI_BIN (+ ZCODE_CJS_PATH) 优先，其次平台标准安装路径。"""
    env = env if env is not None else os.environ
    cjs_rel = os.path.join("resources", "glm", "zcode.cjs")

    def try_root(root):
        if not root:
            return None
        cjs = os.path.join(root, cjs_rel)
        if not os.path.exists(cjs):
            return None
        exe_name = "ZCode.exe" if sys.platform == "win32" else "zcode"
        bin_path = os.path.join(root, exe_name)
        if os.path.exists(bin_path):
            return {"bin": bin_path, "cjs": cjs}
        return {"bin": sys.executable, "cjs": cjs, "note": "python-runtime"}

    explicit = env.get("ZCODE_CLI_BIN")
    if explicit:
        root = os.path.dirname(os.path.abspath(explicit))
        hit = try_root(root) or try_root(os.path.dirname(root))
        if hit:
            hit["bin"] = explicit
            return hit
        cjs_override = env.get("ZCODE_CJS_PATH")
        if cjs_override and os.path.exists(cjs_override):
            return {"bin": explicit, "cjs": cjs_override}
        return None

    if sys.platform == "win32":
        roots = win_install_roots(env)
    else:
        roots = unix_install_roots(sys.platform)
    for root in roots:
        hit = try_root(root)
        if hit:
            return hit
    return None


def credentials_path(env=None):
    env = env if env is not None else os.environ
    override = env.get("ZCODE_CREDENTIALS_PATH")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".zcode", "v2", "credentials.json")


def cli_config_path(env=None):
    env = env if env is not None else os.environ
    if env.get("ZCODE_CLI_CONFIG"):
        return env["ZCODE_CLI_CONFIG"]
    return os.path.join(os.path.expanduser("~"), ".zcode", "cli", "config.json")


def api_key_provider_info(env=None):
    """从 cli/config.json 提取 API-key 供应方体检信息（schema: options.apiKey 非空, model 引用 <providerId>/<modelId>）。"""
    p = cli_config_path(env)
    try:
        with open(p, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except FileNotFoundError:
        return {"ok": False, "config_path": p, "reason": "cli config missing"}
    except Exception:
        return {"ok": False, "config_path": p, "reason": "cli config unreadable"}

    providers = cfg.get("provider") if isinstance(cfg, dict) else None
    if not isinstance(providers, dict):
        return {"ok": False, "config_path": p, "reason": "no provider map in cli config"}
    for pid, entry in providers.items():
        key = (entry or {}).get("options", {}).get("apiKey")
        if isinstance(key, str) and key:
            model = cfg.get("model")
            if isinstance(model, str):
                has_ref = model.startswith(pid + "/")
            elif isinstance(model, dict):
                main = model.get("main") or ""
                has_ref = str(main).startswith(pid + "/")
            else:
                has_ref = False
            return {"ok": True, "config_path": p, "provider_id": pid, "has_model_ref": has_ref}
    return {"ok": False, "config_path": p, "reason": "no provider entry carries a non-empty apiKey"}


def auth_state(env=None):
    """登录态检测（双通道）: OAuth 凭据 或 cli/config.json 的 API-key provider。"""
    api_info = api_key_provider_info(env)
    if api_info["ok"]:
        warning = "" if api_info["has_model_ref"] else " (warning: no model ref points at this provider)"
        return {
            "logged_in": True,
            "method": "api-key",
            "credentials_path": api_info["config_path"],
            "provider_id": api_info["provider_id"],
            "reason": "api-key provider configured in cli config" + warning,
        }

    p = credentials_path(env)
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and len(data) > 0:
            return {"logged_in": True, "method": "oauth", "credentials_path": p, "reason": "credentials present"}
        return {
            "logged_in": False,
            "method": None,
            "credentials_path": p,
            "reason": "credentials file empty and no api-key provider configured (desktop routes auth in-process; CLI needs its own login)",
        }
    except FileNotFoundError:
        return {
            "logged_in": False,
            "method": None,
            "credentials_path": p,
            "reason": "credentials file missing and no api-key provider configured",
        }
    except Exception as err:
        return {
            "logged_in": False,
            "method": None,
            "credentials_path": p,
            "reason": f"credentials file unreadable ({err}) and no api-key provider configured",
        }


def login_api_key(key=None, provider_id=None, base_url=None, kind=None, model=None, name=None, env=None):
    """将 API key 安全合并写入 cli/config.json（自动备份）。"""
    env = env if env is not None else os.environ
    if not key or not str(key).strip():
        return {"ok": False, "error": "缺少 --key <API_KEY>"}
    key = str(key).strip()
    provider_id = provider_id or "bigmodel"
    base_url = base_url or "https://open.bigmodel.cn/api/anthropic"
    kind = kind or "anthropic"
    model_id = model or "GLM-5.3-Flash"
    display_name = name or "Bigmodel - API Key"

    if kind not in ("anthropic", "openai", "openai-compatible"):
        return {"ok": False, "error": f"kind 非法: {kind}（允许 anthropic|openai|openai-compatible）"}

    config_path = cli_config_path(env)
    cfg = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
        except Exception as err:
            return {"ok": False, "error": f"读取 {config_path} 失败: {err}（配置文件疑似损坏，请先手工修复）"}
    else:
        os.makedirs(os.path.dirname(config_path), exist_ok=True)

    backup_path = f"{config_path}.bak-login-{int(time.time() * 1000)}"
    had_existing = os.path.exists(config_path)
    if had_existing:
        shutil.copy2(config_path, backup_path)

    providers = cfg.get("provider") if isinstance(cfg.get("provider"), dict) else {}
    entry = dict(providers.get(provider_id) or {})
    options = dict(entry.get("options") or {})
    options["apiKey"] = key
    options["baseURL"] = base_url
    entry["kind"] = kind
    entry["name"] = display_name
    entry["options"] = options
    providers[provider_id] = entry
    cfg["provider"] = providers

    model_ref = f"{provider_id}/{model_id}"
    cfg["model"] = {"main": model_ref, "lite": model_ref}

    try:
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    except Exception as err:
        return {"ok": False, "error": f"写入 {config_path} 失败: {err}"}
    result = {
        "ok": True,
        "config_path": config_path,
        "provider_id": provider_id,
        "model_ref": model_ref,
    }
    if had_existing:
        result["backup_path"] = backup_path
    return result


def build_args(action, opts):
    if action == "spawn":
        return ["--cwd", opts["cwd"], "-p", opts["prompt"]]
    if action == "send":
        return ["--resume", opts["session"], "-p", opts["prompt"]]
    if action == "version":
        return ["version"]
    raise ValueError(f"unknown action: {action}")


def run_cli(cli, args, timeout_sec, env=None):
    env = dict(env if env is not None else os.environ)
    env["ELECTRON_RUN_AS_NODE"] = "1"
    proc = subprocess.run(
        [cli["bin"], cli["cjs"]] + args,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        timeout=max(5, int(timeout_sec or 300)),
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return proc.stdout or ""


def extract_session_id(text):
    m = SESSION_ID_RE.search(text or "")
    return m.group(0) if m else None


def find_latest_session_id_since(since_epoch_s, env=None):
    """spawn 反查: CLI -p 模式 stdout 不带 sess_id，从 db.sqlite 只读反查目录匹配的最新会话。"""
    import sqlite3
    env = env if env is not None else os.environ
    scratch = (env.get("ZCODE_SPAWN_CWD") or "").replace("\\", "/").rstrip("/").lower()
    db_path = os.path.join(os.path.expanduser("~"), ".zcode", "cli", "db", "db.sqlite")
    if not os.path.exists(db_path):
        return None
    try:
        con = sqlite3.connect(f"file:{db_path.replace(chr(92), '/')}?mode=ro", uri=True)
        try:
            if scratch:
                row = con.execute(
                    "SELECT id FROM session WHERE lower(replace(path, '\\\\', '/')) LIKE ? "
                    "OR lower(replace(directory, '\\\\', '/')) LIKE ? ORDER BY time_updated DESC LIMIT 1",
                    (scratch + "%", scratch + "%"),
                ).fetchone()
            else:
                row = con.execute(
                    "SELECT id FROM session ORDER BY time_updated DESC LIMIT 1"
                ).fetchone()
            return row[0] if row else None
        finally:
            con.close()
    except Exception:
        return None


def in_process_alternatives():
    return [
        "Agent 工具: 进程内拉起子代理（同步返回即结果，落 session_task_link 谱系）",
        "ReadSessionContext(sess_*): 跨会话定向读取上下文",
        "SendMessage(to: agent_<uuid>): 同进程代理发信",
        "会话反向内省: db.sqlite(ro) + rollout JSONL + 仓库 Provider 脚本",
    ]


def capability_report(env=None):
    cli = discover_zcode_cli(env)
    auth = auth_state(env)
    return {
        "cli": {
            "found": bool(cli),
            "bin": cli["bin"] if cli else None,
            "cjs": cli["cjs"] if cli else None,
        },
        "auth": {
            "logged_in": auth["logged_in"],
            "method": auth.get("method"),
            "credentials_path": auth["credentials_path"],
            "reason": auth["reason"],
            "hint": None if auth["logged_in"]
            else "运行 scripts/providers/spawn_zcode_session.py login-api-key --key <API_KEY> 配置 API key, 或 zcode login 完成 OAuth",
        },
        "desktop_sync_notice": DESKTOP_SYNC_NOTICE,
        "spawn_send_ready": bool(cli) and auth["logged_in"],
        "in_process_alternatives": in_process_alternatives(),
        "protocol_alternative": "zcode app-server (ZCode Protocol stdio JSON-RPC, 深度编排入口)",
    }


def process_command(args, env=None):
    env = env if env is not None else os.environ
    dry_run = "--dry-run" in args

    def get_opt(name):
        if name in args:
            i = args.index(name)
            if i + 1 < len(args):
                return args[i + 1]
        return None

    if "--check" in args:
        report = capability_report(env)
        if report["cli"]["found"] and not dry_run:
            try:
                out = run_cli(report["cli"], build_args("version", {}), 20, env).strip()
                report["cli"]["version"] = out.split("\n")[0] or None
            except Exception as err:
                report["cli"]["version"] = None
                report["cli"]["version_error"] = str(err).split("\n")[0]
        return 0, report

    if args and args[0] == "login-api-key":
        result = login_api_key(
            key=get_opt("--key"),
            provider_id=get_opt("--provider-id"),
            base_url=get_opt("--base-url"),
            kind=get_opt("--kind"),
            model=get_opt("--model"),
            name=get_opt("--name"),
            env=env,
        )
        return (0 if result.get("ok") else 1), result

    action = args[0] if args and args[0] in ("spawn", "send") else None
    if not action:
        return 1, {
            "ok": False,
            "error": "用法: spawn_zcode_session.py --check | login-api-key --key <API_KEY> | spawn --cwd <dir> --prompt <text> | "
            "send --session <sess_id> --prompt <text> [--dry-run]",
        }

    opts = {
        "cwd": get_opt("--cwd") or ".",
        "prompt": get_opt("--prompt"),
        "session": get_opt("--session"),
        "timeout": get_opt("--timeout") or 300,
    }
    if action == "spawn" and (not opts["prompt"] or not opts["cwd"]):
        return 1, {"ok": False, "error": "spawn 需要 --cwd 与 --prompt"}
    if action == "send":
        if not opts["prompt"] or not opts["session"]:
            return 1, {"ok": False, "error": "send 需要 --session 与 --prompt"}
        if not SESSION_ID_RE.fullmatch(opts["session"]):
            return 1, {"ok": False, "error": f"--session 非法: {opts['session']}（期望 sess_<uuid>）"}

    cli = discover_zcode_cli(env)
    if not cli:
        return 1, {
            "ok": False,
            "error": "未发现 ZCode CLI。可用环境变量 ZCODE_CLI_BIN 指向 ZCode.exe"
            "（zcode.cjs 需位于 <bin>/../resources/glm/zcode.cjs，或以 ZCODE_CJS_PATH 显式指定）。",
        }

    argv = build_args(action, opts)
    command_line = f'{cli["bin"]} {cli["cjs"]} ' + " ".join(json.dumps(a) for a in argv)
    if dry_run:
        return 0, {"ok": True, "dry_run": True, "action": action, "command": command_line}

    auth = auth_state(env)
    if not auth["logged_in"]:
        return 2, {
            "ok": False,
            "error": f"ZCode CLI 未登录（{auth['reason']}）。先执行一次 zcode login 完成 OAuth，"
            f"或改用进程内方案: {' / '.join(in_process_alternatives())}",
        }

    try:
        started_at = time.time()
        out = run_cli(cli, argv, opts["timeout"], env)
        session_id = extract_session_id(out)
        if not session_id and action == "spawn":
            env_probe = dict(env)
            env_probe["ZCODE_SPAWN_CWD"] = opts["cwd"]
            session_id = find_latest_session_id_since(started_at, env_probe)
        payload = {
            "ok": True,
            "action": action,
            "session_id": session_id,
            "output": out.strip(),
            "command": command_line,
        }
        if action == "spawn":
            payload["user_notice_must_relay"] = DESKTOP_SYNC_NOTICE
        return 0, payload
    except Exception as err:
        return 3, {
            "ok": False,
            "action": action,
            "command": command_line,
            "error": "\n".join(str(err).split("\n")[:6]),
        }


def main(argv=None):
    code, payload = process_command(list(sys.argv[1:] if argv is None else argv))
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
