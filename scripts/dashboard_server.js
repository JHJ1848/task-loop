#!/usr/bin/env node
/**
 * task-loop Dashboard Local Server
 * 零外部依赖原生 Node.js HTTP 服务，提供静态文件托管与真实磁盘文件物理直写 API
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3200;
const ROOT_DIR = path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(ROOT_DIR, 'dashboard');
const STATE_DIR = path.join(ROOT_DIR, '.agents', 'task-loop');

// 确保存储目录存在
if (!fs.existsSync(STATE_DIR)) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // CORS 跨域与基础响应头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. API: 获取真实磁盘状态
  if (req.method === 'GET' && pathname === '/api/state') {
    const files = ['sessions.json', 'todo.json', 'policy.json', 'lease.json'];
    const result = {};
    for (const f of files) {
      const filePath = path.join(STATE_DIR, f);
      if (fs.existsSync(filePath)) {
        try {
          result[f] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
          result[f] = null;
        }
      } else {
        result[f] = null;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: result }));
    return;
  }

  // 2. API: 真实物理写盘 (解决“假更改”核心)
  if (req.method === 'POST' && pathname === '/api/save') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { file, data } = payload;
        if (!file || !data) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Missing file or data' }));
          return;
        }

        // 白名单安全校验
        const safeFiles = ['todo.json', 'sessions.json', 'policy.json', 'lease.json'];
        if (!safeFiles.includes(file)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Forbidden file' }));
          return;
        }

        const targetPath = path.join(STATE_DIR, file);
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        fs.writeFileSync(targetPath, content, 'utf8');

        console.info(`[DashboardServer] REAL IN-PLACE DISK WRITE: ${file} (${content.length} bytes) at ${new Date().toLocaleTimeString()}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, file, bytes: content.length }));
      } catch (err) {
        console.error('[DashboardServer] Save error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 3. 静态文件托管 (dashboard 目录)
  let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  let filePath = path.join(DASHBOARD_DIR, relativePath);

  // 安全检查防路径穿越
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/index.html`;
  console.info('====================================================');
  console.info(` task-loop 控制面板物理直写服务已启动`);
  console.info(` 服务地址: ${url}`);
  console.info(` 真实数据目录: ${STATE_DIR}`);
  console.info('====================================================');

  // 如果命令行带了 --open，自动调起浏览器
  if (process.argv.includes('--open')) {
    const startCmd = process.platform === 'win32' ? `start "" "${url}"` : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
    exec(startCmd);
  }
});
