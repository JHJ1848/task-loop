"""Runtime-only Codex transport selection. It never reads or writes task-loop state."""
import asyncio
import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from codex_session_dispatch import dispatch as dispatch_cli


def prepared(reason, **extra):
    result = {"status": "PREPARED_ONLY", "submitted": False, "reason": reason}
    result.update(extra)
    return result


def normalize_request(request=None):
    request = request if isinstance(request, dict) else {}
    model_config = request.get("model_config") if isinstance(request.get("model_config"), dict) else {}
    return {
        "thread": request.get("thread") or request.get("threadId") or request.get("sessionId"),
        "message": request.get("message") or request.get("prompt"),
        "mode": "resume" if request.get("mode") == "resume" else "queue",
        "model": request.get("model") or model_config.get("model"),
        "reasoning_effort": request.get("reasoning_effort") or request.get("reasoningEffort") or request.get("thinking") or model_config.get("reasoning_effort"),
        "dry_run": bool(request.get("dry_run") or request.get("dryRun")),
    }


def confirmed(transport, result):
    if isinstance(result, dict) and result.get("submitted") is True:
        return {"status": "SUBMITTED", "submitted": True, "transport": transport, "result": result}
    return prepared("Codex adapter did not return explicit submission confirmation", transport=transport, result=result)


def submit(request, capabilities=None, cli=True, run_cli=None):
    normalized = normalize_request(request)
    if not normalized["thread"] or not normalized["message"]:
        return prepared("thread and message are required")
    if normalized["dry_run"]:
        return prepared("dry-run; no Codex transport was executed", request=normalized)
    capabilities = capabilities or {}
    failures = []
    for transport in ("desktop", "sdk", "api"):
        adapter = capabilities.get(transport)
        if not callable(adapter):
            continue
        if inspect.iscoroutinefunction(adapter):
            failures.append(f"Codex {transport} adapter requires submit_async()")
            continue
        try:
            result = adapter({**normalized, "transport": transport})
            if inspect.isawaitable(result):
                failures.append(f"Codex {transport} adapter returned an awaitable; use submit_async()")
                continue
            outcome = confirmed(transport, result)
            if outcome.get("submitted") is True:
                return outcome
            failures.append(f"{transport}: {outcome.get('reason', 'adapter rejected submission')}")
        except Exception as error:
            failures.append(f"Codex {transport} adapter failed: {error}")
    if cli:
        return dispatch_cli(normalized, run_cli)
    return prepared("; ".join(failures) or "No Codex Desktop, SDK, API, or CLI transport is available")


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
            if inspect.isawaitable(result):
                result = await result
            outcome = confirmed(transport, result)
            if outcome.get("submitted") is True:
                return outcome
        except Exception as error:
            continue
    return submit(normalized, {}, cli, run_cli)
