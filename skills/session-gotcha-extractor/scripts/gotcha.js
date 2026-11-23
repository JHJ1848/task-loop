#!/usr/bin/env node
/**
 * @file gotcha.js
 * @description Plugin 级内置记忆自迭代 CLI，支持动态目标工程解耦、安全路径边界限制、Schema 版本化与双层 JSONL 路由。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CURRENT_SCHEMA_VERSION = 1;
const GLOBAL_GOTCHAS_PATH = path.join(os.homedir(), '.agents', 'gotchas.jsonl');
const VALID_CATEGORIES = ['bugfix', 'dev', 'explore'];
const VALID_SCOPES = ['global', 'project'];
const REQUIRED_FIELDS = [
  'scope', 'category', 'title', 'scene', 'symptom',
  'misjudgment', 'root_cause_and_solution',
  'guidance_and_constraint', 'value_assessment'
];

/**
 * 递归向上查找目标工程根目录
 * @param {string} [startDir=process.cwd()]
 * @returns {string}
 */
function findProjectRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  const markers = ['.git', 'AGENTS.md', '.agents', 'package.json'];
  while (true) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

/**
 * 解析并确定目标工程根目录
 * @param {Record<string, string>} args
 * @returns {string}
 */
function resolveProjectRoot(args) {
  const customRoot = args['project-root'] || args.projectRoot;
  if (customRoot) {
    return path.resolve(process.cwd(), customRoot);
  }
  return findProjectRoot(process.cwd());
}

/**
 * 解析命令行参数为键值对对象
 * @param {string[]} args
 * @returns {Record<string, string>}
 */
function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--global' || arg === '-g') {
      parsed.scope = 'global';
    } else if (arg === '--project' || arg === '-p') {
      parsed.scope = 'project';
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = 'true';
      }
    }
  }
  return parsed;
}

/**
 * 校验自定义 target 路径安全性，防止目录逃逸
 * @param {string} targetPath
 * @param {string} projectRoot
 * @param {string} scope
 */
function assertSafeTargetPath(targetPath, projectRoot, scope) {
  if (!targetPath) return;
  const normTarget = path.normalize(path.resolve(process.cwd(), targetPath));
  if (scope === 'project') {
    const normProjectRoot = path.normalize(path.resolve(projectRoot));
    const rel = path.relative(normProjectRoot, normTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`[gotcha] 安全边界越界拦截: 自定义 target '${targetPath}' 超出项目根目录范围 (${normProjectRoot})`);
    }
  }
}

/**
 * 根据 scope 解析实际物理存储路径
 * @param {string} scope
 * @param {string} projectRoot
 * @param {string} [customTarget]
 * @returns {string}
 */
function resolveTargetPath(scope, projectRoot, customTarget) {
  if (customTarget) {
    assertSafeTargetPath(customTarget, projectRoot, scope);
    return path.resolve(process.cwd(), customTarget);
  }
  if (scope === 'global') return GLOBAL_GOTCHAS_PATH;
  return path.join(projectRoot, '.agents', 'gotchas.jsonl');
}

/**
 * 校验单条 Gotcha 记录合法性
 * @param {object} item
 * @param {number} [lineNum=0]
 * @returns {string[]} 错误信息列表
 */
function validateEntry(item, lineNum = 0) {
  const errors = [];
  const prefix = lineNum > 0 ? `第 ${lineNum} 行: ` : '';

  // Schema 版本校验与向前兼容
  if (item.schema_version !== undefined) {
    if (typeof item.schema_version !== 'number' || !Number.isInteger(item.schema_version) || item.schema_version <= 0) {
      errors.push(`${prefix}schema_version 必须为正整数 (如 1)`);
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!item[field]) {
      if (field === 'scope') {
        item.scope = 'project';
      } else {
        errors.push(`${prefix}缺少必要字段 '${field}'`);
      }
    }
  }

  if (item.scope && !VALID_SCOPES.includes(item.scope)) {
    errors.push(`${prefix}scope '${item.scope}' 不合法，必须为: ${VALID_SCOPES.join(', ')}`);
  }
  if (item.category && !VALID_CATEGORIES.includes(item.category)) {
    errors.push(`${prefix}category '${item.category}' 不合法，必须为: ${VALID_CATEGORIES.join(', ')}`);
  }
  if (item.guidance_and_constraint) {
    if (typeof item.guidance_and_constraint.guidance !== 'string' || !item.guidance_and_constraint.guidance.trim()) {
      errors.push(`${prefix}guidance_and_constraint.guidance 必须为非空字符串`);
    }
    if (typeof item.guidance_and_constraint.constraint !== 'string' || !item.guidance_and_constraint.constraint.trim()) {
      errors.push(`${prefix}guidance_and_constraint.constraint 必须为非空字符串`);
    }
  }
  if (item.value_assessment) {
    if (!['high', 'medium'].includes(item.value_assessment.level)) {
      errors.push(`${prefix}value_assessment.level 必须为 'high' 或 'medium'`);
    }
    if (typeof item.value_assessment.rationale !== 'string' || !item.value_assessment.rationale.trim()) {
      errors.push(`${prefix}value_assessment.rationale 必须为非空字符串`);
    }
  }
  return errors;
}

