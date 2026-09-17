#!/usr/bin/env python3
import json
import os
import subprocess
import sys


def parse_args(argv):
    options = {"mode": "queue", "dry_run": False}
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in ("--thread", "--message", "--model", "--reasoning-effort") and index + 1 < len(argv):
            key = "reasoning_effort" if arg == "--reasoning-effort" else arg[2:]
            options[key] = argv[index + 1]
            index += 1
        elif arg == "--resume":
            options["mode"] = "resume"
        elif arg == "--dry-run":
            options["dry_run"] = True
        index += 1
    return options


def normalize_thread_id(options):
    options = options if isinstance(options, dict) else {}
    if options.get("clientThreadId") or options.get("client_thread_id") or options.get("id_kind") == "clientThreadId":
        return None
    value = options.get("threadId") or options.get("thread") or options.get("sessionId")
    return str(value).strip() if value is not None and str(value).strip() else None


def build_command(options, codex_bin=None):
    thread = normalize_thread_id(options)
    if not thread or not options.get("message"):
        raise ValueError("formal Codex threadId and message are required; clientThreadId cannot be routed")
    codex_bin = codex_bin or os.environ.get("CODEX_BIN", "codex")
    if options.get("mode") == "resume":
        command = [codex_bin, "exec", "resume", thread, "-"]
    else:
        command = [codex_bin, "queue", "--thread", thread, "--message", options["message"]]
    if options.get("model"):
        command.extend(["--model", options["model"]])
    if options.get("reasoning_effort"):
        command.extend(["--config", f'model_reasoning_effort="{options["reasoning_effort"]}"'])
    return command


def prepared(command, reason):
    return {"status": "PREPARED_ONLY", "submitted": False, "command": command, "reason": reason}


def dispatch(options, run_command=None):
    try:
        command = build_command(options)
    except ValueError as error:
        return {"status": "PREPARED_ONLY", "submitted": False, "reason": str(error)}
    if options.get("dry_run"):
        return prepared(command, "dry-run; no Codex command was executed")
    run_command = run_command or (lambda cmd, input_text=None: subprocess.run(cmd, input=input_text, capture_output=True, text=True, encoding="utf-8", errors="replace"))
    try:
        if options.get("mode") == "resume":
            result = run_command(command, options.get("message"))
        else:
            result = run_command(command)
    except FileNotFoundError:
        return prepared(command, "Codex CLI is unavailable; command was not submitted")
    except Exception as error:
        return prepared(command, f"Codex CLI launch failed: {error}")
    if getattr(result, "returncode", None) == 0:
        return {"status": "SUBMITTED", "submitted": True, "command": command}
    return prepared(command, f"Codex CLI exited {getattr(result, 'returncode', 'without a status')}")


def main(argv=None):
    result = dispatch(parse_args(sys.argv[1:] if argv is None else argv))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in ("SUBMITTED", "PREPARED_ONLY") else 1


if __name__ == "__main__":
    sys.exit(main())
