'use strict';

const cliDispatch = require('./codex_session_dispatch');

function prepared(reason, extra = {}) {
  return { status: 'PREPARED_ONLY', submitted: false, reason, ...extra };
}

function unsupported(action, reason, extra = {}) {
  return { status: 'UNSUPPORTED', supported: false, action, reason, ...extra };
}

function pendingCreation(reason, extra = {}) {
  return {
    status: 'PENDING_CREATION',
    submitted: false,
    bound: false,
    vendor: 'codex',
    threadId: null,
    reason,
    ...extra
  };
}

function creationFailed(reason, extra = {}) {
  return {
    status: 'CREATION_FAILED',
    submitted: false,
    bound: false,
    vendor: 'codex',
    threadId: null,
    reason,
    ...extra
  };
}

function normalizeRequest(request = {}) {
  request = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  const modelConfig = request.model_config && typeof request.model_config === 'object' ? request.model_config : {};
  const thread = cliDispatch.normalizeThreadId(request);
  return {
    thread,
    threadId: thread,
    message: request.message || request.prompt,
    mode: request.mode === 'resume' ? 'resume' : 'queue',
    model: request.model || modelConfig.model,
    reasoning_effort: request.reasoning_effort || request.reasoningEffort || request.thinking || modelConfig.reasoning_effort,
    dryRun: Boolean(request.dryRun || request.dry_run)
  };
}

function normalizeCreateRequest(request = {}) {
  request = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  const modelConfig = request.model_config && typeof request.model_config === 'object' ? request.model_config : {};
  return {
    title: request.title || request.name || '',
    prompt: request.prompt || request.message || '',
    model: request.model || modelConfig.model,
    reasoning_effort: request.reasoning_effort || request.reasoningEffort || request.thinking || modelConfig.reasoning_effort,
    target: request.target,
    projectId: request.projectId || request.project_id,
    environment: request.environment,
    role: request.role,
    dryRun: Boolean(request.dryRun || request.dry_run)
  };
}

function collectStructuredObjects(value, objects = [], seen = new Set()) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed === value ? objects : collectStructuredObjects(parsed, objects, seen);
    } catch (error) {
      return objects;
    }
  }
  if (value == null || typeof value !== 'object' || seen.has(value)) return objects;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => collectStructuredObjects(item, objects, seen));
    return objects;
  }
  objects.push(value);
  for (const key of ['structuredContent', 'response', 'thread', 'result', 'data']) {
    const nested = value[key];
    if (typeof nested === 'string') {
      try {
        collectStructuredObjects(JSON.parse(nested), objects, seen);
      } catch (error) {
        // Non-JSON text is not a structured Codex result.
      }
    } else {
      collectStructuredObjects(nested, objects, seen);
    }
  }
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
      try {
        collectStructuredObjects(JSON.parse(block.text), objects, seen);
      } catch (error) {
        // Content blocks may contain ordinary human-readable text.
      }
    }
  }
  return objects;
}

function firstResultField(result, fields) {
  for (const object of collectStructuredObjects(result)) {
    for (const field of fields) {
      const value = object[field];
      if (value != null && String(value).trim()) return String(value).trim();
    }
  }
  return null;
}

function formalCreateThreadId(result) {
  return firstResultField(result, ['threadId', 'thread_id']);
}

function formalClientThreadId(result) {
  return firstResultField(result, ['clientThreadId', 'client_thread_id']);
}

function normalizeCreateResult(result, request, transport = 'host') {
  const normalizedRequest = normalizeCreateRequest(request);
  const threadId = formalCreateThreadId(result);
  if (threadId) {
    return {
      status: 'READY',
      submitted: true,
      bound: false,
      vendor: 'codex',
      threadId,
      id_kind: 'threadId',
      transport,
      request: normalizedRequest,
      result
    };
  }
  const clientThreadId = formalClientThreadId(result);
  if (clientThreadId) {
    return pendingCreation(
      'Codex host returned clientThreadId; wait for the formal threadId before binding or sending',
      {
        transport,
        client_thread_id: clientThreadId,
        request: normalizedRequest,
        host_result: result
      }
    );
  }
  return pendingCreation(
    'Codex creation was requested but the host has not returned a formal threadId',
    { transport, request: normalizedRequest, host_result: result }
  );
}

function createAdapterEntries(capabilities = {}) {
  const entries = [];
  if (typeof capabilities.create === 'function') {
    entries.push({ transport: capabilities.transport || 'host', adapter: capabilities.create });
  }
  for (const transport of ['desktop', 'sdk', 'api']) {
    const direct = capabilities[`${transport}Create`];
    const nested = capabilities[transport] && typeof capabilities[transport] === 'object'
      ? capabilities[transport].create
      : null;
    if (typeof direct === 'function') entries.push({ transport, adapter: direct });
    else if (typeof nested === 'function') entries.push({ transport, adapter: nested });
  }
  return entries;
}

