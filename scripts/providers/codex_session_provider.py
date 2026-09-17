"""Runtime-only Codex transport selection. It never reads or writes task-loop state."""
import asyncio
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from codex_session_dispatch import dispatch as dispatch_cli
from codex_session_dispatch import normalize_thread_id


def prepared(reason, **extra):
    result = {"status": "PREPARED_ONLY", "submitted": False, "reason": reason}
    result.update(extra)
    return result


def unsupported(action, reason, **extra):
    result = {"status": "UNSUPPORTED", "supported": False, "action": action, "reason": reason}
    result.update(extra)
    return result


def pending_creation(reason, **extra):
    result = {
        "status": "PENDING_CREATION",
        "submitted": False,
        "bound": False,
        "vendor": "codex",
        "threadId": None,
        "reason": reason,
    }
    result.update(extra)
    return result


def creation_failed(reason, **extra):
    result = {
        "status": "CREATION_FAILED",
        "submitted": False,
        "bound": False,
        "vendor": "codex",
        "threadId": None,
        "reason": reason,
    }
    result.update(extra)
    return result


def normalize_request(request=None):
    request = request if isinstance(request, dict) else {}
    model_config = request.get("model_config") if isinstance(request.get("model_config"), dict) else {}
    thread = normalize_thread_id(request)
    return {
        "thread": thread,
        "threadId": thread,
        "message": request.get("message") or request.get("prompt"),
        "mode": "resume" if request.get("mode") == "resume" else "queue",
        "model": request.get("model") or model_config.get("model"),
        "reasoning_effort": request.get("reasoning_effort") or request.get("reasoningEffort") or request.get("thinking") or model_config.get("reasoning_effort"),
        "dry_run": bool(request.get("dry_run") or request.get("dryRun")),
    }


def normalize_create_request(request=None):
    request = request if isinstance(request, dict) else {}
    model_config = request.get("model_config") if isinstance(request.get("model_config"), dict) else {}
    return {
        "title": request.get("title") or request.get("name") or "",
        "prompt": request.get("prompt") or request.get("message") or "",
        "model": request.get("model") or model_config.get("model"),
        "reasoning_effort": request.get("reasoning_effort") or request.get("reasoningEffort") or request.get("thinking") or model_config.get("reasoning_effort"),
        "target": request.get("target"),
        "projectId": request.get("projectId") or request.get("project_id"),
        "environment": request.get("environment"),
        "role": request.get("role"),
        "dry_run": bool(request.get("dry_run") or request.get("dryRun")),
    }


def _collect_structured_objects(value, objects=None, seen=None):
    objects = objects if objects is not None else []
    seen = seen if seen is not None else set()
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return objects if parsed == value else _collect_structured_objects(parsed, objects, seen)
        except (TypeError, ValueError):
            return objects
    if not isinstance(value, (dict, list)) or id(value) in seen:
        return objects
    seen.add(id(value))
    if isinstance(value, list):
        for item in value:
            _collect_structured_objects(item, objects, seen)
        return objects
    objects.append(value)
    for key in ("structuredContent", "response", "thread", "result", "data"):
        nested = value.get(key)
        if isinstance(nested, str):
            try:
                _collect_structured_objects(json.loads(nested), objects, seen)
            except (TypeError, ValueError):
                pass
        else:
            _collect_structured_objects(nested, objects, seen)
    content = value.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
                continue
            try:
                _collect_structured_objects(json.loads(block["text"]), objects, seen)
            except (TypeError, ValueError):
                pass
    return objects


def _first_result_field(result, fields):
    for obj in _collect_structured_objects(result):
        for field in fields:
            value = obj.get(field)
            if value is not None and str(value).strip():
                return str(value).strip()
    return None


def formal_create_thread_id(result):
    return _first_result_field(result, ("threadId", "thread_id"))


def formal_client_thread_id(result):
    return _first_result_field(result, ("clientThreadId", "client_thread_id"))


def normalize_create_result(result, request, transport="host"):
    normalized_request = normalize_create_request(request)
    thread_id = formal_create_thread_id(result)
    if thread_id:
        return {
            "status": "READY",
            "submitted": True,
            "bound": False,
            "vendor": "codex",
            "threadId": thread_id,
            "id_kind": "threadId",
            "transport": transport,
            "request": normalized_request,
            "result": result,
        }
    client_thread_id = formal_client_thread_id(result)
    if client_thread_id:
        return pending_creation(
            "Codex host returned clientThreadId; wait for the formal threadId before binding or sending",
            transport=transport,
            client_thread_id=client_thread_id,
            request=normalized_request,
            host_result=result,
        )
    return pending_creation(
        "Codex creation was requested but the host has not returned a formal threadId",
        transport=transport,
        request=normalized_request,
        host_result=result,
    )


