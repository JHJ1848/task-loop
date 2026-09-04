#!/usr/bin/env node
/**
 * [Provider] ZCode Session Spawn/Send via Headless CLI (Node.js)
 *
 * 实现 SessionProvider 的 spawn / send 原语在 ZCode 宿主的进程外映射：
 *   spawn(projectDir, prompt) -> 无头创建全新会话   (zcode --cwd <dir> -p "<prompt>")
 *   send(sessionId, prompt)   -> 续接既有会话       (zcode --resume <sess_id> -p "<prompt>")
 *
 * CLI 入口形态（zcode 0.16.5 实测）：
 *   ELECTRON_RUN_AS_NODE=1 "<ZCode.exe>" "<resources/glm/zcode.cjs>" <args>
 *   zcode.cjs 兼任 GUI 运行时与 CLI；argv 含 app-server/agent-server 为 electron 模式，否则 cli 模式。
 *
 * 认证前置：无头运行需先完成一次 `zcode login`（OAuth 写 ~/.zcode/v2/credentials.json）。
 * 桌面端模型 API 走进程内本地路由鉴权、密钥不落盘，CLI 无法直接复用桌面登录态。
 *
 * 子命令：
 *   --check                                     输出能力体检 JSON（CLI 发现 + 登录态）
 *   spawn --cwd <dir> --prompt "<text>"         无头创建新会话
 *   send  --session <sess_id> --prompt "<text>" 续接既有会话
 *   （任意子命令 + --dry-run 只打印将执行的命令，不实际运行）
 *
 * 退出码：0 成功；1 CLI 未发现/参数非法；2 未登录；3 执行失败。
 * stdout 恒为单个 JSON 对象。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SESSION_ID_RE = /sess_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * 桌面端同步限制的强制用户提示: 无头会话直接落库, 但桌面端侧边栏列表为启动时的
 * 内存快照, 不监听外部写入。该字段出现在所有 spawn 成功输出中, 调用方(智能体)
 * 必须原样转达给用户, 严禁省略。
 */
const DESKTOP_SYNC_NOTICE =
  '【必须转达给用户】无头会话已成功创建并持久化，但由于 ZCode 桌面端侧边栏的会话列表是启动时的内存快照，' +
  '新会话不会立即显示在侧边栏——需要完全重启 ZCode（或切换到其他项目再切回）后才会出现。' +
  '会话本身不受影响: 可立即经本工具 send 子命令续接派单。此限制可能随 ZCode 版本更新消除，当前版本 (0.16.5) 需遵循。';

function winInstallRoots(env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  return [
    'D:\\Application\\ZCode',
    path.join(local, 'Programs', 'ZCode'),
    path.join(programFiles, 'ZCode')
  ];
}

function macInstallRoots() {
  return ['/Applications/ZCode.app/Contents/Resources'];
}

function linuxInstallRoots() {
  return ['/opt/ZCode', '/usr/lib/zcode'];
}

/**
 * 定位 ZCode CLI。优先级：
 *   env.ZCODE_CLI_BIN (+ 可选 env.ZCODE_CJS_PATH) > 平台标准安装路径探测
 * 返回 { bin, cjs, argsPrefix } | null；argsPrefix 位于 cjs 之前（当前实现恒为 []）。
 */
function discoverZcodeCli(env) {
  env = env || process.env;
  const cjsRel = path.join('resources', 'glm', 'zcode.cjs');

  const tryRoot = (root) => {
    if (!root) return null;
    const cjs = path.join(root, cjsRel);
    if (fs.existsSync(cjs)) {
      const exeName = process.platform === 'win32' ? 'ZCode.exe' : 'zcode';
      const bin = path.join(root, exeName);
      if (fs.existsSync(bin)) {
        return { bin: bin, cjs: cjs, argsPrefix: [] };
      }
      // macOS/Linux: cjs 存在即可直接以 node/zcode 运行
      return { bin: process.execPath, cjs: cjs, argsPrefix: [], note: 'node-runtime' };
    }
    return null;
  };

  if (env.ZCODE_CLI_BIN) {
    const root = path.dirname(path.resolve(env.ZCODE_CLI_BIN));
    const hit = tryRoot(root) || tryRoot(path.dirname(root));
    if (hit) {
      hit.bin = env.ZCODE_CLI_BIN;
      return hit;
    }
    // 显式指定 bin 时即使找不到 cjs 也尊重用户（cjs 允许经 ZCODE_CJS_PATH 补充）
    if (env.ZCODE_CJS_PATH && fs.existsSync(env.ZCODE_CJS_PATH)) {
      return { bin: env.ZCODE_CLI_BIN, cjs: env.ZCODE_CJS_PATH, argsPrefix: [] };
    }
    return null;
  }

  const roots = [];
  if (process.platform === 'win32') roots.push(...winInstallRoots(env));
  else if (process.platform === 'darwin') roots.push(...macInstallRoots());
  else roots.push(...linuxInstallRoots());

  for (const root of roots) {
    const hit = tryRoot(root);
    if (hit) return hit;
  }
  return null;
}

