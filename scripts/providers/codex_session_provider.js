'use strict';

const cliDispatch = require('./codex_session_dispatch');

function prepared(reason, extra = {}) {
  return { status: 'PREPARED_ONLY', submitted: false, reason, ...extra };
}

function normalizeRequest(request = {}) {
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

  for (const transport of ['desktop', 'sdk', 'api']) {
    const adapter = capabilities[transport];
    if (typeof adapter !== 'function') continue;
    try {
      return confirmed(transport, adapter({ ...normalized, transport }));
    } catch (error) {
      return prepared(`Codex ${transport} adapter failed: ${error.message}`, { transport });
    }
  }
  if (options.cli !== false) {
    return cliDispatch.dispatch(normalized, options.runCli);
  }
  return prepared('No Codex Desktop, SDK, API, or CLI transport is available');
}

async function submitAsync(request, capabilities = {}, options = {}) {
  const normalized = normalizeRequest(request);
  if (!normalized.thread || !normalized.message) return prepared('thread and message are required');
  if (normalized.dryRun) return prepared('dry-run; no Codex transport was executed', { request: normalized });

  for (const transport of ['desktop', 'sdk', 'api']) {
    const adapter = capabilities[transport];
    if (typeof adapter !== 'function') continue;
    try {
      return confirmed(transport, await adapter({ ...normalized, transport }));
    } catch (error) {
      return prepared(`Codex ${transport} adapter failed: ${error.message}`, { transport });
    }
  }
  return submit(normalized, {}, options);
}

module.exports = { normalizeRequest, submit, submitAsync };