def _create_adapter_entries(capabilities):
    capabilities = capabilities if isinstance(capabilities, dict) else {}
    entries = []
    create_adapter = capabilities.get("create")
    if callable(create_adapter):
        entries.append((capabilities.get("transport") or "host", create_adapter))
    for transport in ("desktop", "sdk", "api"):
        direct = capabilities.get(f"{transport}Create")
        nested = capabilities.get(transport)
        nested = nested.get("create") if isinstance(nested, dict) else None
        if callable(direct):
            entries.append((transport, direct))
        elif callable(nested):
            entries.append((transport, nested))
    return entries


def create(request, capabilities=None, **options):
    normalized = normalize_create_request(request)
    if options.get("dry_run") or options.get("dryRun"):
        normalized["dry_run"] = True
    if not normalized["title"] or not normalized["prompt"]:
        return creation_failed("title and prompt are required")
    if normalized["dry_run"]:
        return pending_creation("dry-run; no Codex host transport was executed", request=normalized)

    entries = _create_adapter_entries(capabilities)
    if not entries:
        return pending_creation(
            "Codex Desktop creation must be completed by the host; this repository cannot invent or persist a threadId",
            request=normalized,
            creation_request=normalized,
            host_action="create_thread",
        )

    failures = []
    for transport, adapter in entries:
        try:
            result = adapter({**normalized, "transport": transport})
            if inspect.isawaitable(result):
                failures.append(f"Codex {transport} adapter requires create_async()")
                continue
            outcome = normalize_create_result(result, normalized, transport)
            if outcome.get("status") in ("READY", "PENDING_CREATION"):
                return outcome
            failures.append(f"{transport}: {outcome.get('reason', 'adapter rejected creation')}")
        except Exception as error:
            failures.append(f"Codex {transport} adapter failed: {error}")
    return creation_failed("; ".join(failures) or "No Codex creation adapter returned a result", request=normalized)


async def create_async(request, capabilities=None, **options):
    normalized = normalize_create_request(request)
    if options.get("dry_run") or options.get("dryRun"):
        normalized["dry_run"] = True
    if not normalized["title"] or not normalized["prompt"]:
        return creation_failed("title and prompt are required")
    if normalized["dry_run"]:
        return pending_creation("dry-run; no Codex host transport was executed", request=normalized)

    entries = _create_adapter_entries(capabilities)
    if not entries:
        return pending_creation(
            "Codex Desktop creation must be completed by the host; this repository cannot invent or persist a threadId",
            request=normalized,
            creation_request=normalized,
            host_action="create_thread",
        )

    failures = []
    for transport, adapter in entries:
        try:
            result = adapter({**normalized, "transport": transport})
            if inspect.isawaitable(result):
                result = await result
            outcome = normalize_create_result(result, normalized, transport)
            if outcome.get("status") in ("READY", "PENDING_CREATION"):
                return outcome
            failures.append(f"{transport}: {outcome.get('reason', 'adapter rejected creation')}")
        except Exception as error:
            failures.append(f"Codex {transport} adapter failed: {error}")
    return creation_failed("; ".join(failures) or "No Codex creation adapter returned a result", request=normalized)


def _lifecycle_adapter_entries(action, capabilities):
    capabilities = capabilities if isinstance(capabilities, dict) else {}
    entries = []
    direct = capabilities.get(action)
    if callable(direct):
        entries.append((capabilities.get("transport") or "host", direct))
    suffix = action[0].upper() + action[1:]
    for transport in ("desktop", "sdk", "api"):
        direct = capabilities.get(f"{transport}{suffix}")
        nested = capabilities.get(transport)
        nested = nested.get(action) if isinstance(nested, dict) else None
        if callable(direct):
            entries.append((transport, direct))
        elif callable(nested):
            entries.append((transport, nested))
    return entries


def normalize_lifecycle_result(action, result, transport, thread_id):
    if isinstance(result, dict) and result.get("status"):
        normalized = dict(result)
        normalized.update({"action": action, "transport": transport, "threadId": thread_id})
        return normalized
    return {"status": "READY", "action": action, "transport": transport, "threadId": thread_id, "result": result}