/**
 * 确保项目级存储就绪
 * @param {string} projectRoot
 */
function ensureProjectGotchasReady(projectRoot) {
  const projectGotchasPath = path.join(projectRoot, '.agents', 'gotchas.jsonl');
  const legacyGotchasPath = path.join(projectRoot, 'docs', 'gotchas.jsonl');

  if (!fs.existsSync(projectGotchasPath)) {
    let seedContent = '';
    if (fs.existsSync(legacyGotchasPath)) {
      const oldLines = fs.readFileSync(legacyGotchasPath, 'utf8').split(/\r?\n/).filter(l => l.trim().length > 0);
      seedContent = oldLines.map(l => {
        try {
          const parsed = JSON.parse(l);
          if (!parsed.scope) parsed.scope = 'project';
          if (!parsed.schema_version) parsed.schema_version = CURRENT_SCHEMA_VERSION;
          return JSON.stringify(parsed);
        } catch {
          return l;
        }
      }).join('\n') + '\n';
    }
    fs.mkdirSync(path.dirname(projectGotchasPath), { recursive: true });
    fs.writeFileSync(projectGotchasPath, seedContent, 'utf8');
  }
}

/**
 * 校验目标 JSONL 文件
 * @param {string} targetPath
 * @param {string} label
 * @returns {number}
 */
function validateFile(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    console.log(`[gotcha] [${label}] 存储文件不存在 (跳过): ${targetPath}`);
    return 0;
  }
  const content = fs.readFileSync(targetPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  let totalErrors = [];

  lines.forEach((line, idx) => {
    try {
      const item = JSON.parse(line);
      const errs = validateEntry(item, idx + 1);
      if (errs.length > 0) totalErrors.push(...errs);
    } catch (e) {
      totalErrors.push(`第 ${idx + 1} 行不是有效 JSON: ${e.message}`);
    }
  });

  if (totalErrors.length > 0) {
    console.error(`[gotcha] [${label}] 校验失败 (${totalErrors.length} 处错误):`);
    totalErrors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }
  console.log(`[gotcha] [${label}] 校验通过: ${lines.length} 条规范记录 (${targetPath})`);
  return lines.length;
}

/**
 * 子命令: 校验文件
 * @param {Record<string, string>} args
 */
function handleValidate(args) {
  const projectRoot = resolveProjectRoot(args);
  ensureProjectGotchasReady(projectRoot);
  const scope = args.scope || 'all';

  const projectGotchasPath = path.join(projectRoot, '.agents', 'gotchas.jsonl');
  const legacyGotchasPath = path.join(projectRoot, 'docs', 'gotchas.jsonl');

  if (scope === 'project' || scope === 'all') {
    validateFile(projectGotchasPath, '项目级');
  }
  if (scope === 'global' || scope === 'all') {
    validateFile(GLOBAL_GOTCHAS_PATH, '全局级');
  }
  if (fs.existsSync(legacyGotchasPath)) {
    validateFile(legacyGotchasPath, '兼容历史');
  }
  console.log(`[gotcha] 校验执行完毕，工程根目录: ${projectRoot}`);
}

/**
 * 子命令: 追加记录
 * @param {Record<string, string>} args
 */
