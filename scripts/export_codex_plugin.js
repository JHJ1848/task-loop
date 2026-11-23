#!/usr/bin/env node
'use strict';

/**
 * Build an isolated Codex candidate package without touching installed plugins.
 * The output directory must be new and outside this repository.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATE_NAME = 'session-memory-workflow';
const SOURCE_DIRS = [
  'contracts',
  'rules',
  'skills/task-loop',
  'skills/discuss',
  'skills/bugfix-dev',
  'skills/workflow',
  'skills/explore',
  'skills/session-gotcha-extractor',
  'skills/project-memory',
  'skills/memory-get',
  'skills/memory-put',
  'skills/memory-init',
  'skills/session-init',
  'skills/init',
  'skills/new-session',
  'skills/create-task',
  'skills/session-control',
];
const SOURCE_FILES = [
  'references/gotchas.md',
  'references/dispatch-contract.md',
  'references/sdk/README.md',
  'references/sdk/codex.md',
  'references/sdk/session.md',
  'references/sdk/hook.md',
  'references/sdk/question.md',
  'scripts/init_task_loop.js',
  'scripts/init_task_loop.py',
  'scripts/new_topic_session.js',
  'scripts/new_topic_session.py',
  'scripts/task_loop_state.js',
  'scripts/task_loop_state.py',
  'scripts/query_task_loop_state.js',
  'scripts/query_task_loop_state.py',
  'scripts/test_task_loop_preflight.js',
  'scripts/test_task_loop_preflight.py',
  'scripts/new_task_loop_dispatch_packet.js',
  'scripts/new_task_loop_dispatch_packet.py',
  'scripts/acquire_task_loop_lease.js',
  'scripts/acquire_task_loop_lease.py',
  'scripts/release_task_loop_lease.js',
  'scripts/release_task_loop_lease.py',
  'scripts/providers/spawn_zcode_session.js',
  'scripts/providers/spawn_zcode_session.py',
  'scripts/providers/codex_model_policy.js',
  'scripts/providers/codex_model_policy.py',
  'scripts/providers/codex_session_dispatch.js',
  'scripts/providers/codex_session_dispatch.py',
  'scripts/providers/codex_session_provider.js',
  'scripts/providers/codex_session_provider.py',
  'scripts/providers/get_agy_project_sessions.js',
  'scripts/providers/get_agy_project_sessions.py',
  'scripts/providers/get_codex_project_sessions.js',
  'scripts/providers/get_codex_project_sessions.py',
  'scripts/providers/get_claude_project_sessions.js',
  'scripts/providers/get_claude_project_sessions.py',
  'scripts/providers/get_zcode_project_sessions.js',
  'scripts/providers/get_zcode_project_sessions.py',
  'scripts/hooks/codex_main_intake.js',
  'scripts/hooks/codex_session_health.js',
  'hooks/codex-session-health.json',
];
const MANIFEST_SOURCE = '.codex-plugin/session-memory-workflow/plugin.json';
const MARKETPLACE_SOURCE = '.codex-plugin/session-memory-workflow/marketplace.json';
const REQUIRED_RULES = ['rules/engineering-principles.md', 'rules/task-loop-governance.md'];
const REQUIRED_CONTRACTS = ['contracts/capabilities.json', 'contracts/error-codes.json'];
const SKILL_ENTRY_BUDGET_BYTES = 2 * 1024;

function parseArgs(argv) {
  const options = { check: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--check') {
      options.check = true;
    } else if (token === '--out' && argv[index + 1]) {
      options.out = argv[++index];
    } else {
      throw new Error('用法：export_codex_plugin.js --check | --out <新建且位于仓库外的目录>');
    }
  }
  if (!options.check && !options.out) {
    throw new Error('导出需要 --out <目录>；--check 只校验候选包源文件。');
  }
  return options;
}

function normalize(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function assertNoOverlap(sourceRoot, outputRoot) {
  const source = normalize(sourceRoot);
  const output = normalize(outputRoot);
  if (output === source || output.startsWith(`${source}${path.sep}`) || source.startsWith(`${output}${path.sep}`)) {
    throw new Error('候选导出目录不能是仓库本身、仓库子目录或其父目录。请指定仓库外的新目录。');
  }
}

function requireFile(root, relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`候选包缺少必需文件：${relativePath}`);
  }
  return absolute;
}

function requireDirectory(root, relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`候选包缺少必需目录：${relativePath}`);
  }
  return absolute;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`候选包拒绝符号链接：${fullPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function walkPackagedEntries(root) {
  const entries = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (!isPackagedPath(fullPath)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`候选包拒绝符号链接：${fullPath}`);
    }
    if (entry.isDirectory()) {
      entries.push({ path: fullPath, type: 'directory' });
      entries.push(...walkPackagedEntries(fullPath));
    } else if (entry.isFile()) {
      entries.push({ path: fullPath, type: 'file' });
    }
  }
  return entries;
}

function validateManifest(root) {
  const manifest = readJson(requireFile(root, MANIFEST_SOURCE));
  if (manifest.name !== CANDIDATE_NAME || manifest.skills !== './skills/' || manifest.hooks !== './hooks/codex-session-health.json') {
    throw new Error('候选 Codex 清单必须使用独立 ID，并声明 skills 与统一的 UserPromptSubmit Hook 入口。');
  }
  const marketplace = readJson(requireFile(root, MARKETPLACE_SOURCE));
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1 || marketplace.plugins[0].name !== CANDIDATE_NAME || marketplace.plugins[0].source !== './') {
    throw new Error('候选市场清单未与 session-memory-workflow 身份一致。');
  }
  return { manifest, marketplace };
}

function normalizePackagePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

function isPackagedPath(filePath) {
  return !String(filePath).split(/[\\/]+/).some((name) =>
    name === '__pycache__' || name === '.git' || name.endsWith('.pyc') || name.endsWith('.jsonl')
  );
}

function buildPackageInventory(
  root,
  sourceDirs = SOURCE_DIRS,
  sourceFiles = SOURCE_FILES,
  requiredPaths = [...REQUIRED_RULES, ...REQUIRED_CONTRACTS],
) {
  const files = new Set();
  const directories = new Set(['']);
  const addDirectory = (relativePath) => {
    let current = normalizePackagePath(relativePath);
    while (current) {
      directories.add(current);
      const parent = path.posix.dirname(current);
      current = parent === '.' ? '' : parent;
    }
  };
  const addFile = (relativePath) => {
    const normalized = normalizePackagePath(relativePath);
    files.add(normalized);
    addDirectory(path.posix.dirname(normalized));
  };

  for (const relativePath of sourceDirs) {
    const directory = requireDirectory(root, relativePath);
    addDirectory(relativePath);
    for (const entry of walkPackagedEntries(directory)) {
      if (entry.type === 'directory') addDirectory(path.relative(root, entry.path));
      else addFile(path.relative(root, entry.path));
    }
  }
  for (const relativePath of [...sourceFiles, ...requiredPaths]) {
    requireFile(root, relativePath);
    addFile(relativePath);
  }
  return { files, directories };
}

function unquoteFrontmatterValue(value) {
  const trimmed = String(value || '').trim();
  const quoted = trimmed.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

function readSkillFrontmatter(entryPath) {
  const content = fs.readFileSync(entryPath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Skill 入口缺少 YAML frontmatter：${entryPath}`);
  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+?)\s*$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+?)\s*$/m);
  if (!nameMatch || !unquoteFrontmatterValue(nameMatch[1])) {
    throw new Error(`Skill 入口缺少 name：${entryPath}`);
  }
  if (!descriptionMatch || !unquoteFrontmatterValue(descriptionMatch[1])) {
    throw new Error(`Skill 入口缺少 description：${entryPath}`);
  }
  return {
    content,
    name: unquoteFrontmatterValue(nameMatch[1]),
    description: unquoteFrontmatterValue(descriptionMatch[1]),
  };
}

function markdownLinkTargets(markdown) {
  const targets = [];
  const source = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\r\n]*`/g, '');
  const definitions = new Map();
  const definitionPattern = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>\r\n]+)>|(\S+)).*$/gm;
  let match;
  while ((match = definitionPattern.exec(source))) {
    definitions.set(match[1].trim().replace(/\s+/g, ' ').toLowerCase(), match[2] || match[3]);
  }
  const inlineStart = /!?\[[^\]]*\]\(/g;
  while ((match = inlineStart.exec(source))) {
    let index = inlineStart.lastIndex;
    while (/\s/.test(source[index] || '')) index += 1;
    if (source[index] === '<') {
      const end = source.indexOf('>', index + 1);
      if (end !== -1) targets.push(source.slice(index + 1, end));
      continue;
    }
    const start = index;
    let depth = 0;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/.test(character) && depth === 0) {
        break;
      }
      index += 1;
    }
    if (index > start) targets.push(source.slice(start, index));
  }
  const referencePattern = /!?\[([^\]]+)\](?:\[([^\]]*)\])?/g;
  while ((match = referencePattern.exec(source))) {
    if (source[referencePattern.lastIndex] === '(') continue;
    const label = (match[2] === undefined ? match[1] : (match[2] || match[1])).trim().replace(/\s+/g, ' ').toLowerCase();
    if (definitions.has(label)) targets.push(definitions.get(label));
  }
  return targets;
}

function localReferencePath(target) {
  const raw = String(target || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;
  if (/^file:/i.test(raw) || /^(?:[A-Za-z]:[\\/]|[\\/]{2}|[\\/]|~[\\/])/.test(raw)) {
    throw new Error(`包外本地链接：${raw}`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(raw)) return null;
  const withoutFragment = raw.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch (_) {
    throw new Error(`Skill 链接编码无效：${raw}`);
  }
}

function validateSkillEntrypoints(root, inventory, sourceDirs = SOURCE_DIRS) {
  const packageInventory = inventory || buildPackageInventory(root, sourceDirs);
  const entries = [];
  for (const skillPath of sourceDirs.filter((value) => value.startsWith('skills/'))) {
    const skillDirectory = requireDirectory(root, skillPath);
    const entryPath = requireFile(root, path.posix.join(skillPath, 'SKILL.md'));
    const frontmatter = readSkillFrontmatter(entryPath);
    const expectedName = path.basename(skillDirectory);
    if (frontmatter.name !== expectedName) {
      throw new Error(`Skill name 必须与目录一致：${skillPath} 声明 ${frontmatter.name}`);
    }
    for (const target of markdownLinkTargets(frontmatter.content)) {
      const localPath = localReferencePath(target);
      if (!localPath) continue;
      const resolved = path.resolve(path.dirname(entryPath), localPath);
      const relative = path.relative(root, resolved);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Skill ${skillPath} 引用了包外本地链接：${target}`);
      }
      const packagePath = normalizePackagePath(relative);
      if (!packageInventory.files.has(packagePath) && !packageInventory.directories.has(packagePath)) {
        throw new Error(`Skill ${skillPath} 引用了未打包的本地资源：${target}`);
      }
    }
    entries.push({
      name: frontmatter.name,
      entry: normalizePackagePath(path.relative(root, entryPath)),
      entry_utf8_bytes: Buffer.byteLength(frontmatter.content, 'utf8'),
      description_utf8_bytes: Buffer.byteLength(frontmatter.description, 'utf8'),
    });
  }
  const entryTotalBytes = entries.reduce((total, entry) => total + entry.entry_utf8_bytes, 0);
  const entryMaxBytes = entries.reduce((max, entry) => Math.max(max, entry.entry_utf8_bytes), 0);
  const descriptionTotalBytes = entries.reduce((total, entry) => total + entry.description_utf8_bytes, 0);
  const descriptionMaxBytes = entries.reduce((max, entry) => Math.max(max, entry.description_utf8_bytes), 0);
  const overBudgetEntries = entries.filter((entry) => entry.entry_utf8_bytes > SKILL_ENTRY_BUDGET_BYTES);
  return {
    count: entries.length,
    entries,
    entry_utf8: {
      total_bytes: entryTotalBytes,
      max_bytes: entryMaxBytes,
      budget_per_skill_bytes: SKILL_ENTRY_BUDGET_BYTES,
      over_budget_entries: overBudgetEntries,
      advisory: overBudgetEntries.length > 0
        ? '存在整份 SKILL.md 超过 2 KiB 的入口；仅作审查提示，不阻断导出。'
        : null,
    },
    description_utf8: {
      total_bytes: descriptionTotalBytes,
      max_bytes: descriptionMaxBytes,
    },
  };
}

function validateCandidateStructure(root, manifestValidator) {
  validateRuntimeClosure(root);
  const metadata = manifestValidator(root);
  validateHookReachability(root);
  return { ...metadata, skill_summary: validateSkillEntrypoints(root) };
}

function validateSource(root) {
  return validateCandidateStructure(root, validateManifest);
}

function copyDirectory(sourceRoot, outputRoot, relativePath) {
  fs.cpSync(path.join(sourceRoot, relativePath), path.join(outputRoot, relativePath), {
    recursive: true,
    filter: isPackagedPath,
  });
}

function copyFile(sourceRoot, outputRoot, relativePath) {
  const target = path.join(outputRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, relativePath), target);
}

function copyFileAs(sourceRoot, sourceRelativePath, targetRoot, targetRelativePath) {
  const target = path.join(targetRoot, targetRelativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, sourceRelativePath), target);
}

function validateHookReachability(outputRoot) {
  const hookFile = path.join(outputRoot, 'hooks', 'codex-session-health.json');
  const hookDocument = readJson(hookFile);
  if (JSON.stringify(Object.keys(hookDocument.hooks || {})) !== '["UserPromptSubmit"]') {
    throw new Error('Codex 候选只能注册 UserPromptSubmit 提醒');
  }
  const commands = [];
  for (const hookGroup of Object.values(hookDocument.hooks || {})) {
    for (const event of hookGroup) {
      for (const hook of event.hooks || []) {
        if (typeof hook.command === 'string') commands.push(hook.command);
      }
    }
  }
  // One process owns both advisories; the health module is its local dependency.
  if (commands.length !== 1 ||
      commands[0] !== 'node "${PLUGIN_ROOT}/scripts/hooks/codex_main_intake.js"') {
    throw new Error('Codex Hook 必须仅注册统一的 codex_main_intake.js 入口');
  }
  const entry = fs.readFileSync(path.join(outputRoot, 'scripts', 'hooks', 'codex_main_intake.js'), 'utf8');
  if (!entry.includes("require('./codex_session_health.js')")) {
    throw new Error('Codex Hook 入口缺少会话健康模块依赖');
  }
  for (const relativePath of [
    'scripts/hooks/codex_main_intake.js',
    'scripts/hooks/codex_session_health.js',
  ]) {
    requireFile(outputRoot, relativePath);
  }
}

function sanitizeSourceRootReferences(outputRoot, sourceRoot) {
  const sourceVariants = new Set([
    path.resolve(sourceRoot),
    path.resolve(sourceRoot).split(path.sep).join('/'),
    path.resolve(sourceRoot).split(path.sep).join('\\'),
  ]);
  for (const filePath of walkFiles(outputRoot)) {
    if (!/\.(?:json|js|md|txt|py)$/i.test(filePath)) continue;
    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;
    for (const sourcePath of sourceVariants) {
      if (sourcePath && content.includes(sourcePath)) {
        content = content.split(sourcePath).join('<project-root>');
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(filePath, content, 'utf8');
  }
}

function assertPortableOutput(outputRoot) {
  const forbidden = [
    { label: '用户目录', pattern: /(?:[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+|\/(?:Users|home)\/)/i },
    { label: '硬编码盘符路径', pattern: /\b[A-Za-z]:[\\/]+(?!mock[\\/]+drive[\\/])[\p{L}\p{N}_.-]/iu },
    { label: '疑似凭据', pattern: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd)\b["']?\s*[:=]\s*["']?(?!<|\[|\*{3,}|redacted|masked)[^\s"'\`,;]{8,}/i },
  ];
  const findings = [];
  for (const filePath of walkFiles(outputRoot)) {
    if (!/\.(?:json|js|md|txt|py)$/i.test(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(content)) {
        findings.push({ file: path.relative(outputRoot, filePath).split(path.sep).join('/'), rule: rule.label });
      }
    }
  }
  if (findings.length > 0) {
    throw new Error(`候选包包含不可移植内容：${findings.map((item) => `${item.file} (${item.rule})`).join(', ')}`);
  }
}

function validateExportedManifest(outputRoot) {
  const manifest = readJson(requireFile(outputRoot, '.codex-plugin/plugin.json'));
  if (manifest.name !== CANDIDATE_NAME || manifest.skills !== './skills/' || manifest.hooks !== './hooks/codex-session-health.json') {
    throw new Error('导出的 Codex 清单未保持 session-memory-workflow 候选身份。');
  }
  const marketplaces = ['marketplace.json', '.claude-plugin/marketplace.json'];
  for (const relativePath of marketplaces) {
    const marketplace = readJson(requireFile(outputRoot, relativePath));
    if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1 || marketplace.plugins[0].name !== CANDIDATE_NAME || marketplace.plugins[0].source !== './') {
      throw new Error(`导出的候选市场清单不正确：${relativePath}`);
    }
  }
  return { manifest, marketplaces };
}

function validateRuntimeClosure(outputRoot) {
  for (const directory of SOURCE_DIRS) requireDirectory(outputRoot, directory);
  for (const file of SOURCE_FILES) requireFile(outputRoot, file);
  for (const file of REQUIRED_RULES) requireFile(outputRoot, file);
  for (const file of REQUIRED_CONTRACTS) requireFile(outputRoot, file);
}

function stagingRoot() {
  const root = path.join(os.tmpdir(), 'session-memory-workflow-export');
  fs.mkdirSync(root, { recursive: true });
  return fs.realpathSync(root);
}

function removeOwnedStaging(staging, fixedParent) {
  const parent = normalize(fixedParent);
  const owned = normalize(staging);
  if (!owned.startsWith(`${parent}${path.sep}`)) {
    throw new Error('拒绝清理固定临时目录之外的路径。');
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

function exportCandidate(sourceRoot, outputRoot) {
  const target = path.resolve(outputRoot);
  assertNoOverlap(sourceRoot, target);
  if (fs.existsSync(target)) {
    throw new Error('候选导出目录已存在。为避免覆盖，请指定一个尚不存在的目录。');
  }

  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('候选导出目录的父目录必须已存在。');
  }
  const fixedStagingRoot = stagingRoot();
  const staging = fs.mkdtempSync(path.join(fixedStagingRoot, `${CANDIDATE_NAME}-`));
  try {
    for (const directory of SOURCE_DIRS) copyDirectory(sourceRoot, staging, directory);
    for (const file of SOURCE_FILES) copyFile(sourceRoot, staging, file);
    copyFileAs(sourceRoot, MANIFEST_SOURCE, staging, '.codex-plugin/plugin.json');
    copyFileAs(sourceRoot, MARKETPLACE_SOURCE, staging, 'marketplace.json');
    copyFileAs(sourceRoot, MARKETPLACE_SOURCE, staging, '.claude-plugin/marketplace.json');
    const staged = validateCandidateStructure(staging, validateExportedManifest);
    sanitizeSourceRootReferences(staging, sourceRoot);
    assertPortableOutput(staging);
    fs.cpSync(staging, target, { recursive: true, errorOnExist: true, force: false });
    return {
      status: 'exported',
      plugin: CANDIDATE_NAME,
      output: target,
      manifest: '.codex-plugin/plugin.json',
      marketplaces: ['marketplace.json', '.claude-plugin/marketplace.json'],
      hooks: [
        'scripts/hooks/codex_main_intake.js',
        'scripts/hooks/codex_session_health.js',
      ],
      skill_summary: staged.skill_summary,
    };
  } catch (error) {
    throw error;
  }
  finally {
    removeOwnedStaging(staging, fixedStagingRoot);
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const sourceRoot = path.resolve(__dirname, '..');
    const source = validateSource(sourceRoot);
    const result = options.check
      ? {
        status: 'checked',
        plugin: source.manifest.name,
        marketplace: source.marketplace.name,
        source_root: sourceRoot,
        required_dirs: SOURCE_DIRS,
        required_files: [...SOURCE_FILES, ...REQUIRED_RULES, ...REQUIRED_CONTRACTS],
        skill_summary: source.skill_summary,
      }
      : exportCandidate(sourceRoot, options.out);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`export_codex_plugin: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  CANDIDATE_NAME,
  SOURCE_DIRS,
  SOURCE_FILES,
  assertNoOverlap,
  assertPortableOutput,
  buildPackageInventory,
  exportCandidate,
  parseArgs,
  sanitizeSourceRootReferences,
  validateExportedManifest,
  validateHookReachability,
  validateRuntimeClosure,
  validateSkillEntrypoints,
  validateSource,
};