def read(request, capabilities=None):
    thread_id = normalize_thread_id(request)
    if not thread_id:
        return unsupported("read", "formal Codex threadId is required; clientThreadId cannot be read")
    entries = _lifecycle_adapter_entries("read", capabilities)
    if not entries:
        return unsupported("read", "No Codex read adapter is connected", threadId=thread_id)
    transport, adapter = entries[0]
    try:
        result = adapter({"threadId": thread_id, "thread": thread_id, "transport": transport})
        if inspect.isawaitable(result):
            return prepared("Codex read adapter requires read_async()", action="read", threadId=thread_id)
        return normalize_lifecycle_result("read", result, transport, thread_id)
    except Exception as error:
        return {"status": "READ_FAILED", "action": "read", "threadId": thread_id, "reason": str(error)}


async def read_async(request, capabilities=None):
    thread_id = normalize_thread_id(request)
    if not thread_id:
        return unsupported("read", "formal Codex threadId is required; clientThreadId cannot be read")
    entries = _lifecycle_adapter_entries("read", capabilities)
    if not entries:
        return unsupported("read", "No Codex read adapter is connected", threadId=thread_id)
    transport, adapter = entries[0]
    try:
        result = adapter({"threadId": thread_id, "thread": thread_id, "transport": transport})
        if inspect.isawaitable(result):
            result = await result
        return normalize_lifecycle_result("read", result, transport, thread_id)
    except Exception as error:
        return {"status": "READ_FAILED", "action": "read", "threadId": thread_id, "reason": str(error)}


async def wait(request, capabilities=None):
    thread_id = normalize_thread_id(request)
    if not thread_id:
        return unsupported("wait", "formal Codex threadId is required; clientThreadId cannot be waited on")
    entries = _lifecycle_adapter_entries("wait", capabilities)
    if not entries:
        return unsupported("wait", "No Codex wait adapter is connected", threadId=thread_id)
    transport, adapter = entries[0]
    try:
        result = adapter({"threadId": thread_id, "thread": thread_id, "transport": transport})
        if inspect.isawaitable(result):
            result = await result
        return normalize_lifecycle_result("wait", result, transport, thread_id)
    except Exception as error:
        return {"status": "WAIT_FAILED", "action": "wait", "threadId": thread_id, "reason": str(error)}


def _send_adapter_entries(capabilities):
    capabilities = capabilities if isinstance(capabilities, dict) else {}
    entries = []
    send_adapter = capabilities.get("send")
    if callable(send_adapter):
        entries.append((capabilities.get("transport") or "host", send_adapter))
    for transport in ("desktop", "sdk", "api"):
        direct = capabilities.get(transport)
        named = capabilities.get(f"{transport}Send")
        nested = direct.get("send") if isinstance(direct, dict) else None
        if callable(direct):
            entries.append((transport, direct))
        elif callable(named):
            entries.append((transport, named))
        elif callable(nested):
            entries.append((transport, nested))
    return entries


def get_capabilities(capabilities=None):
    has_action = lambda action: bool(_lifecycle_adapter_entries(action, capabilities))
    has_create = bool(_create_adapter_entries(capabilities))
    normalized_capabilities = capabilities if isinstance(capabilities, dict) else {}
    has_send = bool(_send_adapter_entries(normalized_capabilities)) or normalized_capabilities.get("cli") is True or callable(normalized_capabilities.get("run_cli"))
    return {
        "vendor": "codex",
        "create": {"supported": has_create, "status": "AVAILABLE" if has_create else "PENDING_CREATION"},
        "send": {"supported": has_send, "status": "AVAILABLE" if has_send else "UNSUPPORTED"},
        "read": {"supported": has_action("read"), "status": "AVAILABLE" if has_action("read") else "UNSUPPORTED"},
        "wait": {"supported": has_action("wait"), "status": "AVAILABLE" if has_action("wait") else "UNSUPPORTED"},
        "formal_thread_id_required": True,
        "client_thread_id_routable": False,
        "host_managed_creation": not has_create,
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
    for transport, adapter in _send_adapter_entries(capabilities):
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
        return dispatch_cli(normalized, run_cli or capabilities.get("run_cli"))
    return prepared("; ".join(failures) or "No Codex Desktop, SDK, API, or CLI transport is available")


async def submit_async(request, capabilities=None, cli=True, run_cli=None):
    capabilities = capabilities or {}
    normalized = normalize_request(request)
    if not normalized["thread"] or not normalized["message"]:
        return prepared("thread and message are required")
    if normalized["dry_run"]:
        return prepared("dry-run; no Codex transport was executed", request=normalized)
    for transport, adapter in _send_adapter_entries(capabilities):
        try:
            result = adapter({**normalized, "transport": transport})
            if inspect.isawaitable(result):
                result = await result
            outcome = confirmed(transport, result)
            if outcome.get("submitted") is True:
                return outcome
        except Exception as error:
            continue
    return submit(normalized, {}, cli, run_cli or capabilities.get("run_cli"))


send = submit