function create(request, capabilities = {}, options = {}) {
  const normalized = normalizeCreateRequest(request);
  if (options.dryRun) normalized.dryRun = true;
  if (!normalized.title || !normalized.prompt) return creationFailed('title and prompt are required');
  if (normalized.dryRun) return pendingCreation('dry-run; no Codex host transport was executed', { request: normalized });

  const entries = createAdapterEntries(capabilities);
  if (!entries.length) {
    return pendingCreation(
      'Codex Desktop creation must be completed by the host; this repository cannot invent or persist a threadId',
      { request: normalized, creation_request: normalized, host_action: 'create_thread' }
    );
  }

  const failures = [];
  for (const entry of entries) {
    try {
      const result = entry.adapter({ ...normalized, transport: entry.transport });
      if (result && typeof result.then === 'function') {
        failures.push(`Codex ${entry.transport} adapter requires createAsync()`);
        continue;
      }
      const outcome = normalizeCreateResult(result, normalized, entry.transport);
      if (outcome.status === 'READY' || outcome.status === 'PENDING_CREATION') return outcome;
      failures.push(`${entry.transport}: ${outcome.reason}`);
    } catch (error) {
      failures.push(`Codex ${entry.transport} adapter failed: ${error.message}`);
    }
  }
  return creationFailed(failures.join('; ') || 'No Codex creation adapter returned a result', { request: normalized });
}

async function createAsync(request, capabilities = {}, options = {}) {
  const normalized = normalizeCreateRequest(request);
  if (options.dryRun) normalized.dryRun = true;
  if (!normalized.title || !normalized.prompt) return creationFailed('title and prompt are required');
  if (normalized.dryRun) return pendingCreation('dry-run; no Codex host transport was executed', { request: normalized });

  const entries = createAdapterEntries(capabilities);
  if (!entries.length) {
    return pendingCreation(
      'Codex Desktop creation must be completed by the host; this repository cannot invent or persist a threadId',
      { request: normalized, creation_request: normalized, host_action: 'create_thread' }
    );
  }

  const failures = [];
  for (const entry of entries) {
    try {
      const result = await entry.adapter({ ...normalized, transport: entry.transport });
      const outcome = normalizeCreateResult(result, normalized, entry.transport);
      if (outcome.status === 'READY' || outcome.status === 'PENDING_CREATION') return outcome;
      failures.push(`${entry.transport}: ${outcome.reason}`);
    } catch (error) {
      failures.push(`Codex ${entry.transport} adapter failed: ${error.message}`);
    }
  }
  return creationFailed(failures.join('; ') || 'No Codex creation adapter returned a result', { request: normalized });
}

function lifecycleAdapterEntries(action, capabilities = {}) {
  const entries = [];
  if (typeof capabilities[action] === 'function') entries.push({ transport: capabilities.transport || 'host', adapter: capabilities[action] });
  for (const transport of ['desktop', 'sdk', 'api']) {
    const direct = capabilities[`${transport}${action[0].toUpperCase()}${action.slice(1)}`];
    const nested = capabilities[transport] && typeof capabilities[transport] === 'object'
      ? capabilities[transport][action]
      : null;
    if (typeof direct === 'function') entries.push({ transport, adapter: direct });
    else if (typeof nested === 'function') entries.push({ transport, adapter: nested });
  }
  return entries;
}

function normalizeLifecycleResult(action, result, transport, threadId) {
  if (result && typeof result === 'object' && result.status) return { ...result, action, transport, threadId };
  return { status: 'READY', action, transport, threadId, result };
}

function read(request, capabilities = {}) {
  const threadId = cliDispatch.normalizeThreadId(request);
  if (!threadId) return unsupported('read', 'formal Codex threadId is required; clientThreadId cannot be read');
  const entries = lifecycleAdapterEntries('read', capabilities);
  if (!entries.length) return unsupported('read', 'No Codex read adapter is connected', { threadId });
  try {
    const result = entries[0].adapter({ threadId, thread: threadId, transport: entries[0].transport });
    if (result && typeof result.then === 'function') return prepared('Codex read adapter requires readAsync()', { action: 'read', threadId });
    return normalizeLifecycleResult('read', result, entries[0].transport, threadId);
  } catch (error) {
    return { status: 'READ_FAILED', action: 'read', threadId, reason: error.message };
  }
}

async function readAsync(request, capabilities = {}) {
  const threadId = cliDispatch.normalizeThreadId(request);
  if (!threadId) return unsupported('read', 'formal Codex threadId is required; clientThreadId cannot be read');
  const entries = lifecycleAdapterEntries('read', capabilities);
  if (!entries.length) return unsupported('read', 'No Codex read adapter is connected', { threadId });
  try {
    const entry = entries[0];
    const result = await entry.adapter({ threadId, thread: threadId, transport: entry.transport });
    return normalizeLifecycleResult('read', result, entry.transport, threadId);
  } catch (error) {
    return { status: 'READ_FAILED', action: 'read', threadId, reason: error.message };
  }
}

