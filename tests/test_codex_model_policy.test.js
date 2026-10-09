const assert = require('assert');
const policy = require('../scripts/providers/codex_model_policy');

assert.deepStrictEqual(policy.CODEX_MODEL_DEFAULTS.main, { tier: 'orchestrator', model: null, reasoning_effort: 'medium' });
assert.deepStrictEqual(policy.CODEX_MODEL_DEFAULTS.topic, { tier: 'developer', model: null, reasoning_effort: 'xhigh' });
assert.deepStrictEqual(policy.CODEX_MODEL_DEFAULTS.subagent, { tier: 'fast_worker', model: null, reasoning_effort: 'low' });
assert.strictEqual(policy.roleForSession({ module_key: 'subagent' }), 'subagent');

const topic = policy.applyInitialModelConfig({ module_key: 'topic' }, 'topic');
assert.deepStrictEqual(topic.model_config, {
  tier: 'developer', model: null, reasoning_effort: 'xhigh', role: 'topic', source: 'task-loop-default', explicit: false
});

const explicit = { module_key: 'topic', model_config: { model: 'custom-model', reasoning_effort: 'low', source: 'user', explicit: true } };
assert.strictEqual(policy.applyInitialModelConfig(explicit, 'topic'), explicit);
assert.deepStrictEqual(policy.resolveModelConfig({ thinking: 'max' }, 'topic'), {
  tier: 'developer', model: null, reasoning_effort: 'max', role: 'topic'
});

const staleDefault = { module_key: 'subagent', model_config: { tier: 'developer', model: null, reasoning_effort: 'xhigh', role: 'topic', source: 'task-loop-default', explicit: false } };
assert.strictEqual(policy.applyInitialModelConfig(staleDefault, 'subagent').model_config.tier, 'fast_worker');
assert.strictEqual(policy.applyInitialModelConfig(staleDefault, 'subagent').model_config.model, null);
assert.strictEqual(policy.applyInitialModelConfig(staleDefault, 'subagent').model_config.reasoning_effort, 'low');

const createRequest = policy.buildCreateThreadRequest({ projectId: 'project-1', title: 'topic', prompt: 'init', role: 'topic' });
assert.strictEqual(createRequest.model, null);
assert.strictEqual(createRequest.thinking, 'xhigh');
assert.deepStrictEqual(createRequest.target, { type: 'project', projectId: 'project-1', environment: { type: 'worktree' } });

// Custom model override test
const customRequest = policy.buildCreateThreadRequest({ projectId: 'project-1', title: 'custom', prompt: 'init', role: 'topic', model: 'my-custom-model' });
assert.strictEqual(customRequest.model, 'my-custom-model');

console.log('Codex model policy Node.js tests PASSED!');
