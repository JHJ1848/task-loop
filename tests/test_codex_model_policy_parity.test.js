const assert = require('assert');
const { execFileSync } = require('child_process');
const policy = require('../scripts/providers/codex_model_policy');

const py = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
from scripts.providers import codex_model_policy as p
print(json.dumps({
  "defaults": p.CODEX_MODEL_DEFAULTS,
  "role": p.role_for_session({"module_key": "subagent"}),
  "resolved": p.resolve_model_config({"thinking": "max"}, "topic"),
  "cli": p.to_cli_overrides({"model": "gpt-5.6-terra", "thinking": "xhigh"})
}, sort_keys=True))
`;

const pythonResult = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', py, require('path').resolve(__dirname, '..')], { encoding: 'utf8' }));
assert.deepStrictEqual(pythonResult.defaults, policy.CODEX_MODEL_DEFAULTS);
assert.strictEqual(pythonResult.role, policy.roleForSession({ module_key: 'subagent' }));
assert.deepStrictEqual(pythonResult.resolved, policy.resolveModelConfig({ thinking: 'max' }, 'topic'));
assert.deepStrictEqual(pythonResult.cli, policy.toCliOverrides({ model: 'gpt-5.6-terra', thinking: 'xhigh' }));

console.log('Codex model policy Node/Python parity PASSED!');