function handleAppend(args) {
  const projectRoot = resolveProjectRoot(args);
  ensureProjectGotchasReady(projectRoot);

  let entry = {};
  if (args.file) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), args.file), 'utf8');
    entry = JSON.parse(raw);
  } else {
    entry = {
      schema_version: CURRENT_SCHEMA_VERSION,
      scope: args.scope || (args.global ? 'global' : 'project'),
      category: args.category,
      title: args.title,
      scene: args.scene,
      symptom: args.symptom,
      misjudgment: args.misjudgment,
      root_cause_and_solution: args.solution || args.root_cause_and_solution,
      guidance_and_constraint: {
        guidance: args.guidance,
        constraint: args.constraint
      },
      value_assessment: {
        level: args.level || 'high',
        generality: args.scope === 'global' ? 'universal' : (args.generality || 'project_specific'),
        rationale: args.rationale || args.reason
      }
    };
  }

  // 强制设置 schema_version
  if (!entry.schema_version) {
    entry.schema_version = CURRENT_SCHEMA_VERSION;
  }
  if (!entry.scope) {
    entry.scope = args.scope || (entry.value_assessment?.generality === 'universal' ? 'global' : 'project');
  }

  let targetPath;
  try {
    targetPath = resolveTargetPath(entry.scope, projectRoot, args.target);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

  if (!entry.id) {
    let count = 1;
    if (fs.existsSync(targetPath)) {
      const lines = fs.readFileSync(targetPath, 'utf8').split(/\r?\n/).filter(l => l.trim().length > 0);
      count = lines.length + 1;
    }
    entry.id = `gotcha-${dateStr}-${String(count).padStart(4, '0')}`;
  }
  if (!entry.timestamp) entry.timestamp = now.toISOString();

  const errors = validateEntry(entry);
  if (errors.length > 0) {
    console.error('[gotcha] 记录字段不合法:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  const jsonLine = JSON.stringify(entry) + '\n';
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.appendFileSync(targetPath, jsonLine, 'utf8');
  console.log(`[gotcha] 成功追加到 [${entry.scope.toUpperCase()}] 库 (${targetPath}): [${entry.id}] ${entry.title}`);
}

/**
 * 子命令: 检索列表
 * @param {Record<string, string>} args
 */
function handleList(args) {
  const projectRoot = resolveProjectRoot(args);
  ensureProjectGotchasReady(projectRoot);
  const scope = args.scope || 'all';
  const filterCat = args.category;
  const targets = [];

  const projectGotchasPath = path.join(projectRoot, '.agents', 'gotchas.jsonl');
  if (scope === 'project' || scope === 'all') targets.push({ path: projectGotchasPath, scope: 'project' });
  if (scope === 'global' || scope === 'all') targets.push({ path: GLOBAL_GOTCHAS_PATH, scope: 'global' });

  console.log(`=== Gotchas 经验列表 (工程根目录: ${projectRoot}, Scope: ${scope}, Category: ${filterCat || 'all'}) ===\n`);
  let matched = 0;

  for (const t of targets) {
    if (!fs.existsSync(t.path)) continue;
    const lines = fs.readFileSync(t.path, 'utf8').split(/\r?\n/).filter(l => l.trim().length > 0);
    lines.forEach(line => {
      try {
        const item = JSON.parse(line);
        if (!filterCat || item.category === filterCat) {
          matched++;
          console.log(`[${t.scope.toUpperCase()}] [${item.id}] [v${item.schema_version || 1}] [${item.category}] ${item.title}`);
          console.log(`  * 场景: ${item.scene}`);
          console.log(`  * 根因与解法: ${item.root_cause_and_solution}`);
          console.log(`  * 引导: ${item.guidance_and_constraint?.guidance}`);
          console.log(`  * 硬约束: ${item.guidance_and_constraint?.constraint}`);
          console.log(`  * 价值与通用性: [${item.value_assessment?.level}] [${item.value_assessment?.generality || item.scope}] ${item.value_assessment?.rationale}\n`);
        }
      } catch {}
    });
  }
  console.log(`共检索到 ${matched} 条记录。`);
}

// 主入口分发
const command = process.argv[2];
const parsedArgs = parseArgs(process.argv.slice(3));

switch (command) {
  case 'append':
    handleAppend(parsedArgs);
    break;
  case 'list':
    handleList(parsedArgs);
    break;
  case 'validate':
    handleValidate(parsedArgs);
    break;
  default:
    console.log(`用法: node gotcha.js <append|list|validate> [options]
  append   追加记录 (--scope <project|global> --project-root <dir> --category <bugfix|dev|explore> --title <str> ...)
  list     列出记录 (--scope <project|global|all> --project-root <dir> --category <bugfix|dev|explore>)
  validate 校验完整性 (--scope <project|global|all> --project-root <dir>)`);
    break;
}