function credentialsPath(env) {
  env = env || process.env;
  if (env.ZCODE_CREDENTIALS_PATH) return env.ZCODE_CREDENTIALS_PATH;
  return path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
}

function cliConfigPath(env) {
  env = env || process.env;
  if (env.ZCODE_CLI_CONFIG) return env.ZCODE_CLI_CONFIG;
  return path.join(os.homedir(), '.zcode', 'cli', 'config.json');
}

/**
 * 从 cli/config.json 提取 API-key 供应方体检信息。
 * schema 要求: provider.<id>.options.apiKey 非空(min 1), model 引用形如 "<providerId>/<modelId>"。
 */
function apiKeyProviderInfo(env) {
  const p = cliConfigPath(env);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return { ok: false, config_path: p, reason: err.code === 'ENOENT' ? 'cli config missing' : 'cli config unreadable' };
  }
  const providers = cfg && typeof cfg === 'object' ? cfg.provider : null;
  if (!providers || typeof providers !== 'object') {
    return { ok: false, config_path: p, reason: 'no provider map in cli config' };
  }
  for (const [pid, entry] of Object.entries(providers)) {
    const key = entry && entry.options && entry.options.apiKey;
    if (typeof key === 'string' && key.length > 0) {
      return { ok: true, config_path: p, provider_id: pid, has_model_ref: typeof cfg.model === 'string' ? cfg.model.startsWith(pid + '/') : Boolean(cfg.model && cfg.model.main && String(cfg.model.main).startsWith(pid + '/')) };
    }
  }
  return { ok: false, config_path: p, reason: 'no provider entry carries a non-empty apiKey' };
}

/**
 * 登录态检测（双通道）:
 *   1. OAuth: ~/.zcode/v2/credentials.json 非空对象
 *   2. API key: ~/.zcode/cli/config.json 存在携带非空 apiKey 的 provider
 * 桌面端密钥不落盘（走进程内路由），因此两条通道均不通过时判定未登录。
 */
function authState(env) {
  // 通道 2: API key
  const apiInfo = apiKeyProviderInfo(env);
  if (apiInfo.ok) {
    return {
      logged_in: true,
      method: 'api-key',
      credentials_path: apiInfo.config_path,
      provider_id: apiInfo.provider_id,
      reason: 'api-key provider configured in cli config' + (apiInfo.has_model_ref ? '' : ' (warning: no model ref points at this provider)')
    };
  }
  // 通道 1: OAuth
  const p = credentialsPath(env);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const keys = Object.keys(data || {});
    if (keys.length > 0) {
      return { logged_in: true, method: 'oauth', credentials_path: p, reason: 'credentials present' };
    }
    return {
      logged_in: false,
      method: null,
      credentials_path: p,
      reason: 'credentials file empty and no api-key provider configured (desktop routes auth in-process; CLI needs its own login)'
    };
  } catch (err) {
    return {
      logged_in: false,
      method: null,
      credentials_path: p,
      reason: (err.code === 'ENOENT' ? 'credentials file missing' : 'credentials file unreadable') +
        ' and no api-key provider configured'
    };
  }
}

/**
 * 将 API key 写入 cli/config.json（安全合并 + 自动备份）。
 * options: { key, providerId?, baseUrl?, kind?, model?, name?, env? }
 * 返回 { ok, config_path, backup_path?, provider_id, model_ref?, error? }
 */
