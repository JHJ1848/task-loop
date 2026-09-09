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
        if arg in ("--thread", "--message") and index + 1 < len(argv):
            options[arg[2:]] = argv[index + 1]
            index += 1
        elif arg == "--resume":
            options["mode"] = "resume"
        elif arg == "--dry-run":
            options["dry_run"] = True
        index += 1
    return options


def build_command(options, codex_bin=None):
    if not options.get("thread") or not options.get("message"):
        raise ValueError("--thread and --message are required")
    codex_bin = codex_bin or os.environ.get("CODEX_BIN", "codex")
    if options.get("mode") == "resume":
        return [codex_bin, "exec", "resume", options["thread"], options["message"]]
    return [codex_bin, "queue", "--thread", options["thread"], "--message", options["message"]]


def prepared(command, reason):
    return {"status": "PREPARED_ONLY", "submitted": False, "command": command, "reason": reason}


def dispatch(options, run_command=None):
    try:
        command = build_command(options)
    except ValueError as error:
        return {"status": "PREPARED_ONLY", "submitted": False, "reason": str(error)}
    if options.get("dry_run"):
        return prepared(command, "dry-run; no Codex command was executed")
    run_command = run_command or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"))
    try:
        result = run_command(command)
    except FileNotFoundError:
        return prepared(command, "Codex CLI is unavailable; command was not submitted")
    if getattr(result, "returncode", None) == 0:
        return {"status": "SUBMITTED", "submitted": True, "command": command}
    return prepared(command, f"Codex CLI exited {getattr(result, 'returncode', 'without a status')}")


def main(argv=None):
    result = dispatch(parse_args(sys.argv[1:] if argv is None else argv))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in ("SUBMITTED", "PREPARED_ONLY") else 1


if __name__ == "__main__":
    sys.exit(main())
