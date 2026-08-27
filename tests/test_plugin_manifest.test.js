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

  // 4. Verify 6 independent skills
  const expectedSkills = ['task-loop', 'session-control', 'subagent', 'hook', 'init', 'new-session'];
  for (const skillName of expectedSkills) {
    const skillPath = path.join(rootDir, 'skills', skillName, 'SKILL.md');
    assert.strictEqual(fs.existsSync(skillPath), true, `skills/${skillName}/SKILL.md must exist`);
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.startsWith('---'), `skills/${skillName}/SKILL.md must have YAML frontmatter`);
    assert.ok(content.includes('description: "[task-loop]'), `skills/${skillName}/SKILL.md description must start with [task-loop]`);
  }

  console.log('Node.js Plugin Manifest & 5 Independent Skills Tests PASSED!');
}

runPluginManifestTests();