function loginApiKey(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  if (!opts.key || typeof opts.key !== 'string' || !opts.key.trim()) {
    return { ok: false, error: '缺少 --key <API_KEY>' };
  }
  const key = opts.key.trim();
  const providerId = opts.providerId || 'bigmodel';
  const baseUrl = opts.baseUrl || 'https://open.bigmodel.cn/api/anthropic';
  const kind = opts.kind || 'anthropic';
  const modelId = opts.model || 'GLM-5.3-Flash';
  const name = opts.name || 'Bigmodel - API Key';

  if (!['anthropic', 'openai', 'openai-compatible'].includes(kind)) {
    return { ok: false, error: `kind 非法: ${kind}（允许 anthropic|openai|openai-compatible）` };
  }

  const configPath = cliConfigPath(env);
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return { ok: false, error: `读取 ${configPath} 失败: ${err.message}（配置文件疑似损坏，请先手工修复）` };
    }
  }
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  const backupPath = `${configPath}.bak-login-${Date.now()}`;
  const hadExisting = fs.existsSync(configPath);
  if (hadExisting) {
    fs.copyFileSync(configPath, backupPath);
  }

  cfg.provider = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
  cfg.provider[providerId] = Object.assign(
    {},
    cfg.provider[providerId] || {},
    {
      kind: kind,
      name: name,
      options: Object.assign({}, (cfg.provider[providerId] && cfg.provider[providerId].options) || {}, { apiKey: key, baseURL: baseUrl })
    }
  );
  const modelRef = `${providerId}/${modelId}`;
  cfg.model = { main: modelRef, lite: modelRef };

  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: `写入 ${configPath} 失败: ${err.message}` };
  }
  const result = { ok: true, config_path: configPath, provider_id: providerId, model_ref: modelRef };
  if (hadExisting) {
    result.backup_path = backupPath;
  }
  return result;
}

function cliEnv(env) {
  return Object.assign({}, env, { ELECTRON_RUN_AS_NODE: '1' });
}

function buildArgs(action, opts) {
  if (action === 'spawn') {
    return ['--cwd', opts.cwd, '-p', opts.prompt];
  }
  if (action === 'send') {
    return ['--resume', opts.session, '-p', opts.prompt];
  }
  if (action === 'version') {
    return ['version'];
  }
  throw new Error(`unknown action: ${action}`);
}

function extractSessionId(text) {
  const m = String(text || '').match(SESSION_ID_RE);
  return m ? m[0] : null;
}

/**
 * 反查 spawn 产生的新会话 ID: CLI -p 模式 stdout 不打印 sess_id，
 * 依据 rollout 目录中 mtime 晚于起始时刻的最新会话转储文件名反推。
 */
function findLatestSessionIdSince(sinceMs, env) {
  env = env || process.env;
  const dir = env.ZCODE_ROLLOUT_DIR || path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return null;
  }
  let best = null;
  let bestM = 0;
  for (const entry of entries) {
    const m = entry.match(/^model-io-sess[_-]([0-9a-fA-F-]{36})\.jsonl$/i);
    if (!m) continue;
    try {
      const st = fs.statSync(path.join(dir, entry));
      if (st.mtimeMs >= sinceMs - 2000 && st.mtimeMs > bestM) {
        bestM = st.mtimeMs;
        best = `sess_${m[1]}`;
      }
    } catch (err) {
      // ignore
    }
  }
  return best;
}

function runCli(cli, args, timeoutSec, env) {
  const stdout = execFileSync(cli.bin, [cli.cjs].concat(args), {
    env: cliEnv(env || process.env),
    timeout: Math.max(5, Number(timeoutSec) || 300) * 1000,
    encoding: 'utf8',
    windowsHide: true
  });
  return String(stdout || '');
}

function capabilityReport(env) {
  const cli = discoverZcodeCli(env);
  const auth = authState(env);
  const report = {
    cli: { found: Boolean(cli), bin: cli ? cli.bin : null, cjs: cli ? cli.cjs : null },
    auth: {
      logged_in: auth.logged_in,
      method: auth.method || null,
      credentials_path: auth.credentials_path,
      reason: auth.reason,
      hint: auth.logged_in
        ? null
        : '运行 scripts/providers/spawn_zcode_session.js login-api-key --key <API_KEY> 配置 API key, 或 zcode login 完成 OAuth'
    },
    desktop_sync_notice: DESKTOP_SYNC_NOTICE,
    spawn_send_ready: Boolean(cli) && auth.logged_in,
    in_process_alternatives: [
      'Agent 工具: 进程内拉起子代理（同步返回即结果，落 session_task_link 谱系）',
      'ReadSessionContext(sess_*): 跨会话定向读取上下文',
      'SendMessage(to: agent_<uuid>): 同进程代理发信',
      '会话反向内省: db.sqlite(ro) + rollout JSONL + 仓库 Provider 脚本'
    ],
    protocol_alternative: 'zcode app-server (ZCode Protocol stdio JSON-RPC, 深度编排入口)'
  };
  return report;
}

