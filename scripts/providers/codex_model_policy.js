'use strict';

// Codex-only role defaults. Existing per-session values always win.
const CODEX_MODEL_DEFAULTS = Object.freeze({
  main: Object.freeze({ model: 'gpt-6-astra', reasoning_effort: 'medium' }),
  topic: Object.freeze({ model: 'gpt-5.6-terra', reasoning_effort: 'xhigh' }),
  subagent: Object.freeze({ model: 'gpt-5.6-luna', reasoning_effort: 'max' })
});
const CODEX_ENVIRONMENT_TYPES = Object.freeze(['worktree', 'local']);

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'main' || value === 'orchestrator') return 'main';
  if (value === 'subagent' || value === 'worker' || value === 'child') return 'subagent';
  return 'topic';
}

function roleForSession(session = {}, fallback = 'topic') {
  if (session.is_main === true || session.module_key === 'main' || session.role === 'main') return 'main';
  if (session.module_key === 'subagent' || session.role === 'subagent' || session.session_kind === 'subagent') return 'subagent';
  return normalizeRole(fallback);
}

function configuredModel(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.model_config && typeof record.model_config === 'object' &&
      (record.model_config.model || record.model_config.reasoning_effort || record.model_config.thinking)) {
    return {
      ...record.model_config,
      reasoning_effort: record.model_config.reasoning_effort || record.model_config.thinking
    };
  }
  if (record.model || record.reasoning_effort || record.thinking) {
    const result = { source: 'existing' };
    if (record.model) result.model = record.model;
    if (record.reasoning_effort || record.thinking) result.reasoning_effort = record.reasoning_effort || record.thinking;
    return result;
  }
  return null;
}

function applyInitialModelConfig(record, role) {
  const input = record && typeof record === 'object' ? record : {};
  const normalizedRole = normalizeRole(role || roleForSession(input));
  const existing = configuredModel(input);
  // User choices are sticky. A generated default may be corrected if an older
  // task-loop run assigned the wrong role (for example subagent -> topic).
  if (existing && !(existing.source === 'task-loop-default' && existing.explicit === false && existing.role !== normalizedRole)) return input;
  return {
    ...input,
    model_config: {
      ...CODEX_MODEL_DEFAULTS[normalizedRole],
      role: normalizedRole,
      source: 'task-loop-default',
      explicit: false
    }
  };
}

function resolveModelConfig(request = {}, role = 'topic', session = null) {
  const normalizedRole = normalizeRole(role || roleForSession(session || {}));
  const defaults = CODEX_MODEL_DEFAULTS[normalizedRole];
  const existing = configuredModel(session) || {};
  const requested = configuredModel(request) || {};
  const result = { ...defaults };
  for (const candidate of [existing, requested]) {
    if (candidate.model) result.model = candidate.model;
    if (candidate.reasoning_effort) result.reasoning_effort = candidate.reasoning_effort;
  }
  return { ...result, role: normalizedRole };
}

function toCliOverrides(modelConfig = {}) {
  const result = {};
  if (modelConfig.model) result.model = modelConfig.model;
  if (modelConfig.reasoning_effort || modelConfig.thinking) result.reasoning_effort = modelConfig.reasoning_effort || modelConfig.thinking;
  return result;
}

function normalizeEnvironment(environment) {
  const value = typeof environment === 'string' ? environment : environment && environment.type;
  return CODEX_ENVIRONMENT_TYPES.includes(value) ? { type: value } : null;
}

function buildCreateThreadRequest({ projectId, isGitRepository, environment, title, prompt, role = 'topic', model, reasoning_effort, thinking } = {}) {
  const resolved = resolveModelConfig({ model, reasoning_effort, thinking }, role);
  const target = projectId
    ? {
        type: 'project',
        projectId,
        environment: normalizeEnvironment(environment) || { type: isGitRepository === true ? 'worktree' : 'local' }
      }
    : { type: 'projectless' };
  return {
    prompt,
    title,
    thinking: thinking || resolved.reasoning_effort,
    model: model || resolved.model,
    target
  };
}

module.exports = {
  CODEX_MODEL_DEFAULTS,
  normalizeRole,
  roleForSession,
  configuredModel,
  applyInitialModelConfig,
  resolveModelConfig,
  toCliOverrides,
  normalizeEnvironment,
  buildCreateThreadRequest
};
