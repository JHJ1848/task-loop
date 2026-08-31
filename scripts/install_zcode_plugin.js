#!/usr/bin/env node
/**
 * [task-loop] Install task-loop Plugin into ZCode Workspace
 *
 * 自动化打包/复制本项目为符合 ZCode 插件规范的独立目录副本，
 * 放置在 ~/.zcode/plugin-workspace/task-loop (或指定的 --dest 路径)。
 *
 * 核心保障:
 * 1. 物理隔离: 导出为独立快照目录，开发态切换 Git 分支不影响已加载的 ZCode 插件。
 * 2. 垃圾清理: 深度递归剔除 __pycache__、.pyc、.idea 等临时文件。
 * 3. 市场生成: 自动在目标根生成 marketplace.json 与 EXPORT-INFO.md，支持本地市场一键 Discover。
 * 4. 自动注册: 可选 --enable 参数，自动在 ~/.zcode/cli/config.json 的 enabledPlugins 中登记。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MANIFEST_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const COPY_DIRS = [
  '.zcode-plugin',
  'hooks',
  'skills',
  'scripts',
  'templates',
  'references',
  'config'
];

const COPY_FILES = [
  'plugin.json',
  'hooks.json',
  'SKILL.md',
  'README.md'
];

const JUNK_ENTRY_NAMES = new Set(['__pycache__', '.idea', '.DS_Store']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveSourceRoot(sourceRoot) {
  const root = path.resolve(sourceRoot || path.join(__dirname, '..'));
  const manifestPath = path.join(root, '.zcode-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `未找到 ${manifestPath} ：请确认当前仓库包含 ZCode 适配层 (.zcode-plugin/)。`
    );
  }
  const manifest = readJson(manifestPath);
  if (!MANIFEST_NAME_REGEX.test(manifest.name || '')) {
    throw new Error(`.zcode-plugin/plugin.json 的 name 字段不满足 ZCode 清单正则 ^[a-z0-9][a-z0-9._-]{0,127}$: "${manifest.name}"`);
  }
  return { root, manifest };
}

function resolveDestRoot(destRoot, pluginName) {
  const workspaceDefault = path.join(os.homedir(), '.zcode', 'plugin-workspace');
  const base = destRoot ? path.resolve(destRoot) : workspaceDefault;
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

function buildMarketplace(pluginName) {
  return {
    name: `${pluginName}-local`,
    description: `${pluginName} 本地插件市场（ZCode 宿主引用源）。`,
    plugins: [
      {
        name: pluginName,
        source: './',
        description: `${pluginName}: 会话感知注入、Allowlist 白名单硬门禁与跨厂商会话反向内省（ZCode 宿主版）。`
      }
    ]
  };
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
    } else if (/\.pyc$/i.test(entry)) {
      fs.rmSync(full, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function installPlugin(options) {
  options = options || {};
  const { root, manifest } = resolveSourceRoot(options.sourceRoot);
  const pluginName = manifest.name;
  const dest = resolveDestRoot(options.destRoot, pluginName);

  // 解析后统一做重叠防护（覆盖 --dest 与默认两种情况）
  const workspaceBase = options.destRoot ? path.resolve(options.destRoot) : path.join(os.homedir(), '.zcode', 'plugin-workspace');
  assertNoOverlap(root, workspaceBase);

  const dryRun = options.check === true;
  const copiedDirs = [];
  const copiedFiles = [];

  if (!dryRun) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
  }

  for (const dir of COPY_DIRS) {
    const srcDir = path.join(root, dir);
    if (!fs.existsSync(srcDir)) continue;
    if (dryRun) {
      copiedDirs.push(dir);
      continue;
    }
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
    if (!dryRun) {
      fs.copyFileSync(srcFile, path.join(dest, file));
    }
    copiedFiles.push(file);
  }

  if (dryRun) {
    return { pluginName, dest, copiedDirs, copiedFiles, cleanedEntries: 0, marketplace: buildMarketplace(pluginName), dryRun };
  }

  const cleanedEntries = stripJunk(dest);
  const marketplace = buildMarketplace(pluginName);
  fs.writeFileSync(
    path.join(dest, 'marketplace.json'),
    JSON.stringify(marketplace, null, 2) + '\n',
    'utf8'
  );

  const stamp = new Date().toISOString();
  fs.writeFileSync(
    path.join(dest, 'EXPORT-INFO.md'),
    [
      '# 导出副本说明',
      '',
      '- 用途: ZCode 本地插件市场引用源，避免引用 Git 工作区（分支切换会改变文件）。',
      `- 来源仓库: ${root}`,
      '- 来源分支: master 单主干统一仓库。',
      '- 导出方式: node scripts/install_zcode_plugin.js (工作区快照)',
      `- 导出时间: ${stamp}`,
      `- 市场清单: 根目录 marketplace.json (市场名 ${marketplace.name}, 插件 ${pluginName})。`,
      '- 刷新方式: 在源仓库重新执行本脚本后在 ZCode 客户端重载插件。'
    ].join('\n') + '\n',
    'utf8'
  );

  return { pluginName, dest, copiedDirs, copiedFiles, cleanedEntries, marketplace, dryRun };
}

function maybeEnableFlag(pluginName, marketName) {
  const configPath = process.env.ZCODE_CLI_CONFIG ||
    path.join(os.homedir(), '.zcode', 'cli', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(`--enable: 未找到 ${configPath} ，跳过注册（可稍后在客户端界面手动启用）。`);
    return false;
  }
  const backupPath = `${configPath}.bak-task-loop-install`;
  fs.copyFileSync(configPath, backupPath);
  const cfg = readJson(configPath);
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.enabledPlugins = cfg.plugins.enabledPlugins || {};
  cfg.plugins.enabledPlugins[`${pluginName}@${marketName}`] = true;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`--enable: 已注册 ${pluginName}@${marketName}=true （原配置备份于 ${backupPath} ）。`);
  return true;
}

function printNextSteps(result) {
  const lines = [
    '',
    '[Install OK] task-loop 已安装至 ZCode 官方本地插件目录:',
    `  ${result.dest}`,
    '',
    '[Next] 请在 ZCode 客户端完成最后一步加载:',
    '  1. 打开 Settings(设置) -> Plugin Management(插件管理) -> Discover(发现) 页;',
    '  2. 点击 [+] 添加本地市场，目录选择:',
    `     ${result.dest}`,
    '     (该目录根部含 marketplace.json，市场名 ' + result.marketplace.name + ');',
    `  3. 在市场列表中选择 ${result.pluginName} 并点击 Install(安装)/Enable(启用);`,
    '  4. 重启会话或 Reload(重载) 插件使 SessionStart/UserPromptSubmit/PreToolUse 生效.',
    '',
    '[Verify] 验证方式:',
    '  - Settings -> Plugin Management 中 task-loop 详情页各 Hook 显示为 runnable;',
    '  - 新会话任意一轮顶部出现 "[Plugin: task-loop | 会话上下文感知]" 注入;',
    '  - 刷新副本: 在源仓库重新执行本脚本即可整目录幂等覆盖.'
  ];
  console.log(lines.join('\n'));
}

function main() {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dest' && args[i + 1]) opt.destRoot = args[++i];
    else if (args[i] === '--check' || args[i] === '--dry-run') opt.check = true;
    else if (args[i] === '--enable') opt.enable = true;
  }

  try {
    const result = installPlugin(opt);
    if (opt.check) {
      console.log('[Check] 源仓库校验通过，安装计划如下（未写入任何文件）:');
      console.log(`  目标: ${result.dest}`);
      console.log(`  目录: ${result.copiedDirs.join(', ')}`);
      console.log(`  文件: ${result.copiedFiles.join(', ')}`);
      console.log(`  市场: ${result.marketplace.name}`);
      return 0;
    }
    console.log(`[Copy] dirs=${result.copiedDirs.length} files=${result.copiedFiles.length} junkPruned=${result.cleanedEntries}`);
    if (opt.enable) {
      maybeEnableFlag(result.pluginName, result.marketplace.name);
    } else {
      console.log('[Hint] 未使用 --enable 时，请在客户端市场中手动 Install 后即为启用状态.');
    }
    printNextSteps(result);
    return 0;
  } catch (err) {
    console.error(`[Install FAIL] ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { installPlugin, buildMarketplace, resolveSourceRoot, resolveDestRoot };
