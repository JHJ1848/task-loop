'use strict';

const { POLICY_VALUES } = require('./constants');
const { readText, existingFile, toProjectPath, runtimePaths } = require('./filesystem');
const { inspectFramework } = require('./framework');
const { checkIntegrity } = require('./records');

function inspect(projectRoot, options = {}) {
  const framework = inspectFramework(projectRoot);
  const paths = runtimePaths(projectRoot);
  let policy = { memory_get_mode: 'auto', source: 'default' };
  if (existingFile(paths.policy)) {
    try {
      const parsed = JSON.parse(readText(paths.policy));
      if (POLICY_VALUES.has(parsed.memory_get_mode)) {
        policy = { memory_get_mode: parsed.memory_get_mode, source: 'runtime' };
      } else {
        policy = { invalid: true, source: 'runtime' };
      }
    } catch (error) {
      policy = { invalid: true, source: 'runtime' };
    }
  }

  const integrity = checkIntegrity(projectRoot);

  return {
    status: 'inspected',
    project_root: projectRoot,
    runtime_path: toProjectPath(projectRoot, paths.runtime),
    framework,
    policy,
    integrity,
    summary: framework.status === 'ready' && integrity.status === 'valid'
      ? '项目记忆框架已就绪，所有受控引用完整性校验通过。'
      : `项目记忆框架状态：${framework.status}，引用完整性：${integrity.status}。`,
  };
}

module.exports = { inspect };
