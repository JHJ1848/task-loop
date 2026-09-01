#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for spawn_zcode_session.py (ZCode headless CLI session provider)
全部基于 fixture/env 注入，不依赖真实 ZCode 安装与登录态。
"""

import importlib.util
import json
import os
import sys
import tempfile
import shutil
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "spawn_zcode_session",
    Path(__file__).resolve().parent.parent / "scripts" / "providers" / "spawn_zcode_session.py",
)
provider = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(provider)


def _make_fake_cli_root(tag):
    root = tempfile.mkdtemp(prefix=f"test_zcli_{tag}_")
    os.makedirs(os.path.join(root, "resources", "glm"), exist_ok=True)
    exe_name = "ZCode.exe" if sys.platform == "win32" else "zcode"
    with open(os.path.join(root, exe_name), "w", encoding="utf-8") as fh:
        fh.write("stub")
    with open(os.path.join(root, "resources", "glm", "zcode.cjs"), "w", encoding="utf-8") as fh:
        fh.write("# stub\n")
    return root, exe_name


def _with_creds(content, fn):
    d = tempfile.mkdtemp(prefix="test_zcred_")
    p = os.path.join(d, "credentials.json")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(content)
    try:
        return fn(p)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_discovery():
    root, exe_name = _make_fake_cli_root("disc")
    cli = provider.discover_zcode_cli({"ZCODE_CLI_BIN": os.path.join(root, exe_name)})
    assert cli, "cli must be discovered via env override"
    assert cli["cjs"] == os.path.join(root, "resources", "glm", "zcode.cjs")

    # 显式 bin 但无 cjs -> None
    empty = tempfile.mkdtemp(prefix="test_zcli_empty_")
    exe_in_empty = os.path.join(empty, "ZCode.exe" if sys.platform == "win32" else "zcode")
    Path(exe_in_empty).write_text("stub", encoding="utf-8")
    if sys.platform == "win32":
        assert provider.discover_zcode_cli({"ZCODE_CLI_BIN": exe_in_empty}) is None

    # ZCODE_CJS_PATH 兜底
    ok = provider.discover_zcode_cli({
        "ZCODE_CLI_BIN": exe_in_empty,
        "ZCODE_CJS_PATH": os.path.join(root, "resources", "glm", "zcode.cjs"),
    })
    assert ok and ok["cjs"].endswith("zcode.cjs")
    print("Discovery tests PASSED!")


def test_auth_state():
    _iso = {"ZCODE_CLI_CONFIG": os.path.join(tempfile.gettempdir(), f"no_cfg_{id(object())}.json")}
    _with_creds('{"accessToken":"x"}', lambda p: (
        lambda a: (_ for _ in ()).throw(AssertionError(a)) if not a["logged_in"] else None
    )(provider.auth_state({**_iso, "ZCODE_CREDENTIALS_PATH": p})))
    _with_creds("{}", lambda p: (
        lambda a: (_ for _ in ()).throw(AssertionError(a)) if a["logged_in"] else None
    )(provider.auth_state({**_iso, "ZCODE_CREDENTIALS_PATH": p})))
    missing = os.path.join(tempfile.gettempdir(), f"no_such_{id(object())}.json")
    a = provider.auth_state({"ZCODE_CREDENTIALS_PATH": missing, "ZCODE_CLI_CONFIG": missing + ".x"})
    assert a["logged_in"] is False and "missing" in a["reason"]
    print("AuthState tests PASSED!")


def test_build_args():
    assert provider.build_args("spawn", {"cwd": "D:/x", "prompt": "hi"}) == ["--cwd", "D:/x", "-p", "hi"]
    assert provider.build_args("send", {"session": "sess_11111111-2222-3333-4444-555555555555", "prompt": "hi"}) == [
        "--resume", "sess_11111111-2222-3333-4444-555555555555", "-p", "hi"
    ]
    try:
        provider.build_args("nope", {})
        raise AssertionError("unknown action must raise")
    except ValueError:
        pass
    print("BuildArgs tests PASSED!")


def test_process_command_gates():
    code, _ = provider.process_command(["send", "--session", "garbage", "--prompt", "x"], env={})
    assert code == 1
    code, _ = provider.process_command(["spawn", "--cwd", "."], env={})
    assert code == 1
    code, _ = provider.process_command(["frobnicate"], env={})
    assert code == 1
    print("Gate tests PASSED!")


def test_dry_run_and_extract():
    root, exe_name = _make_fake_cli_root("dry")
    env = {
        "ZCODE_CLI_BIN": os.path.join(root, exe_name),
        "ZCODE_CREDENTIALS_PATH": os.path.join(tempfile.gettempdir(), f"no_such_{id(object())}.json"),
        "ZCODE_CLI_CONFIG": os.path.join(tempfile.gettempdir(), f"no_cfg_{id(object())}.json"),
    }
    code, payload = provider.process_command(["spawn", "--cwd", "D:/proj", "--prompt", "任务A", "--dry-run"], env=env)
    assert code == 0 and payload["dry_run"] is True
    assert "--cwd" in payload["command"] and "D:/proj" in payload["command"]

    code, payload = provider.process_command(["spawn", "--cwd", "D:/proj", "--prompt", "任务A"], env=env)
    assert code == 2 and "zcode login" in payload["error"]

    sid = provider.extract_session_id("blah sess_11111111-2222-3333-4444-555555555555 end")
    assert sid == "sess_11111111-2222-3333-4444-555555555555"
    assert provider.extract_session_id("no id here") is None
    print("DryRun & Extract tests PASSED!")


def test_capability_report_shape():
    root, exe_name = _make_fake_cli_root("cap")
    env = {
        "ZCODE_CLI_BIN": os.path.join(root, exe_name),
        "ZCODE_CREDENTIALS_PATH": os.path.join(tempfile.gettempdir(), f"no_such_{id(object())}.json"),
        "ZCODE_CLI_CONFIG": os.path.join(tempfile.gettempdir(), f"no_cfg_{id(object())}.json"),
    }
    report = provider.capability_report(env)
    assert report["cli"]["found"] is True
    assert report["auth"]["logged_in"] is False
    assert report["spawn_send_ready"] is False
    assert len(report["in_process_alternatives"]) >= 3
    print("CapabilityReport tests PASSED!")


def test_new_topic_session_vendor_aware():
    """new_topic_session 的 spawn_root_conversation 在无 agentapi 且未登录时优雅降级返回 None。"""
    spec = importlib.util.spec_from_file_location(
        "new_topic_session", Path(__file__).resolve().parent.parent / "scripts" / "new_topic_session.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    env = {
        "ZCODE_CREDENTIALS_PATH": os.path.join(tempfile.gettempdir(), f"no_such_{id(object())}.json"),
        "ZCODE_CLI_CONFIG": os.path.join(tempfile.gettempdir(), f"no_cfg_{id(object())}.json"),
        "AGENTAPI_PATH": os.path.join(tempfile.gettempdir(), f"no_such_agentapi_{id(object())}"),
    }
    old_env = dict(os.environ)
    os.environ.update(env)
    try:
        result = mod.spawn_root_conversation("[测试专题] x", "初始化", tempfile.gettempdir())
        assert result is None, "unauthenticated spawn must degrade to None"
    finally:
        os.environ.clear()
        os.environ.update(old_env)
    print("new_topic_session vendor-aware degrade test PASSED!")


def test_api_key_mode():
    d = tempfile.mkdtemp(prefix="test_zkey_")
    cfg_path = os.path.join(d, "config.json")
    try:
        code, payload = provider.process_command(
            ["login-api-key", "--key", "test-key-123"], env={"ZCODE_CLI_CONFIG": cfg_path}
        )
        assert code == 0 and payload["ok"] is True, payload
        assert payload["model_ref"] == "bigmodel/GLM-5.3-Flash"
        assert not payload.get("backup_path"), "first-time install has nothing to back up"

        cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
        assert cfg["provider"]["bigmodel"]["options"]["apiKey"] == "test-key-123"
        assert cfg["model"]["main"] == "bigmodel/GLM-5.3-Flash"

        a = provider.auth_state({"ZCODE_CLI_CONFIG": cfg_path})
        assert a["logged_in"] is True and a["method"] == "api-key"

        # 安全合并: 已有 plugins 键保留, 且覆盖已有文件时产生备份
        Path(cfg_path).write_text(json.dumps({"plugins": {"enabledPlugins": {"x@y": True}}}), encoding="utf-8")
        r2 = provider.login_api_key(key="k2", env={"ZCODE_CLI_CONFIG": cfg_path})
        assert os.path.exists(r2["backup_path"])
        merged = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
        assert merged["plugins"]["enabledPlugins"] == {"x@y": True}

        # 空 key / 非法 kind 拒绝
        assert provider.login_api_key(key="  ", env={"ZCODE_CLI_CONFIG": cfg_path})["ok"] is False
        assert provider.login_api_key(key="k", kind="grpc", env={"ZCODE_CLI_CONFIG": cfg_path})["ok"] is False
        print("ApiKeyMode tests PASSED!")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_desktop_sync_notice():
    root, exe_name = _make_fake_cli_root("notice")
    env = {
        "ZCODE_CLI_BIN": os.path.join(root, exe_name),
        "ZCODE_CLI_CONFIG": os.path.join(tempfile.gettempdir(), f"no_cfg_{id(object())}.json"),
    }
    report = provider.capability_report(env)
    assert "必须转达给用户" in report["desktop_sync_notice"]

    code, payload = provider.process_command(["spawn", "--cwd", "D:/x", "--prompt", "p", "--dry-run"], env=env)
    assert code == 0 and "user_notice_must_relay" not in payload
    print("DesktopSyncNotice tests PASSED!")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    test_discovery()
    test_auth_state()
    test_build_args()
    test_process_command_gates()
    test_dry_run_and_extract()
    test_capability_report_shape()
    test_new_topic_session_vendor_aware()
    test_api_key_mode()
    test_desktop_sync_notice()
    print("ALL ZCode Spawn Provider Python Tests PASSED SUCCESSFULLY!")
