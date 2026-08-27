const fs = require('fs');
const path = require('path');
const assert = require('assert');

function runPluginManifestTests() {
  const rootDir = path.resolve(__dirname, '..');
  
  // 1. Verify plugin.json
  const pluginJsonPath = path.join(rootDir, 'plugin.json');
  assert.strictEqual(fs.existsSync(pluginJsonPath), true, 'plugin.json must exist at root');
  const pluginData = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  assert.strictEqual(pluginData.name, 'task-loop', 'plugin name must be task-loop');
  assert.ok(pluginData.version, 'plugin must have version');
  assert.ok(pluginData.capabilities, 'plugin must declare capabilities');
  
  // 2. Verify hooks.json
  const hooksJsonPath = path.join(rootDir, 'hooks.json');
  assert.strictEqual(fs.existsSync(hooksJsonPath), true, 'hooks.json must exist at root');
  const hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  assert.ok(hooksData['session-context-injector'], 'session-context-injector hook must be declared');
  assert.ok(hooksData['allowlist-safety-gate'], 'allowlist-safety-gate hook must be declared');

  // 3. Verify rules
  const rulesPath = path.join(rootDir, 'rules', 'task-loop-governance.md');
  assert.strictEqual(fs.existsSync(rulesPath), true, 'rules/task-loop-governance.md must exist');

  // 4. Verify 5 independent skills
  const expectedSkills = ['task-loop', 'session-control', 'subagent', 'hook', 'init'];
  for (const skillName of expectedSkills) {
    const skillPath = path.join(rootDir, 'skills', skillName, 'SKILL.md');
    assert.strictEqual(fs.existsSync(skillPath), true, `skills/${skillName}/SKILL.md must exist`);
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.startsWith('---'), `skills/${skillName}/SKILL.md must have YAML frontmatter`);
    assert.ok(content.includes('description: "[task-loop]'), `skills/${skillName}/SKILL.md description must start with [task-loop]`);
  }

  // 5. Verify ZCode plugin layer (ZCode branch adaptation)
  const zcodeManifestPath = path.join(rootDir, '.zcode-plugin', 'plugin.json');
  assert.strictEqual(fs.existsSync(zcodeManifestPath), true, '.zcode-plugin/plugin.json must exist');
  const zcodeManifest = JSON.parse(fs.readFileSync(zcodeManifestPath, 'utf8'));
  assert.ok(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(zcodeManifest.name), '.zcode-plugin name must satisfy the ZCode manifest regex');
  assert.strictEqual(zcodeManifest.name, 'task-loop');
  assert.ok(zcodeManifest.skills, '.zcode-plugin must declare skills component');

  const zcodeHooksPath = path.join(rootDir, 'hooks', 'hooks.json');
  assert.strictEqual(fs.existsSync(zcodeHooksPath), true, 'hooks/hooks.json must exist for ZCode');
  const zcodeHooks = JSON.parse(fs.readFileSync(zcodeHooksPath, 'utf8'));
  assert.ok(zcodeHooks.hooks, 'ZCode hooks.json must use the outer hooks wrapper');
  const allowedEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
  for (const [eventName, matchers] of Object.entries(zcodeHooks.hooks)) {
    assert.ok(allowedEvents.includes(eventName), `unsupported ZCode hook event: ${eventName}`);
    assert.ok(Array.isArray(matchers) && matchers.length > 0, `${eventName} must list matcher entries`);
    for (const entry of matchers) {
      assert.ok(Array.isArray(entry.hooks) && entry.hooks.length > 0, `${eventName} matcher must contain hook commands`);
      for (const h of entry.hooks) {
        assert.ok(h.type === 'command' || h.type === 'process', 'hook type must be command or process');
        if (h.type === 'command') {
          assert.ok(typeof h.timeout === 'number' && h.timeout < 60, 'command timeout must be seconds-valued and small');
        }
        assert.ok(
          h.command.includes('${CLAUDE_PLUGIN_ROOT}') || h.command.includes('${ZCODE_PLUGIN_ROOT}'),
          'plugin hook command must be plugin-root relative'
        );
      }
    }
  }
  // Inject + gate script targets referenced by the ZCode hook config must exist
  const zcodeHookCommands = JSON.stringify(zcodeHooks);
  for (const script of ['inject_session_context_zcode.js', 'enforce_allowlist_zcode.js']) {
    assert.ok(zcodeHookCommands.includes(script), `hooks/hooks.json must reference ${script}`);
    assert.strictEqual(
      fs.existsSync(path.join(rootDir, 'scripts', 'hooks', script)),
      true,
      `scripts/hooks/${script} must exist`
    );
  }

  console.log('Node.js Plugin Manifest & 5 Independent Skills Tests PASSED!');
}

runPluginManifestTests();