async function wait(request, capabilities = {}) {
  const threadId = cliDispatch.normalizeThreadId(request);
  if (!threadId) return unsupported('wait', 'formal Codex threadId is required; clientThreadId cannot be waited on');
  const entries = lifecycleAdapterEntries('wait', capabilities);
  if (!entries.length) return unsupported('wait', 'No Codex wait adapter is connected', { threadId });
  try {
    const result = await entries[0].adapter({ threadId, thread: threadId, transport: entries[0].transport });
    return normalizeLifecycleResult('wait', result, entries[0].transport, threadId);
  } catch (error) {
    return { status: 'WAIT_FAILED', action: 'wait', threadId, reason: error.message };
  }
}

function sendAdapterEntries(capabilities = {}) {
  const entries = [];
  if (typeof capabilities.send === 'function') {
    entries.push({ transport: capabilities.transport || 'host', adapter: capabilities.send });
  }
  for (const transport of ['desktop', 'sdk', 'api']) {
    const direct = capabilities[transport];
    const named = capabilities[`${transport}Send`];
    const nested = direct && typeof direct === 'object' ? direct.send : null;
    if (typeof direct === 'function') entries.push({ transport, adapter: direct });
    else if (typeof named === 'function') entries.push({ transport, adapter: named });
    else if (typeof nested === 'function') entries.push({ transport, adapter: nested });
  }
  return entries;
}

function getCapabilities(capabilities = {}) {
  const hasAction = action => lifecycleAdapterEntries(action, capabilities).length > 0;
  const hasCreate = createAdapterEntries(capabilities).length > 0;
  const hasSend = sendAdapterEntries(capabilities).length > 0
    || capabilities.cli === true
    || typeof capabilities.runCli === 'function';
  return {
    vendor: 'codex',
    create: { supported: hasCreate, status: hasCreate ? 'AVAILABLE' : 'PENDING_CREATION' },
    send: { supported: hasSend, status: hasSend ? 'AVAILABLE' : 'UNSUPPORTED' },
    read: { supported: hasAction('read'), status: hasAction('read') ? 'AVAILABLE' : 'UNSUPPORTED' },
    wait: { supported: hasAction('wait'), status: hasAction('wait') ? 'AVAILABLE' : 'UNSUPPORTED' },
    formal_thread_id_required: true,
    client_thread_id_routable: false,
    host_managed_creation: !hasCreate
  };
}

function confirmed(transport, result) {
  return result && result.submitted === true
    ? { status: 'SUBMITTED', submitted: true, transport, result }
    : prepared('Codex adapter did not return explicit submission confirmation', { transport, result });
}

function submit(request, capabilities = {}, options = {}) {
  const normalized = normalizeRequest(request);
  if (!normalized.thread || !normalized.message) return prepared('thread and message are required');
  if (normalized.dryRun) return prepared('dry-run; no Codex transport was executed', { request: normalized });

  const failures = [];
  for (const entry of sendAdapterEntries(capabilities)) {
    const { transport, adapter } = entry;
    if (adapter.constructor && adapter.constructor.name === 'AsyncFunction') {
      failures.push(`Codex ${transport} adapter requires submitAsync()`);
      continue;
    }
    try {
      const result = adapter({ ...normalized, transport });
      if (result && typeof result.then === 'function') {
        failures.push(`Codex ${transport} adapter returned a thenable; use submitAsync()`);
        continue;
      }
      const outcome = confirmed(transport, result);
      if (outcome.submitted === true) return outcome;
      failures.push(`${transport}: ${outcome.reason}`);
    } catch (error) {
      failures.push(`Codex ${transport} adapter failed: ${error.message}`);
    }
  }
  return options.cli !== false
    ? cliDispatch.dispatch(normalized, options.runCli || capabilities.runCli)
    : prepared(failures.join('; ') || 'No Codex Desktop, SDK, API, or CLI transport is available');
}

async function submitAsync(request, capabilities = {}, options = {}) {
  capabilities = capabilities || {};
  const normalized = normalizeRequest(request);
  if (!normalized.thread || !normalized.message) return prepared('thread and message are required');
  if (normalized.dryRun) return prepared('dry-run; no Codex transport was executed', { request: normalized });

  const failures = [];
  for (const entry of sendAdapterEntries(capabilities)) {
    const { transport, adapter } = entry;
    try {
      const outcome = confirmed(transport, await adapter({ ...normalized, transport }));
      if (outcome.submitted === true) return outcome;
      failures.push(`${transport}: ${outcome.reason}`);
    } catch (error) {
      failures.push(`Codex ${transport} adapter failed: ${error.message}`);
    }
  }
  const fallbackOptions = { ...options, runCli: options.runCli || capabilities.runCli };
  return submit(normalized, {}, fallbackOptions);
}

module.exports = {
  normalizeRequest,
  normalizeCreateRequest,
  formalCreateThreadId,
  formalClientThreadId,
  normalizeCreateResult,
  normalizeThreadId: cliDispatch.normalizeThreadId,
  create,
  createAsync,
  submit,
  send: submit,
  submitAsync,
  read,
  readAsync,
  wait,
  getCapabilities,
  prepared,
  pendingCreation,
  creationFailed,
  unsupported
};
