'use strict';

const { POLICY_VALUES, BOOLEAN_OPTIONS } = require('./constants');
const { fail } = require('./errors');
const { resolveProjectRoot, writeJsonAtomic, toProjectPath } = require('./filesystem');
const { initialize, readPolicy, readPolicyReadOnly } = require('./framework');
const { retrieve } = require('./retrieval');
const { appendMainTaskMaterial, appendChildTaskMaterial, updateTaskPath } = require('./tasks');
const { appendFormalRecord, provisionTopic } = require('./records');
const { rotate, cleanup } = require('./archive-retention');
const { inspect } = require('./inspection');
const { outline } = require('./markdown-outline');

function parseArgs(argv) {
  const [command, ...remaining] = argv;
  if (!command) {
    fail('用法：project-memory.js <inspect|init|provision|policy|get|outline|temp|draft|path|put|rotate|cleanup> [选项]；同标题场景覆盖使用 put --replace --change-record docs/change/<记录>.md。');
  }
  const rest = [...remaining];
  let subcommand = null;
  if (command === 'policy' && rest[0] && !rest[0].startsWith('--')) {
    subcommand = rest.shift();
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      fail(`未预期的参数：${token}`);
    }
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`缺少 --${key} 的取值。`);
    }
    options[key] = value;
    index += 1;
  }
  return { command, subcommand, options };
}

function run(argv) {
  const { command, subcommand, options } = parseArgs(argv);
  const projectRoot = resolveProjectRoot(options.project || options['project-root']);
  let result;
  switch (command) {
    case 'inspect':
      result = inspect(projectRoot);
      break;
    case 'init':
      result = initialize(projectRoot, options);
      break;
    case 'policy': {
      const action = subcommand || (options.set ? 'set' : 'get');
      if (action === 'get') {
        const { paths, policy, source } = readPolicyReadOnly(projectRoot);
        result = { status: 'read', policy, source, path: toProjectPath(projectRoot, paths.policy) };
      } else if (action === 'set') {
        const mode = options.mode || options.set;
        if (!POLICY_VALUES.has(mode)) {
          fail('policy set 需要 --mode only_once|auto|manually|do_not_get。');
        }
        const { paths } = readPolicy(projectRoot);
        writeJsonAtomic(paths.policy, { memory_get_mode: mode });
        result = { status: 'updated', policy: { memory_get_mode: mode }, path: toProjectPath(projectRoot, paths.policy) };
      } else {
        fail('用法：policy get | policy set --mode only_once|auto|manually|do_not_get');
      }
      break;
    }
    case 'get':
      result = retrieve(projectRoot, options);
      break;
    case 'provision':
      result = provisionTopic(projectRoot, options);
      break;
    case 'outline':
      result = outline(projectRoot, options);
      break;
    case 'temp':
      if (options.status) {
        fail('temp 不再支持 --status；证据清单不跟踪任务生命周期状态。');
      }
      result = appendMainTaskMaterial(projectRoot, options);
      break;
    case 'draft':
      result = appendChildTaskMaterial(projectRoot, options);
      break;
    case 'path':
      result = updateTaskPath(projectRoot, options);
      break;
    case 'put':
      result = appendFormalRecord(projectRoot, options);
      break;
    case 'rotate':
      result = rotate(projectRoot);
      break;
    case 'cleanup':
      result = cleanup(projectRoot);
      break;
    default:
      fail('用法：project-memory.js <inspect|init|provision|policy|get|outline|temp|draft|path|put|rotate|cleanup> [--project-root <路径>]');
  }
  return result;
}

module.exports = { run };
