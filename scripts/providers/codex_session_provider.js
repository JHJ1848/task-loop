'use strict';

const cliDispatch = require('./codex_session_dispatch');

function prepared(reason, extra = {}) {
  return { status: 'PREPARED_ONLY', submitted: false, reason, ...extra };
}

function normalizeRequest(request = {}) {
  request = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  return {
    thread: request.thread || request.threadId || request.sessionId,
    message: request.message || request.prompt,
    mode: request.mode === 'resume' ? 'resume' : 'queue',
    dryRun: Boolean(request.dryRun || request.dry_run)
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
  for (const transport of ['desktop', 'sdk', 'api']) {
    const adapter = capabilities[transport];
    if (typeof adapter !== 'function') continue;
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
    ? cliDispatch.dispatch(normalized, options.runCli)
    : prepared(failures.join('; ') || 'No Codex Desktop, SDK, API, or CLI transport is available');
}

async function submitAsync(request, capabilities = {}, options = {}) {
  const normalized = normalizeRequest(request);
  if (!normalized.thread || !normalized.message) return prepared('thread and message are required');
  if (normalized.dryRun) return prepared('dry-run; no Codex transport was executed', { request: normalized });

  const failures = [];
  for (const transport of ['desktop', 'sdk', 'api']) {
    const adapter = capabilities[transport];
    if (typeof adapter !== 'function') continue;
    try {
      const outcome = confirmed(transport, await adapter({ ...normalized, transport }));
      if (outcome.submitted === true) return outcome;
      failures.push(`${transport}: ${outcome.reason}`);
    } catch (error) {
      failures.push(`Codex ${transport} adapter failed: ${error.message}`);
    }
  }
  return submit(normalized, {}, options);
}

module.exports = { normalizeRequest, submit, submitAsync };
