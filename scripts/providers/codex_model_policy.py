"""Codex-only model defaults and sticky per-session resolution."""

CODEX_MODEL_DEFAULTS = {
    "main": {"model": "gpt-6-astra", "reasoning_effort": "medium"},
    "topic": {"model": "gpt-5.6-terra", "reasoning_effort": "xhigh"},
    "subagent": {"model": "gpt-5.6-luna", "reasoning_effort": "max"},
}
CODEX_ENVIRONMENT_TYPES = ("worktree", "local")


def normalize_role(role):
    value = str(role or "").strip().lower()
    if value in ("main", "orchestrator"):
        return "main"
    if value in ("subagent", "worker", "child"):
        return "subagent"
    return "topic"


def role_for_session(session=None, fallback="topic"):
    session = session if isinstance(session, dict) else {}
    if session.get("is_main") is True or session.get("module_key") == "main" or session.get("role") == "main":
        return "main"
    if session.get("module_key") == "subagent" or session.get("role") == "subagent" or session.get("session_kind") == "subagent":
        return "subagent"
    return normalize_role(fallback)


def configured_model(record):
    if not isinstance(record, dict):
        return None
    nested = record.get("model_config")
    if isinstance(nested, dict) and (nested.get("model") or nested.get("reasoning_effort") or nested.get("thinking")):
        result = dict(nested)
        result["reasoning_effort"] = nested.get("reasoning_effort") or nested.get("thinking")
        return result
    if record.get("model") or record.get("reasoning_effort") or record.get("thinking"):
        result = {"source": "existing"}
        if record.get("model"):
            result["model"] = record["model"]
        if record.get("reasoning_effort") or record.get("thinking"):
            result["reasoning_effort"] = record.get("reasoning_effort") or record.get("thinking")
        return result
    return None


def apply_initial_model_config(record, role=None):
    result = dict(record) if isinstance(record, dict) else {}
    normalized_role = normalize_role(role or role_for_session(result))
    existing = configured_model(result)
    # User choices are sticky. A generated default may be corrected if an older
    # task-loop run assigned the wrong role (for example subagent -> topic).
    if existing and not (existing.get("source") == "task-loop-default" and existing.get("explicit") is False and existing.get("role") != normalized_role):
        return result
    result["model_config"] = {
        **CODEX_MODEL_DEFAULTS[normalized_role],
        "role": normalized_role,
        "source": "task-loop-default",
        "explicit": False,
    }
    return result


def resolve_model_config(request=None, role="topic", session=None):
    normalized_role = normalize_role(role or role_for_session(session or {}))
    result = dict(CODEX_MODEL_DEFAULTS[normalized_role])
    for candidate in (configured_model(session) or {}, configured_model(request) or {}):
        if candidate.get("model"):
            result["model"] = candidate["model"]
        if candidate.get("reasoning_effort"):
            result["reasoning_effort"] = candidate["reasoning_effort"]
    result["role"] = normalized_role
    return result


def to_cli_overrides(model_config=None):
    model_config = model_config if isinstance(model_config, dict) else {}
    result = {}
    if model_config.get("model"):
        result["model"] = model_config["model"]
    if model_config.get("reasoning_effort") or model_config.get("thinking"):
        result["reasoning_effort"] = model_config.get("reasoning_effort") or model_config.get("thinking")
    return result


def normalize_environment(environment):
    value = environment if isinstance(environment, str) else (environment or {}).get("type")
    return {"type": value} if value in CODEX_ENVIRONMENT_TYPES else None


def build_create_thread_request(
    project_id=None,
    is_git_repository=None,
    environment=None,
    title=None,
    prompt=None,
    role="topic",
    model=None,
    reasoning_effort=None,
    thinking=None,
):
    resolved = resolve_model_config({"model": model, "reasoning_effort": reasoning_effort, "thinking": thinking}, role)
    target = (
        {
            "type": "project",
            "projectId": project_id,
            "environment": normalize_environment(environment)
            or {"type": "worktree" if is_git_repository is not False else "local"},
        }
        if project_id
        else {"type": "projectless"}
    )
    return {
        "prompt": prompt,
        "title": title,
        "thinking": thinking or resolved["reasoning_effort"],
        "model": model or resolved["model"],
        "target": target,
    }
