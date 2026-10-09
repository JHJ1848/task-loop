'use strict';

// Codex 3-tier role defaults. Model selection is deferred to Agent or host environment default (model: null).
// Tier 1: Main (orchestrator) - broad context, global decision & planning, adaptive reasoning
// Tier 2: Topic (developer) - code rigor, deep development, debugging & test verification
// Tier 3: Subagent (fast_worker) - targeted subtask, lightweight & high throughput, concise reasoning
const CODEX_MODEL_DEFAULTS = Object.freeze({
  main: Object.freeze({ tier: 'orchestrator', model: null, reasoning_effort: 'medium' }),
  topic: Object.freeze({ tier: 'developer', model: null, reasoning_effort: 'xhigh' }),
  subagent: Object.freeze({ tier: 'fast_worker', model: null, reasoning_effort: 'low' })
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
      (record.model_config.model || record.model_config.reasoning_effort || record.model_config.thinking || record.model_config.tier)) {
    return {
      ...record.model_config,
      reasoning_effort: record.model_config.reasoning_effort || record.model_config.thinking
    };
  }
  if (record.model || record.reasoning_effort || record.thinking || record.tier) {
    const result = { source: 'existing' };
    if (record.model) result.model = record.model;
    if (record.reasoning_effort || record.thinking) result.reasoning_effort = record.reasoning_effort || record.thinking;
    if (record.tier) result.tier = record.tier;
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
    if (candidate.model !== undefined && candidate.model !== null) result.model = candidate.model;
    if (candidate.reasoning_effort !== undefined && candidate.reasoning_effort !== null) result.reasoning_effort = candidate.reasoning_effort;
    if (candidate.tier !== undefined && candidate.tier !== null) result.tier = candidate.tier;
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
        environment: normalizeEnvironment(environment) || { type: isGitRepository !== false ? 'worktree' : 'local' }
      }
    : { type: 'projectless' };
  return {
    prompt,
    title,
    thinking: thinking || resolved.reasoning_effort || null,
    model: model || resolved.model || null,
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
