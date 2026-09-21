#!/usr/bin/env node
/**
 * [Installer] Install task-loop into Google Antigravity (AGY) official plugins directory
 *
 * 把当前仓库以标准快照方式安装与同步至 Antigravity 官方用户插件目录：
 *   默认目标: ~/.gemini/config/plugins/<plugin-name>/
 *
 * 核心功能与安全防护:
 * 1. 冲突排查与防死锁清理:
 *    - 自动排查并清理历史遗留的 ~/.gemini/antigravity/plugins/task-loop (双副本死锁根因);
 *    - 自动排查并清理历史遗留的 ~/.gemini/config/skills/task-loop (旧技能冲突);
 *    - 严禁触碰或删除持久化数据目录 ~/.gemini/antigravity/plugin_data/ 与项目 .agents/。
 * 2. 白名单快照同步:
 *    - dirs : skills, rules, scripts, templates, references, config, assets, .claude-plugin
 *    - files: plugin.json, hooks.json, marketplace.json, SKILL.md, README.md, LICENSE
 * 3. 插件健康校验 (Validation):
 *    - 验证 6 大核心 Skill (task-loop, session-control, subagent, hook, init, new-session);
 *    - 验证 2 大核心 Hook (session-context-injector, allowlist-safety-gate);
 *    - 若系统已安装 agy CLI，尝试调用 agy plugin validate 进行官方验证。
 *
 * Usage:
 *   node scripts/install_agy_plugin.js                 # 完整安装与同步
 *   node scripts/install_agy_plugin.js --check         # 仅校验源仓库与预览计划，不写入
 *   node scripts/install_agy_plugin.js --dest <path>   # 自定义安装根目录
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const COPY_DIRS = [
  'skills', 'rules', 'scripts', 'templates', 'references',
  'config', 'assets', '.claude-plugin'
];
const COPY_FILES = ['plugin.json', 'hooks.json', 'marketplace.json', 'SKILL.md', 'README.md', 'LICENSE'];
const REQUIRED_SKILLS = ['task-loop', 'session-control', 'subagent', 'hook', 'init', 'new-session'];
const JUNK_ENTRY_NAMES = new Set(['__pycache__', '.idea', '.DS_Store', 'tests']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveSourceRoot(sourceRoot) {
  const root = path.resolve(sourceRoot || path.join(__dirname, '..'));
  const manifestPath = path.join(root, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`未找到 ${manifestPath} ：请确认在 task-loop 仓库根目录下执行。`);
  }
  const manifest = readJson(manifestPath);
  if (!manifest.name) {
    throw new Error(`plugin.json 缺少 name 字段`);
  }
  return { root, manifest };
}

function resolveDestRoot(destRoot, pluginName) {
  const configPluginsDir = path.join(os.homedir(), '.gemini', 'config', 'plugins');
  const base = destRoot ? path.resolve(destRoot) : configPluginsDir;
  return path.join(base, pluginName);
}

function assertNoOverlap(sourceRoot, destRoot) {
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '');
  const s = norm(sourceRoot);
  const d = norm(destRoot);
  if (s === d) {
    throw new Error(`目标目录与源仓库相同 (${s}) ，拒绝安装。`);
  }
  if (d.startsWith(s + path.sep) || s.startsWith(d + path.sep)) {
    throw new Error(`目标目录 (${d}) 与源仓库 (${s}) 存在包含关系，拒绝安装以免自吞。`);
  }
}

function detectLegacyDeadlocks(pluginName) {
  const deadlocks = [];
  const home = os.homedir();

  // 1. 旧版硬编码插件目录 (导致双副本死锁)
  const legacyPluginDir = path.join(home, '.gemini', 'antigravity', 'plugins', pluginName);
  if (fs.existsSync(legacyPluginDir)) {
    deadlocks.push({
      type: 'legacy_plugin_dir',
      path: legacyPluginDir,
      description: '历史旧版插件目录 (优先加载会导致更新不生效，需清理)'
    });
  }

  // 2. 旧版独立技能目录
  const legacySkillDir = path.join(home, '.gemini', 'config', 'skills', pluginName);
  if (fs.existsSync(legacySkillDir)) {
    deadlocks.push({
      type: 'legacy_skill_dir',
      path: legacySkillDir,
      description: '历史旧版独立 Skill 目录 (可能覆盖插件内置技能，需清理)'
    });
  }

  return deadlocks;
}

function stripJunk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (JUNK_ENTRY_NAMES.has(entry)) {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } else if (stat.isDirectory()) {
      removed += stripJunk(full);
    } else if (/\.pyc$/i.test(entry) || /\.tmp$/i.test(entry)) {
      fs.rmSync(full, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function validateInstalledPlugin(dest) {
  const issues = [];
  
  // 1. 验证 manifest
  const manifestPath = path.join(dest, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    issues.push('缺失 plugin.json');
  } else {
    try {
      const manifest = readJson(manifestPath);
      if (manifest.name !== 'task-loop') issues.push(`plugin.json name 异常: ${manifest.name}`);
    } catch (e) {
      issues.push(`plugin.json 语法损坏: ${e.message}`);
    }
  }

  // 2. 验证 hooks.json
  const hooksPath = path.join(dest, 'hooks.json');
  if (!fs.existsSync(hooksPath)) {
    issues.push('缺失 hooks.json');
  } else {
    try {
      const hooks = readJson(hooksPath);
      if (!hooks['session-context-injector']) issues.push('hooks.json 缺失 session-context-injector');
      if (!hooks['allowlist-safety-gate']) issues.push('hooks.json 缺失 allowlist-safety-gate');
    } catch (e) {
      issues.push(`hooks.json 语法损坏: ${e.message}`);
    }
  }

  // 3. 验证 6 大 Skills
  for (const skill of REQUIRED_SKILLS) {
    const skillMd = path.join(dest, 'skills', skill, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      issues.push(`缺失 skills/${skill}/SKILL.md`);
    }
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

function installAgyPlugin(options) {
  options = options || {};
  const { root, manifest } = resolveSourceRoot(options.sourceRoot);
  const pluginName = manifest.name;
  const dest = resolveDestRoot(options.destRoot, pluginName);

  assertNoOverlap(root, dest);

  const dryRun = options.check === true;
  const deadlocks = detectLegacyDeadlocks(pluginName);
  const cleanedDeadlocks = [];

  const copiedDirs = [];
  const copiedFiles = [];

  if (dryRun) {
    for (const dir of COPY_DIRS) {
      if (fs.existsSync(path.join(root, dir))) copiedDirs.push(dir);
    }
    for (const file of COPY_FILES) {
      if (fs.existsSync(path.join(root, file))) copiedFiles.push(file);
    }
    return {
      pluginName,
      source: root,
      dest,
      deadlocks,
      cleanedDeadlocks,
      copiedDirs,
      copiedFiles,
      dryRun: true
    };
  }

  // 1. 清理死锁冲突目录
  for (const item of deadlocks) {
    try {
      fs.rmSync(item.path, { recursive: true, force: true });
      cleanedDeadlocks.push(item);
    } catch (e) {
      console.warn(`[Warn] 清理死锁目录失败: ${item.path} (${e.message})`);
    }
  }

  // 2. 快照同步至目标目录
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  for (const dir of COPY_DIRS) {
    const srcDir = path.join(root, dir);
    if (!fs.existsSync(srcDir)) continue;
    fs.cpSync(srcDir, path.join(dest, dir), {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return !JUNK_ENTRY_NAMES.has(base) && !/\.pyc$/i.test(base);
      }
    });
    copiedDirs.push(dir);
  }

  for (const file of COPY_FILES) {
    const srcFile = path.join(root, file);
    if (!fs.existsSync(srcFile)) continue;
    fs.copyFileSync(srcFile, path.join(dest, file));
    copiedFiles.push(file);
  }

  const junkPruned = stripJunk(dest);

  // 3. 写入导出元数据
  const stamp = new Date().toISOString();
  fs.writeFileSync(
    path.join(dest, 'EXPORT-INFO.md'),
    [
      '# Antigravity 插件导出副本说明',
      '',
      `- 插件名称: ${pluginName}`,
      `- 插件版本: ${manifest.version || '1.6.0'}`,
      `- 来源仓库: ${root}`,
      `- 安装目标: ${dest}`,
      `- 安装时间: ${stamp}`,
      '- 刷新方式: 在 task-loop 仓库根目录下重新运行 node scripts/install_agy_plugin.js 即可覆盖更新。'
    ].join('\n') + '\n',
    'utf8'
  );

  // 4. 健康验证
  const validation = validateInstalledPlugin(dest);

  // 5. 尝试运行 agy CLI validate (可选)
  let agyCliResult = null;
  try {
    const cliCheck = spawnSync('agy', ['--version'], { encoding: 'utf8', shell: true });
    if (cliCheck.status === 0) {
      const valRes = spawnSync('agy', ['plugin', 'validate', dest], { encoding: 'utf8', shell: true });
      agyCliResult = {
        available: true,
        exitCode: valRes.status,
        output: (valRes.stdout || valRes.stderr || '').trim()
      };
    }
  } catch (_) {
    // agy CLI not in PATH
  }

  return {
    pluginName,
    source: root,
    dest,
    deadlocks,
    cleanedDeadlocks,
    copiedDirs,
    copiedFiles,
    junkPruned,
    validation,
    agyCliResult,
    dryRun: false
  };
}

function printReport(res) {
  if (res.dryRun) {
    console.log('================================================================================');
    console.log('[Antigravity Plugin Installer] 预检计划 (Dry Run)');
    console.log('================================================================================');
    console.log(`源仓库路径: ${res.source}`);
    console.log(`目标安装路径: ${res.dest}`);
    console.log(`待复制目录: ${res.copiedDirs.join(', ')}`);
    console.log(`待复制文件: ${res.copiedFiles.join(', ')}`);
    if (res.deadlocks.length > 0) {
      console.log('\n[检测到历史死锁/冲突目录 (执行安装时将自动安全清理)]:');
      res.deadlocks.forEach((d, idx) => {
        console.log(`  ${idx + 1}. [${d.type}] ${d.path} (${d.description})`);
      });
    } else {
      console.log('\n[死锁检测]: 未发现历史冲突目录，环境健康。');
    }
    return;
  }

  console.log('================================================================================');
  console.log('[Antigravity Plugin Installer] 安装与同步成功！');
  console.log('================================================================================');
  console.log(`插件名称: ${res.pluginName}`);
  console.log(`安装路径: ${res.dest}`);
  console.log(`已复制目录 (${res.copiedDirs.length}): ${res.copiedDirs.join(', ')}`);
  console.log(`已复制文件 (${res.copiedFiles.length}): ${res.copiedFiles.join(', ')}`);
  console.log(`清理冗余项: ${res.junkPruned}`);

  if (res.cleanedDeadlocks.length > 0) {
    console.log('\n[已成功清理历史死锁/冲突目录]:');
    res.cleanedDeadlocks.forEach((d, idx) => {
      console.log(`  ${idx + 1}. ${d.path}`);
    });
  }

  console.log('\n[插件健康校验 (Plugin Health Check)]:');
  if (res.validation.valid) {
    console.log('  ✔ 核心 Manifest、2 大 Hooks 与 6 大 Skills 结构完整无损！');
  } else {
    console.log('  ✖ 发现异常项:');
    res.validation.issues.forEach(issue => console.log(`    - ${issue}`));
  }

  if (res.agyCliResult && res.agyCliResult.available) {
    console.log(`  ✔ agy CLI validate 响应: Exit Code ${res.agyCliResult.exitCode}`);
  }

  console.log('\n[生效提示]: 新开会话或在 Antigravity 中重新载入即可立即使用 task-loop 插件！');
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' || args[i] === '--dry-run') options.check = true;
    else if (args[i] === '--dest' && args[i + 1]) options.destRoot = args[++i];
  }

  try {
    const res = installAgyPlugin(options);
    printReport(res);
    return res.validation && !res.validation.valid ? 1 : 0;
  } catch (err) {
    console.error(`[Install FAIL] ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  installAgyPlugin,
  detectLegacyDeadlocks,
  validateInstalledPlugin,
  resolveSourceRoot,
  resolveDestRoot
};
