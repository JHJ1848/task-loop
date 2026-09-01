#!/usr/bin/env node
/**
 * Reconcile Task Loop Topics -- [LEGACY v1 工具] 期望 topics[].module_key / registry.modules[key].thread_id 旧结构, 与 Schema v4 不兼容; 对现代状态文件天然 NOOP。保留仅作历史参考, 请勿在新流程使用 (改用 init/new-session)。 (Node.js)
 * Auto-provisions topic thread sessions for enabled topics declared in topics.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function reconcileTopics(projectRoot, manifestPath, registryPath) {
  const root = path.resolve(projectRoot);
  const manifestFile = path.isAbsolute(manifestPath) ? manifestPath : path.join(root, manifestPath);
  const registryFile = path.isAbsolute(registryPath) ? registryPath : path.join(root, registryPath);

  if (!fs.existsSync(manifestFile)) {
    return { action: 'INVALID', reason: `Manifest file not found: ${manifestFile}` };
  }
  if (!fs.existsSync(registryFile)) {
    return { action: 'INVALID', reason: `Registry file not found: ${registryFile}` };
  }

  let manifest, registry;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  } catch (e) {
    return { action: 'INVALID', reason: 'json_parse_error', message: e.message };
  }

  if (!registry.modules) {
    registry.modules = {};
  }

  const provisioned = [];
  let modified = false;

  for (const topic of (manifest.topics || [])) {
    if (!topic || topic.enabled === false) continue;

    const modKey = topic.module_key;
    if (!modKey) continue;

    const regMod = registry.modules[modKey];
    if (!regMod || !regMod.thread_id) {
      const newThreadId = crypto.randomUUID();
      registry.modules[modKey] = {
        thread_id: newThreadId,
        title: topic.title || `Topic ${modKey}`,
        title_prefix: topic.title_prefix || `${modKey}-`,
        memory_docs: topic.memory_docs || [],
        auto_provisioned: true,
        provisioned_at: new Date().toISOString()
      };
      provisioned.push({
        module_key: modKey,
        thread_id: newThreadId,
        title: topic.title
      });
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), 'utf8');
    return {
      action: 'RECONCILED',
      reason: 'topics_provisioned',
      provisioned: provisioned
    };
  } else {
    return {
      action: 'NOOP',
      reason: 'all_topics_registered'
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  let root = '.';
  let manifest = null;
  let registry = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = args[++i];
    else if (args[i] === '--manifest' && args[i + 1]) manifest = args[++i];
    else if (args[i] === '--registry' && args[i + 1]) registry = args[++i];
  }

  if (!manifest || !registry) {
    console.error('Missing required arguments: --manifest, --registry');
    process.exit(1);
  }

  const result = reconcileTopics(root, manifest, registry);
  console.log(JSON.stringify(result));
  if (result.action === 'INVALID') process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = { reconcileTopics };