function processCommand(args, env) {
  env = env || process.env;
  const dryRun = args.includes('--dry-run');
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  if (args.includes('--check')) {
    const report = capabilityReport(env);
    if (report.cli.found && !dryRun) {
      try {
        const out = runCli(report.cli, buildArgs('version'), 20, env).trim();
        report.cli.version = out.split('\n')[0] || null;
      } catch (err) {
        report.cli.version = null;
        report.cli.version_error = String(err.message).split('\n')[0];
      }
    }
    return { code: 0, payload: report };
  }

  if (args[0] === 'login-api-key') {
    const result = loginApiKey({
      key: getOpt('--key'),
      providerId: getOpt('--provider-id'),
      baseUrl: getOpt('--base-url'),
      kind: getOpt('--kind'),
      model: getOpt('--model'),
      name: getOpt('--name'),
      env: env
    });
    return { code: result.ok ? 0 : 1, payload: result };
  }

  let action = null;
  if (args[0] === 'spawn') action = 'spawn';
  else if (args[0] === 'send') action = 'send';
  if (!action) {
    return {
      code: 1,
      payload: {
        ok: false,
        error: '用法: spawn_zcode_session.js --check | login-api-key --key <API_KEY> | spawn --cwd <dir> --prompt <text> | send --session <sess_id> --prompt <text> [--dry-run]'
      }
    };
  }

  const opts = {
    cwd: getOpt('--cwd') || '.',
    prompt: getOpt('--prompt'),
    session: getOpt('--session'),
    timeout: getOpt('--timeout') || 300
  };
  if (action === 'spawn' && (!opts.prompt || !opts.cwd)) {
    return { code: 1, payload: { ok: false, error: 'spawn 需要 --cwd 与 --prompt' } };
  }
  if (action === 'send') {
    if (!opts.prompt || !opts.session) {
      return { code: 1, payload: { ok: false, error: 'send 需要 --session 与 --prompt' } };
    }
    if (!SESSION_ID_RE.test(opts.session)) {
      return { code: 1, payload: { ok: false, error: `--session 非法: ${opts.session}（期望 sess_<uuid>）` } };
    }
  }

  const cli = discoverZcodeCli(env);
  if (!cli) {
    return {
      code: 1,
      payload: {
        ok: false,
        error: '未发现 ZCode CLI。可用环境变量 ZCODE_CLI_BIN 指向 ZCode.exe（zcode.cjs 需位于 <bin>/../resources/glm/zcode.cjs，或以 ZCODE_CJS_PATH 显式指定）。'
      }
    };
  }

  const argv = buildArgs(action, opts);
  const commandLine = `${cli.bin} ${cli.cjs} ${argv.map(a => JSON.stringify(a)).join(' ')}`;
  if (dryRun) {
    return { code: 0, payload: { ok: true, dry_run: true, action: action, command: commandLine } };
  }

  const auth = authState(env);
  if (!auth.logged_in) {
    return {
      code: 2,
      payload: {
        ok: false,
        error: `ZCode CLI 未登录（${auth.reason}）。先执行一次 zcode login 完成 OAuth，或改用进程内方案: ${capabilityReport(env).in_process_alternatives.join(' / ')}`
      }
    };
  }

  try {
    const startedAt = Date.now();
    const out = runCli(cli, argv, opts.timeout, env);
    const sessionId = extractSessionId(out) || (action === 'spawn' ? findLatestSessionIdSince(startedAt, env) : null);
    const payload = {
      ok: true,
      action: action,
      session_id: sessionId,
      output: out.trim(),
      command: commandLine
    };
    if (action === 'spawn') {
      payload.user_notice_must_relay = DESKTOP_SYNC_NOTICE;
    }
    return { code: 0, payload: payload };
  } catch (err) {
    return {
      code: 3,
      payload: {
        ok: false,
        action: action,
        command: commandLine,
        error: String(err.message).split('\n').slice(0, 6).join('\n')
      }
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  const result = processCommand(args);
  process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');
  process.exit(result.code);
}

if (require.main === module) {
  main();
}

module.exports = {
  discoverZcodeCli,
  authState,
  buildArgs,
  capabilityReport,
  processCommand,
  runCli,
  extractSessionId,
  findLatestSessionIdSince,
  credentialsPath,
  cliConfigPath,
  apiKeyProviderInfo,
  loginApiKey
};
