"""Runtime-only Codex transport selection. It never reads or writes task-loop state."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from codex_session_dispatch import dispatch as dispatch_cli


def prepared(reason, **extra):
    result = {"status": "PREPARED_ONLY", "submitted": False, "reason": reason}
    result.update(extra)
    return result


def normalize_request(request=None):
    request = request or {}
    return {
        "thread": request.get("thread") or request.get("threadId") or request.get("sessionId"),
        "message": request.get("message") or request.get("prompt"),
        "mode": "resume" if request.get("mode") == "resume" else "queue",
        "dry_run": bool(request.get("dry_run", request.get("dryRun", False))),
    }


def confirmed(transport, result):
    if result and result.get("submitted") is True:
        return {"status": "SUBMITTED", "submitted": True, "transport": transport, "result": result}
    return prepared("Codex adapter did not return explicit submission confirmation", transport=transport, result=result)


def submit(request, capabilities=None, cli=True, run_cli=None):
    normalized = normalize_request(request)
    if not normalized["thread"] or not normalized["message"]:
        return prepared("thread and message are required")
    if normalized["dry_run"]:
        return prepared("dry-run; no Codex transport was executed", request=normalized)
    capabilities = capabilities or {}
    for transport in ("desktop", "sdk", "api"):
        adapter = capabilities.get(transport)
        if not callable(adapter):
            continue
        try:
            result = adapter({**normalized, "transport": transport})
            if asyncio.iscoroutine(result):
                return prepared("async adapters require submit_async()", transport=transport)
            return confirmed(transport, result)
        except Exception as error:
            return prepared(f"Codex {transport} adapter failed: {error}", transport=transport)
    if cli:
        return dispatch_cli(normalized, run_cli)
    return prepared("No Codex Desktop, SDK, API, or CLI transport is available")


async def submit_async(request, capabilities=None, cli=True, run_cli=None):
    normalized = normalize_request(request)
    if not normalized["thread"] or not normalized["message"]:
        return prepared("thread and message are required")
    if normalized["dry_run"]:
        return prepared("dry-run; no Codex transport was executed", request=normalized)
    for transport in ("desktop", "sdk", "api"):
        adapter = (capabilities or {}).get(transport)
        if not callable(adapter):
            continue
        try:
            result = adapter({**normalized, "transport": transport})
            if asyncio.iscoroutine(result):
                result = await result
            return confirmed(transport, result)
        except Exception as error:
            return prepared(f"Codex {transport} adapter failed: {error}", transport=transport)
    return submit(normalized, {}, cli, run_cli)
