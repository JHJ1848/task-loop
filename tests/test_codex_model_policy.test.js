const assert = require('assert');
const policy = require('../scripts/providers/codex_model_policy');

assert.deepStrictEqual(policy.CODEX_MODEL_DEFAULTS.main, { model: 'gpt-6-astra', reasoning_effort: 'medium' });
assert.deepStrictEqual(policy.CODEX_MODEL_DEFAULTS.topic, { model: 'gpt-5.6-terra', reasoning_effort: 'xhigh' });
assert.deepStrictEqual(policy.CODEX_MODEL_DEFAULTS.subagent, { model: 'gpt-5.6-luna', reasoning_effort: 'max' });
assert.strictEqual(policy.roleForSession({ module_key: 'subagent' }), 'subagent');

const topic = policy.applyInitialModelConfig({ module_key: 'topic' }, 'topic');
assert.deepStrictEqual(topic.model_config, {
  model: 'gpt-5.6-terra', reasoning_effort: 'xhigh', role: 'topic', source: 'task-loop-default', explicit: false
});

const explicit = { module_key: 'topic', model_config: { model: 'custom-model', reasoning_effort: 'low', source: 'user', explicit: true } };
assert.strictEqual(policy.applyInitialModelConfig(explicit, 'topic'), explicit);
assert.deepStrictEqual(policy.resolveModelConfig({ thinking: 'max' }, 'topic'), {
  model: 'gpt-5.6-terra', reasoning_effort: 'max', role: 'topic'
});

const staleDefault = { module_key: 'subagent', model_config: { model: 'gpt-5.6-terra', reasoning_effort: 'xhigh', role: 'topic', source: 'task-loop-default', explicit: false } };
assert.strictEqual(policy.applyInitialModelConfig(staleDefault, 'subagent').model_config.model, 'gpt-5.6-luna');
assert.strictEqual(policy.applyInitialModelConfig(staleDefault, 'subagent').model_config.reasoning_effort, 'max');

const createRequest = policy.buildCreateThreadRequest({ projectId: 'project-1', title: 'topic', prompt: 'init', role: 'topic' });
assert.strictEqual(createRequest.model, 'gpt-5.6-terra');
assert.strictEqual(createRequest.thinking, 'xhigh');
assert.deepStrictEqual(createRequest.target, { type: 'project', projectId: 'project-1', environment: { type: 'worktree' } });

console.log('Codex model policy Node.js tests PASSED!');
