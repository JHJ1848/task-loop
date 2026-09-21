#!/usr/bin/env node
/**
 * task-loop Dashboard Local Server
 * 零外部依赖原生 Node.js HTTP 服务，提供静态文件托管与真实磁盘文件物理直写 API
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const stateService = require('./state_service');

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
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;

  // 基础响应头 (本地同源访问，移除通配 CORS *)
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. API: 获取真实磁盘状态 (通过 stateService 统一读取)
  if (req.method === 'GET' && pathname === '/api/state') {
    const result = stateService.getAllState(STATE_DIR);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: result }));
    return;
  }

  // 2. API: 真实物理写盘 (收口至 stateService 统一校验与原子写入)
  if (req.method === 'POST' && pathname === '/api/save') {
    let body = '';
    let bodySize = 0;
    const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
    let isDestroyed = false;

    req.on('data', chunk => {
      if (isDestroyed) return;
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        isDestroyed = true;
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Payload Too Large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (isDestroyed) return;
      try {
        const payload = JSON.parse(body);
        const { file, data } = payload;
        if (!file || data === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Missing file or data' }));
          return;
        }

        const saveResult = stateService.saveState(file, data, STATE_DIR);
        console.info(`[DashboardServer] REAL IN-PLACE DISK WRITE: ${file} (${saveResult.bytes} bytes) at ${new Date().toLocaleTimeString()}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, file, bytes: saveResult.bytes }));
      } catch (err) {
        const msg = err.message || '';
        const statusCode = msg.includes('Forbidden state file') ? 403 : 400;
        console.error('[DashboardServer] Save error:', err);
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: msg }));
      }
    });
    return;
  }

  // 3. 静态文件托管 (dashboard 目录)
  let cleanPathname = pathname;
  try {
    cleanPathname = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const relativePath = cleanPathname === '/' ? 'index.html' : cleanPathname.replace(/^\/+/, '');
  const safePath = path.resolve(DASHBOARD_DIR, relativePath);
  const rel = path.relative(DASHBOARD_DIR, safePath);

  // 严格安全检查防路径穿越
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(safePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/index.html`;
  console.info('====================================================');
  console.info(`[DashboardServer] task-loop 控制面板物理直写服务已启动`);
  console.info(` 服务地址: ${url}`);
  console.info(` 真实数据目录: ${STATE_DIR}`);
  console.info('====================================================');

  // 如果命令行带了 --open，自动调起浏览器
  if (process.argv.includes('--open')) {
    const startCmd = process.platform === 'win32' ? `start "" "${url}"` : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
    exec(startCmd);
  }
});
