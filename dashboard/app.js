// ==========================================
// task-loop 控制面板核心应用驱动 (Zero-Dep App Controller)
// ==========================================

// 1. 状态管理器初始化
let initialLang = 'zh';
try {
  const stored = localStorage.getItem('task_loop_lang');
  if (stored && (stored === 'zh' || stored === 'en')) {
    initialLang = stored;
  } else if (navigator.language && !navigator.language.toLowerCase().startsWith('zh')) {
    initialLang = 'en';
  }
} catch (e) {}

window.state = {
  lang: initialLang,
  sessions: JSON.parse(JSON.stringify(window.DEFAULT_SESSIONS)),
  todo: JSON.parse(JSON.stringify(window.DEFAULT_TODO)),
  policy: JSON.parse(JSON.stringify(window.DEFAULT_POLICY)),
  lease: JSON.parse(JSON.stringify(window.DEFAULT_LEASE)),
  currentVendor: 'antigravity',
  currentTab: 'view-kanban',
  currentRaw: 'sessions',
  rawMode: 'tree',
  dirHandle: null,
  isHttpServerConnected: false
};

// 2. 复杂度等级专属 SVG 矢量图与配置 (彻底废除纯文字 L1/L2/L3)
const COMPLEXITY_CONFIG = {
  1: {
    className: 'level-1',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    titleKey: 'complexity_title_1'
  },
  2: {
    className: 'level-2',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
    titleKey: 'complexity_title_2'
  },
  3: {
    className: 'level-3',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-2.05 9-1.2 1.4-2.58 2.3-3.95 3z"/></svg>`,
    titleKey: 'complexity_title_3'
  }
};

const VENDOR_LOGOS = {
  antigravity: {
    name: 'Google Antigravity',
    vendor: 'Google Deepmind',
    svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`
  },
  zcode: {
    name: 'ZCode',
    vendor: 'Z.ai GLM',
    svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`
  },
  codex: {
    name: 'Codex / VS Code',
    vendor: 'OpenAI',
    svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`
  },
  claude: {
    name: 'Claude Code',
    vendor: 'Anthropic',
    svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3"/></svg>`
  }
};

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.innerText = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2200);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 3. 动态时间戳与定时器徽标更新
function updateSyncTimestamp(src = 'DISK') {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const syncTextEl = document.getElementById('tab-sync-text');
  const dotEl = document.getElementById('dot-sync-badge');
  if (syncTextEl) syncTextEl.innerText = `${src}: ${timeStr}`;
  if (dotEl) dotEl.className = 'pulse-dot green';
}

// 4. 原生 IndexedDB 缓存持久化 DirectoryHandle
const IDB_NAME = 'task_loop_db';
const IDB_STORE = 'handles';
const IDB_KEY = 'dir_handle';

function openIdb() {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function storeDirHandle(handle) {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

async function getStoredDirHandle() {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function clearStoredDirHandle() {
  const db = await openIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
  } catch (e) {}
}

// 5. 自动探测并拉取最新数据 (HTTP API / Live Server 模式)
async function autoFetchFromLocal() {
  const isHttp = window.location.protocol.startsWith('http');
  const apiBase = isHttp ? '' : 'http://127.0.0.1:3200';

  // 优先尝试 Dashboard HTTP 后端服务的 /api/state
  try {
    const apiRes = await fetch(`${apiBase}/api/state`);
    if (apiRes.ok) {
      const resJson = await apiRes.json();
      if (resJson.ok && resJson.data) {
        let loaded = false;
        if (resJson.data['sessions.json']) {
          state.sessions = resJson.data['sessions.json'];
          loaded = true;
        }
        if (resJson.data['todo.json']) {
          const diskTodo = resJson.data['todo.json'];
          if (diskTodo.items && diskTodo.items.length > 0) {
            state.todo = diskTodo;
          } else if (state.todo && state.todo.items && state.todo.items.length > 0) {
            fetch(`${apiBase}/api/save`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file: 'todo.json', data: state.todo })
            }).catch(() => {});
          }
          loaded = true;
        }
        if (resJson.data['policy.json']) {
          state.policy = resJson.data['policy.json'];
          loaded = true;
        }
        if (resJson.data['lease.json']) {
          state.lease = resJson.data['lease.json'];
          loaded = true;
        }
        if (loaded) {
          state.isHttpServerConnected = true;
          renderAll();
          updateSyncTimestamp('API-FETCH');
          console.info('[Task-Loop:Init] Connected to backend server API, real disk state synchronized');
          return true;
        }
      }
    }
  } catch (e) {}

  // 备用: Live Server / 相对路径静态读取
  if (isHttp) {
    try {
      const ts = Date.now();
      const [sessRes, todoRes, policyRes, leaseRes] = await Promise.all([
        fetch(`../.agents/task-loop/sessions.json?t=${ts}`),
        fetch(`../.agents/task-loop/todo.json?t=${ts}`),
        fetch(`../.agents/task-loop/policy.json?t=${ts}`),
        fetch(`../.agents/task-loop/lease.json?t=${ts}`)
      ]);

      if (sessRes.ok && todoRes.ok) {
        state.sessions = await sessRes.json();
        state.todo = await todoRes.json();
        if (policyRes.ok) state.policy = await policyRes.json();
        if (leaseRes.ok) state.lease = await leaseRes.json();
        renderAll();
        updateSyncTimestamp('FETCH');
        return true;
      }
    } catch (e) {}
  }
  return false;
}

// 6. 原生 File System Access API 目录授权与读写
async function selectDirectory() {
  if (!window.showDirectoryPicker) {
    alert(state.lang === 'zh' 
      ? '当前浏览器不支持本地目录授权接口 (File System Access API)。\n推荐在终端启动服务：node scripts/dashboard_server.js --open\n即可自动开启真实物理直写服务并打开浏览器！' 
      : 'Browser does not support File System Access API. Please run: node scripts/dashboard_server.js --open');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (handle) {
      await storeDirHandle(handle);
      await loadFromDirectory(handle);
      renderAll();
      updateSyncTimestamp('DISK-ATTACH');
      console.info(`[Task-Loop:Disk] Project directory attached: ${handle.name}`);
      showToast(`${t('toast_dir_attached')}${handle.name}`);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('[Task-Loop:SelectDir] Directory selection error:', err);
    }
  }
}

const writeDebounceTimers = {};
const lastSeenDiskTexts = {
  'todo.json': '',
  'sessions.json': '',
  'policy.json': '',
  'lease.json': ''
};
let isPolling = false;
let pollTick = 0;

// 本地持久化兜底
function saveToLocalStorage(fileName, data) {
  try {
    localStorage.setItem('task_loop_cache_' + fileName, JSON.stringify(data));
  } catch (e) {}
}

function loadFromLocalStorage(fileName) {
  try {
    const raw = localStorage.getItem('task_loop_cache_' + fileName);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function persistFile(fileName, data, debounceMs = 0) {
  saveToLocalStorage(fileName, data);

  const doWrite = async () => {
    // 通道 1: 如果处于 HTTP 本地服务模式或能连接到 127.0.0.1:3200，调用物理直写 API
    const isHttp = window.location.protocol.startsWith('http');
    const apiBase = isHttp ? '' : 'http://127.0.0.1:3200';

    try {
      const res = await fetch(`${apiBase}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: fileName, data })
      });
      if (res.ok) {
        const result = await res.json();
        state.isHttpServerConnected = true;
        lastSeenDiskTexts[fileName] = JSON.stringify(data);
        updateSyncTimestamp('API-WRITE');
        renderStatusBar();
        console.info(`[Task-Loop:Save] REAL DISK WRITE SUCCESS (HTTP API): ${fileName} (${result.bytes} bytes)`);
        return true;
      }
    } catch (e) {
      // HTTP 离线，继续尝试 FSA
    }

    // 通道 2: 如果拥有本地目录授权句柄 (File System Access API)，直接原位改写磁盘文件
    if (state.dirHandle) {
      try {
        const fh = await state.dirHandle.getFileHandle(fileName, { create: true });
        const writable = await fh.createWritable();
        const jsonText = JSON.stringify(data, null, 2);
        await writable.write(jsonText);
        await writable.close();
        lastSeenDiskTexts[fileName] = jsonText;
        updateSyncTimestamp('DISK-WRITE');
        console.info(`[Task-Loop:Save] REAL DISK WRITE SUCCESS (FSA API): ${fileName} (${jsonText.length} bytes)`);
        return true;
      } catch (err) {
        console.warn(`[Task-Loop:Save] FSA write ${fileName} failed:`, err);
      }
    }

    // 通道 3: 既无 HTTP 后端服务又未获得目录句柄，发出明确警示，绝不假写
    console.warn(`[Task-Loop:Save] WARNING: No directory handle or backend server attached! Changes kept in localStorage only. Click status bar to attach project directory for real disk writes.`);
    showToast(state.lang === 'zh' 
      ? '提醒：未关联项目目录，更改仅保存在浏览器！请点击顶部状态栏选择项目目录开启真写盘' 
      : 'Notice: Directory not attached. Click top status bar to attach directory for real disk writes.');
    return false;
  };

  if (debounceMs > 0) {
    console.info(`[Task-Loop:Timer] Debounce scheduled for ${fileName} (${debounceMs}ms)`);
    if (writeDebounceTimers[fileName]) clearTimeout(writeDebounceTimers[fileName]);
    writeDebounceTimers[fileName] = setTimeout(doWrite, debounceMs);
  } else {
    await doWrite();
  }
}

async function loadFromDirectory(handle) {
  state.dirHandle = handle;

  let targetDir = handle;
  try {
    const agentsDir = await handle.getDirectoryHandle('.agents');
    targetDir = await agentsDir.getDirectoryHandle('task-loop');
    state.dirHandle = targetDir;
  } catch (e) {}

  try {
    const todoFh = await targetDir.getFileHandle('todo.json', { create: true });
    const todoFile = await todoFh.getFile();
    const todoText = await todoFile.text();
    if (todoText && todoText.trim().length > 0) {
      const parsed = JSON.parse(todoText);
      if (parsed.items && parsed.items.length > 0) {
        lastSeenDiskTexts['todo.json'] = todoText;
        state.todo = parsed;
      } else if (state.todo && state.todo.items && state.todo.items.length > 0) {
        await persistFile('todo.json', state.todo);
      }
    } else if (state.todo && state.todo.items && state.todo.items.length > 0) {
      await persistFile('todo.json', state.todo);
    }
  } catch (e) {
    console.warn('[Task-Loop:Disk] Load todo.json error:', e);
  }

  try {
    const sessFh = await targetDir.getFileHandle('sessions.json');
    const sessFile = await sessFh.getFile();
    const sessText = await sessFile.text();
    if (sessText) {
      lastSeenDiskTexts['sessions.json'] = sessText;
      state.sessions = JSON.parse(sessText);
    }
  } catch (e) {}

  try {
    const policyFh = await targetDir.getFileHandle('policy.json');
    const policyFile = await policyFh.getFile();
    const policyText = await policyFile.text();
    if (policyText) {
      lastSeenDiskTexts['policy.json'] = policyText;
      state.policy = JSON.parse(policyText);
    }
  } catch (e) {}

  try {
    const leaseFh = await targetDir.getFileHandle('lease.json');
    const leaseFile = await leaseFh.getFile();
    const leaseText = await leaseFile.text();
    if (leaseText) {
      lastSeenDiskTexts['lease.json'] = leaseText;
      state.lease = JSON.parse(leaseText);
    }
  } catch (e) {}

  renderAll();
}

async function pollFromDisk() {
  if (isPolling) return;
  isPolling = true;
  pollTick++;

  const timeStr = new Date().toLocaleTimeString();

  // 途径 1: HTTP API 轮询 (支持 http: 或 file: 跨域访问 127.0.0.1:3200)
  const isHttp = window.location.protocol.startsWith('http');
  const apiBase = isHttp ? '' : 'http://127.0.0.1:3200';

  if (state.isHttpServerConnected || isHttp) {
    try {
      const res = await fetch(`${apiBase}/api/state`);
      if (res.ok) {
        const json = await res.json();
        if (json.ok && json.data) {
          state.isHttpServerConnected = true;
          let changed = false;

          // todo.json
          if (json.data['todo.json']) {
            const text = JSON.stringify(json.data['todo.json']);
            if (lastSeenDiskTexts['todo.json'] && text !== lastSeenDiskTexts['todo.json']) {
              state.todo = json.data['todo.json'];
              changed = true;
              console.info(`[Task-Loop:Timer] 1s poll: Detected disk update via HTTP API in todo.json`);
              const activeEl = document.activeElement;
              const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
              if (!isTyping) {
                renderKanban();
                if (state.currentTab === 'view-raw' && state.currentRaw === 'todo') updateRawEditor();
              }
            }
            lastSeenDiskTexts['todo.json'] = text;
          }

          // sessions.json
          if (json.data['sessions.json']) {
            const text = JSON.stringify(json.data['sessions.json']);
            if (lastSeenDiskTexts['sessions.json'] && text !== lastSeenDiskTexts['sessions.json']) {
              state.sessions = json.data['sessions.json'];
              changed = true;
              console.info(`[Task-Loop:Timer] 1s poll: Detected disk update via HTTP API in sessions.json`);
              renderTopology();
              if (state.currentTab === 'view-raw' && state.currentRaw === 'sessions') updateRawEditor();
            }
            lastSeenDiskTexts['sessions.json'] = text;
          }

          // policy.json
          if (json.data['policy.json']) {
            const text = JSON.stringify(json.data['policy.json']);
            if (lastSeenDiskTexts['policy.json'] && text !== lastSeenDiskTexts['policy.json']) {
              state.policy = json.data['policy.json'];
              changed = true;
              console.info(`[Task-Loop:Timer] 1s poll: Detected disk update via HTTP API in policy.json`);
              renderPolicy();
              renderStatusBar();
              if (state.currentTab === 'view-raw' && state.currentRaw === 'policy') updateRawEditor();
            }
            lastSeenDiskTexts['policy.json'] = text;
          }

          // lease.json
          if (json.data['lease.json']) {
            const text = JSON.stringify(json.data['lease.json']);
            if (lastSeenDiskTexts['lease.json'] && text !== lastSeenDiskTexts['lease.json']) {
              state.lease = json.data['lease.json'];
              changed = true;
              console.info(`[Task-Loop:Timer] 1s poll: Detected disk update via HTTP API in lease.json`);
              renderStatusBar();
              renderPolicy();
            }
            lastSeenDiskTexts['lease.json'] = text;
          }

          if (changed) updateSyncTimestamp('API-POLL');
          isPolling = false;
          return;
        }
      }
    } catch (e) {
      if (state.isHttpServerConnected) {
        state.isHttpServerConnected = false;
        renderStatusBar();
      }
    }
  }

  // 途径 2: 原生 File System Access API
  if (!state.dirHandle) {
    isPolling = false;
    return;
  }

  console.info(`[Task-Loop:Timer] 1s poll tick #${pollTick} (${timeStr}): scanning disk files in ${state.dirHandle.name || 'target'}...`);

  try {
    let changed = false;

    // 1. todo.json
    try {
      const fh = await state.dirHandle.getFileHandle('todo.json');
      const f = await fh.getFile();
      const text = await f.text();
      if (text && text !== lastSeenDiskTexts['todo.json']) {
        lastSeenDiskTexts['todo.json'] = text;
        state.todo = JSON.parse(text);
        changed = true;
        console.info('[Task-Loop:Timer] Detected update in todo.json -> re-rendering kanban');

        const activeEl = document.activeElement;
        const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
        if (!isTyping) {
          renderKanban();
          if (state.currentTab === 'view-raw' && state.currentRaw === 'todo') updateRawEditor();
        }
      }
    } catch (e) {}

    // 2. sessions.json
    try {
      const fh = await state.dirHandle.getFileHandle('sessions.json');
      const f = await fh.getFile();
      const text = await f.text();
      if (text && text !== lastSeenDiskTexts['sessions.json']) {
        lastSeenDiskTexts['sessions.json'] = text;
        state.sessions = JSON.parse(text);
        changed = true;
        console.info('[Task-Loop:Timer] Detected update in sessions.json -> re-rendering topology');
        renderTopology();
        if (state.currentTab === 'view-raw' && state.currentRaw === 'sessions') updateRawEditor();
      }
    } catch (e) {}

    // 3. policy.json
    try {
      const fh = await state.dirHandle.getFileHandle('policy.json');
      const f = await fh.getFile();
      const text = await f.text();
      if (text && text !== lastSeenDiskTexts['policy.json']) {
        lastSeenDiskTexts['policy.json'] = text;
        state.policy = JSON.parse(text);
        changed = true;
        console.info('[Task-Loop:Timer] Detected update in policy.json -> re-rendering policy');
        renderPolicy();
        renderStatusBar();
        if (state.currentTab === 'view-raw' && state.currentRaw === 'policy') updateRawEditor();
      }
    } catch (e) {}

    // 4. lease.json
    try {
      const fh = await state.dirHandle.getFileHandle('lease.json');
      const f = await fh.getFile();
      const text = await f.text();
      if (text && text !== lastSeenDiskTexts['lease.json']) {
        lastSeenDiskTexts['lease.json'] = text;
        state.lease = JSON.parse(text);
        changed = true;
        console.info('[Task-Loop:Timer] Detected update in lease.json -> re-rendering status');
        renderStatusBar();
        renderPolicy();
      }
    } catch (e) {}

    if (changed) updateSyncTimestamp('POLL');
  } catch (err) {
  } finally {
    isPolling = false;
  }
}

// 7. 渲染层函数集
function applyI18n() {
  const dict = window.I18N[state.lang] || window.I18N.en;
  
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) el.innerText = dict[key];
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (dict[key] !== undefined) el.setAttribute('title', dict[key]);
  });

  const brandTitleEl = document.getElementById('brand-header-title');
  if (brandTitleEl) {
    brandTitleEl.innerText = state.lang === 'zh' ? 'TASK-LOOP 控制面板' : 'TASK-LOOP Dashboard';
  }

  const switchBtn = document.getElementById('lang-switch-btn');
  const optZh = document.getElementById('lang-opt-zh');
  const optEn = document.getElementById('lang-opt-en');
  if (switchBtn && optZh && optEn) {
    if (state.lang === 'en') {
      switchBtn.classList.add('lang-en');
      optZh.classList.remove('active');
      optEn.classList.add('active');
    } else {
      switchBtn.classList.remove('lang-en');
      optZh.classList.add('active');
      optEn.classList.remove('active');
    }
  }
}

function toggleLanguage() {
  state.lang = state.lang === 'zh' ? 'en' : 'zh';
  try {
    localStorage.setItem('task_loop_lang', state.lang);
  } catch (e) {}
  applyI18n();
  renderAll();
  showToast(t('toast_lang_switched'));
}

function renderStatusBar() {
  document.getElementById('text-active-vendor').innerText = state.policy.active_vendor || 'antigravity';
  
  const leaseStatus = state.lease.status || 'UNLOCKED';
  const leaseEl = document.getElementById('text-lease-status');
  leaseEl.innerText = leaseStatus === 'LOCKED' ? t('lease_locked') : t('lease_unlocked');
  leaseEl.style.color = leaseStatus === 'LOCKED' ? 'var(--c-red)' : 'var(--c-green)';

  const dot = document.getElementById('dot-source');
  const textEl = document.getElementById('text-source');
  const btnEl = document.getElementById('status-source-btn');

  if (state.isHttpServerConnected) {
    dot.className = 'indicator-dot dot-green';
    textEl.innerText = t('status_src_http');
    if (btnEl) btnEl.title = state.lang === 'zh' ? '当前已通过本地后台 HTTP 服务直连磁盘，改动将实时物理写入文件' : 'Connected to local HTTP backend, writes are physical in-place.';
  } else if (state.dirHandle) {
    dot.className = 'indicator-dot dot-green';
    textEl.innerText = `${t('status_src_dir_prefix')}${state.dirHandle.name} (${t('mode_inplace_write')})`;
    if (btnEl) btnEl.title = state.lang === 'zh' ? '当前已通过浏览器授权直连项目目录，改动将实时物理写入文件' : 'Connected via File System Access API, writes are physical in-place.';
  } else {
    dot.className = 'indicator-dot dot-amber';
    textEl.innerText = t('status_src_snapshot_hint');
    if (btnEl) btnEl.title = state.lang === 'zh' ? '点击选择项目目录（如 task-loop）开启真实物理写盘' : 'Click to attach project directory for real disk writes';
  }
}

function renderBreadcrumb() {
  const fileMap = {
    'view-kanban': 'todo.json',
    'view-topology': 'sessions.json',
    'view-policy': 'policy.json',
    'view-raw': `${state.currentRaw || 'sessions'}.json`
  };
  const targetFile = fileMap[state.currentTab] || 'todo.json';
  document.getElementById('breadcrumb-file').innerText = targetFile;
}

window.cycleComplexity = function(taskId) {
  const task = (state.todo.items || []).find(t => t.id === taskId);
  if (!task) return;
  let cur = Number(task.complexity) || 1;
  cur = cur >= 3 ? 1 : cur + 1;
  task.complexity = cur;
  renderKanban();
  if (state.currentTab === 'view-raw' && state.currentRaw === 'todo') updateRawEditor();
  persistFile('todo.json', state.todo, 150);
  showToast(`${t('task_cycle_complexity')}: Level ${cur}`);
};

window.advanceTaskStatus = function(taskId) {
  const task = (state.todo.items || []).find(t => t.id === taskId);
  if (!task) return;
  const flow = {
    pending: 'in_progress',
    in_progress: 'dispatched',
    dispatched: 'done',
    done: 'pending'
  };
  const next = flow[task.status] || 'in_progress';
  window.requestMoveTask(taskId, next);
};

function renderKanban() {
  const cols = {
    pending: document.getElementById('col-pending'),
    in_progress: document.getElementById('col-in_progress'),
    dispatched: document.getElementById('col-dispatched'),
    done: document.getElementById('col-done')
  };
  Object.values(cols).forEach(c => c.innerHTML = '');
  const counts = { pending: 0, in_progress: 0, dispatched: 0, done: 0 };

  const activeEl = document.activeElement;
  const focusedId = activeEl && activeEl.dataset ? activeEl.dataset.id : null;
  const focusedField = activeEl && activeEl.dataset ? activeEl.dataset.field : null;
  let selectionStart = null, selectionEnd = null;
  if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
    try {
      selectionStart = activeEl.selectionStart;
      selectionEnd = activeEl.selectionEnd;
    } catch (e) {}
  }

  (state.todo.items || []).forEach(task => {
    const status = task.status || 'pending';
    if (counts[status] !== undefined) counts[status]++;

    const assigneeVal = (task.assignee || '').trim();
    const hasAssignee = Boolean(assigneeVal && assigneeVal !== 'unassigned' && assigneeVal !== 'none');
    const isWorking = hasAssignee && status === 'in_progress';
    const isUnassigned = !hasAssignee || status === 'pending';

    const card = document.createElement('div');
    card.className = 'task-card' + (isUnassigned ? ' unassigned-card' : ' active-working-card');
    card.draggable = true;
    card.setAttribute('data-id', task.id);

    card.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', task.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    };

    card.ondragend = () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.kanban-col').forEach(c => c.classList.remove('drag-over'));
    };

    const complexityVal = Number(task.complexity) || 1;
    const compCfg = COMPLEXITY_CONFIG[complexityVal] || COMPLEXITY_CONFIG[1];
    const modeVal = task.verification_mode || 'unit_test';

    let bannerHtml = '';
    if (isUnassigned) {
      bannerHtml = `
        <div class="task-session-banner unassigned" title="${t('task_unassigned')}">
          <span style="display: flex; align-items: center; gap: 6px;">
            <span class="pulse-dot" style="background: var(--text-muted); box-shadow: none;"></span>
            <span>${t('task_unassigned')}</span>
          </span>
          <span>#${escapeHtml(task.id)}</span>
        </div>
      `;
    } else {
      bannerHtml = `
        <div class="task-session-banner active" title="${t('task_assigned_prefix')}${escapeHtml(assigneeVal)}">
          <span style="display: flex; align-items: center; gap: 6px;">
            <span class="pulse-dot green"></span>
            <span>${t('task_assigned_prefix')}${escapeHtml(assigneeVal)}</span>
          </span>
          <span>#${escapeHtml(task.id)}</span>
        </div>
      `;
    }

    card.innerHTML = `
      ${bannerHtml}

      <div>
        <input class="task-edit-title" value="${escapeHtml(task.title || '')}" placeholder="${t('task_placeholder_title')}" data-id="${task.id}" data-field="title" draggable="false" />
        <textarea class="task-edit-desc" placeholder="${t('task_placeholder_desc')}" data-id="${task.id}" data-field="objective" draggable="false">${escapeHtml(task.objective || '')}</textarea>
      </div>

      <div class="task-assignee-row" title="${t('task_assignee_title')}">
        <svg class="task-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <input class="task-edit-assignee" value="${escapeHtml(assigneeVal)}" placeholder="${t('task_placeholder_assignee')}" data-id="${task.id}" data-field="assignee" draggable="false" />
      </div>

      <div class="task-meta-bar">
        <div class="task-tags">
          <button class="complexity-badge-btn ${compCfg.className}" onclick="cycleComplexity('${task.id}')" title="${t(compCfg.titleKey)}" draggable="false">
            ${compCfg.svg}
          </button>
          <select class="task-select task-select-mode" data-id="${task.id}" data-field="verification_mode" title="${t('task_cycle_mode')}" draggable="false">
            <option value="unit_test" ${modeVal === 'unit_test' ? 'selected' : ''}>unit_test</option>
            <option value="ui_reload" ${modeVal === 'ui_reload' ? 'selected' : ''}>ui_reload</option>
            <option value="hybrid" ${modeVal === 'hybrid' ? 'selected' : ''}>hybrid</option>
          </select>
        </div>

        <div class="task-ctrls">
          <button class="task-action-btn btn-move" onclick="advanceTaskStatus('${task.id}')" title="${t('btn_advance')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            <span>${t('btn_advance')}</span>
          </button>
          <button class="task-action-btn btn-danger" onclick="requestDeleteTask('${task.id}')" title="${t('task_del_title')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    const inputs = card.querySelectorAll('input, textarea, select');
    inputs.forEach(input => {
      input.onmousedown = (e) => e.stopPropagation();
      const field = input.getAttribute('data-field');
      
      const handleUpdate = (e) => {
        let val = e.target.value;
        if (field === 'complexity') val = Number(val) || 1;
        task[field] = val;
        if (state.currentTab === 'view-raw' && state.currentRaw === 'todo') updateRawEditor();
        persistFile('todo.json', state.todo, 150);
      };

      input.oninput = handleUpdate;
      input.onchange = handleUpdate;
    });

    if (cols[status]) cols[status].appendChild(card);
  });

  document.getElementById('count-pending').innerText = counts.pending;
  document.getElementById('count-in_progress').innerText = counts.in_progress;
  document.getElementById('count-dispatched').innerText = counts.dispatched;
  document.getElementById('count-done').innerText = counts.done;

  if (focusedId && focusedField) {
    const targetInput = document.querySelector(`[data-id="${focusedId}"][data-field="${focusedField}"]`);
    if (targetInput) {
      targetInput.focus();
      if (selectionStart !== null && selectionEnd !== null && (targetInput.tagName === 'INPUT' || targetInput.tagName === 'TEXTAREA')) {
        try {
          targetInput.setSelectionRange(selectionStart, selectionEnd);
        } catch (e) {}
      }
    }
  }
}

// 8. 架构拓扑渲染
function renderTopology() {
  const pillsContainer = document.getElementById('vendor-pills');
  pillsContainer.innerHTML = '';
  const vendorList = Object.keys(state.sessions.vendors || {});
  
  vendorList.forEach(v => {
    const btn = document.createElement('button');
    btn.className = `vendor-btn ${v === state.currentVendor ? 'active' : ''}`;
    const info = VENDOR_LOGOS[v] || { name: v.toUpperCase(), svg: '', vendor: '' };
    btn.innerHTML = `${info.svg}<span>${info.name}</span>`;
    btn.title = `${info.name} (${info.vendor || 'Vendor'})`;
    btn.onclick = () => {
      state.currentVendor = v;
      renderTopology();
    };
    pillsContainer.appendChild(btn);
  });

  const grid = document.getElementById('topology-grid');
  grid.innerHTML = '';
  const vData = (state.sessions.vendors || {})[state.currentVendor];
  if (!vData) return;

  const mainId = vData.main_thread_id;
  const modules = vData.modules || {};

  // 主会话中枢卡片
  const mainCard = document.createElement('div');
  mainCard.className = 'card main-card';
  mainCard.innerHTML = `
    <div class="card-head">
      <span class="card-title">${t('topology_main_title')}</span>
      <div style="display: flex; align-items: center; gap: 6px;">
        <span class="session-status-badge status-active">
          <span class="pulse-dot green"></span>
          <span>ACTIVE</span>
        </span>
        <span class="badge badge-blue">${t('topology_main_badge')}</span>
      </div>
    </div>
    <div class="kv-table">
      <div class="kv-row">
        <span class="kv-key">${t('topology_key_session')}</span>
        <span class="kv-val">${mainId || 'none'}</span>
      </div>
      <div class="kv-row">
        <span class="kv-key">${t('topology_key_memory')}</span>
        <span class="kv-val">docs/MEMORY.md</span>
      </div>
    </div>
    <div style="margin-top: 6px;">
      <button class="btn" onclick="openSession('${mainId}', '${state.currentVendor}')" style="padding: 6px 12px; font-size: 13px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
        </svg>
        <span>${t('topology_btn_open')}</span>
      </button>
    </div>
  `;
  grid.appendChild(mainCard);

  // 专题模块卡片
  Object.entries(modules).forEach(([mKey, item]) => {
    if (mKey === 'main') return;

    let healthClass = 'status-idle';
    let healthLabel = t('health_status_idle');
    const isUnbound = !item.session_id || item.session_id === 'unbound';

    if (isUnbound) {
      healthClass = 'status-unbound';
      healthLabel = t('health_status_unbound');
    } else {
      const hasRunningTask = (state.todo.items || []).some(tk => {
        if (tk.status !== 'in_progress') return false;
        const text = `${tk.title || ''} ${tk.objective || ''} ${(tk.tags || []).join(' ')}`.toLowerCase();
        return text.includes(mKey.toLowerCase()) || (tk.module_key && tk.module_key === mKey);
      });
      if (hasRunningTask) {
        healthClass = 'status-running';
        healthLabel = t('health_status_running');
      }
    }

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <span class="card-title">${item.title || mKey}</span>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="session-status-badge ${healthClass}">
            <span class="pulse-dot ${healthClass === 'status-running' ? 'green' : (healthClass === 'status-idle' ? 'blue' : '')}"></span>
            <span>${healthLabel}</span>
          </span>
          <span class="badge ${item.resumable !== false ? 'badge-green' : ''}">${t('topology_topic_badge')}</span>
        </div>
      </div>
      <div class="kv-table">
        <div class="kv-row">
          <span class="kv-key">${t('topology_key_session')}</span>
          <span class="kv-val">${item.session_id || 'unbound'}</span>
        </div>
        <div class="kv-row">
          <span class="kv-key">${t('topology_key_memory')}</span>
          <span class="kv-val">${item.memory_doc || (item.memory_docs && item.memory_docs[0]) || 'none'}</span>
        </div>
        <div class="kv-row">
          <span class="kv-key">${t('topology_key_resumable')}</span>
          <span class="kv-val" style="color: ${item.resumable !== false ? 'var(--c-green)' : 'var(--text-muted)'};">
            ${item.resumable !== false ? t('yes') : t('no')}
          </span>
        </div>
      </div>
      <div style="margin-top: 6px; display: flex; gap: 8px;">
        <button class="btn" onclick="openSession('${item.session_id}', '${state.currentVendor}')" style="padding: 6px 12px; font-size: 13px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
          </svg>
          <span>${t('topology_btn_open')}</span>
        </button>
        <button class="btn" onclick="navigator.clipboard.writeText('${item.session_id}'); showToast(t('toast_copied_link'));" style="padding: 6px 12px; font-size: 13px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <span>${t('topology_btn_copy')}</span>
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
}

window.openSession = function(sessionId, vendor) {
  if (!sessionId || sessionId === 'unbound' || sessionId === 'none') {
    showToast(state.lang === 'zh' ? '会话未绑定，无法打开' : 'Session is unbound');
    return;
  }
  try { navigator.clipboard.writeText(sessionId); } catch (e) {}

  const v = (vendor || state.currentVendor || 'antigravity').toLowerCase();
  let schemeUrl = `antigravity://conversation/${sessionId}`;
  if (v === 'zcode') schemeUrl = `zcode://open?session=${sessionId}`;
  else if (v === 'codex') schemeUrl = `vscode://antigravity.open?session=${sessionId}`;
  else if (v === 'claude') schemeUrl = `claude://open?session=${sessionId}`;

  try {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = schemeUrl;
    document.body.appendChild(iframe);
    setTimeout(() => {
      try { document.body.removeChild(iframe); } catch (e) {}
    }, 2000);
  } catch (err) {
    window.location.href = schemeUrl;
  }

  setTimeout(() => {
    showToast(state.lang === 'zh' 
      ? `已尝试唤起 [${v.toUpperCase()}] 客户端！(会话 ID 已复制)` 
      : `Attempted to launch [${v.toUpperCase()}]! (ID copied)`);
  }, 300);
};

function checkTopicHealth() {
  renderTopology();
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const tabHealthEl = document.getElementById('tab-health-text');
  if (tabHealthEl) tabHealthEl.innerText = `HEALTH: ${timeStr}`;

  const vData = (state.sessions.vendors || {})[state.currentVendor] || {};
  const modCount = Object.keys(vData.modules || {}).length;
  console.info(`[Task-Loop:Timer] 5s topic health check at ${timeStr}: vendor=${state.currentVendor}, modules=${modCount}`);
}

function renderPolicy() {
  document.getElementById('policy-vendor').value = state.policy.active_vendor || 'antigravity';
  document.getElementById('policy-lease-min').value = state.policy.lease_minutes || 25;
  document.getElementById('policy-allow-push').checked = Boolean(state.policy.allow_remote_push);

  document.getElementById('lease-holder').innerText = state.lease.holder || 'none';
  document.getElementById('lease-acquired').innerText = state.lease.acquired_at || 'none';
  document.getElementById('lease-expires').innerText = state.lease.expires_at || 'none';
  
  const badge = document.getElementById('lease-badge');
  const isLocked = state.lease.status === 'LOCKED';
  badge.innerText = isLocked ? t('lease_locked') : t('lease_unlocked');
  badge.className = `badge ${isLocked ? 'badge-red' : 'badge-green'}`;
  
  document.getElementById('btn-toggle-lease-text').innerText = isLocked ? t('lease_btn_unlock') : t('lease_btn_lock');
  document.getElementById('btn-toggle-lease').className = `btn ${isLocked ? 'btn-red' : 'btn-blue'}`;
}

// ==========================================
// 8.1 交互式可折叠 JSON 树形渲染引擎 (Collapsible JSON Tree Engine)
// ==========================================
function renderJsonTree(data, container, defaultMaxDepth = 2) {
  if (!container) return;
  container.innerHTML = '';
  if (data === undefined) {
    container.innerHTML = '<div class="json-val-null" style="padding: 8px;">undefined</div>';
    return;
  }
  const rootNode = createJsonTreeNode(null, data, 0, defaultMaxDepth);
  container.appendChild(rootNode);
}

function createJsonTreeNode(key, value, depth, maxExpandDepth) {
  const node = document.createElement('div');
  node.className = 'json-tree-node';
  node.setAttribute('data-depth', depth);

  const isObject = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);

  if (!isObject) {
    node.classList.add('json-leaf');
    const line = document.createElement('div');
    line.className = 'json-line';

    const placeholder = document.createElement('span');
    placeholder.className = 'json-toggle-placeholder';
    placeholder.style.width = '16px';
    placeholder.style.display = 'inline-block';
    placeholder.style.flexShrink = '0';
    line.appendChild(placeholder);

    if (key !== null) {
      const keySpan = document.createElement('span');
      keySpan.className = typeof key === 'number' ? 'json-index' : 'json-key';
      keySpan.innerText = typeof key === 'number' ? `${key}: ` : `"${key}": `;
      line.appendChild(keySpan);
    }

    const valSpan = document.createElement('span');
    if (typeof value === 'string') {
      valSpan.className = 'json-val-str';
      valSpan.innerText = `"${value}"`;
    } else if (typeof value === 'number') {
      valSpan.className = 'json-val-num';
      valSpan.innerText = String(value);
    } else if (typeof value === 'boolean') {
      valSpan.className = 'json-val-bool';
      valSpan.innerText = String(value);
    } else if (value === null) {
      valSpan.className = 'json-val-null';
      valSpan.innerText = 'null';
    }
    line.appendChild(valSpan);
    node.appendChild(line);
    return node;
  }

  node.classList.add('json-collapsible');
  const keys = Object.keys(value);
  const count = keys.length;
  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';

  if (depth >= maxExpandDepth) {
    node.classList.add('collapsed');
  }

  const line = document.createElement('div');
  line.className = 'json-line';

  const toggle = document.createElement('span');
  toggle.className = 'json-toggle';
  toggle.title = '点击展开 / 收起节点';
  toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;
  line.appendChild(toggle);

  if (key !== null) {
    const keySpan = document.createElement('span');
    keySpan.className = typeof key === 'number' ? 'json-index' : 'json-key';
    keySpan.innerText = typeof key === 'number' ? `${key}: ` : `"${key}": `;
    line.appendChild(keySpan);
  }

  const openSpan = document.createElement('span');
  openSpan.className = 'json-open';
  openSpan.innerText = openBracket;
  line.appendChild(openSpan);

  const countBadge = document.createElement('span');
  countBadge.className = 'json-count';
  countBadge.innerText = isArray ? `${count} items` : `${count} keys`;
  line.appendChild(countBadge);

  const preview = document.createElement('span');
  preview.className = 'json-collapsed-preview';
  preview.innerText = isArray ? `[ ... ${count} items ]` : `{ ... ${count} keys }`;
  line.appendChild(preview);

  const toggleHandler = (e) => {
    e.stopPropagation();
    node.classList.toggle('collapsed');
  };
  toggle.onclick = toggleHandler;
  line.onclick = toggleHandler;

  node.appendChild(line);

  if (count > 0) {
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'json-children';
    keys.forEach(k => {
      const childKey = isArray ? parseInt(k, 10) : k;
      const childNode = createJsonTreeNode(childKey, value[k], depth + 1, maxExpandDepth);
      childrenContainer.appendChild(childNode);
    });
    node.appendChild(childrenContainer);
  }

  const closeSpan = document.createElement('div');
  closeSpan.className = 'json-close';
  closeSpan.innerText = closeBracket;
  node.appendChild(closeSpan);

  return node;
}

window.expandAllJsonTree = function() {
  const container = document.getElementById('json-tree-viewer');
  if (!container) return;
  container.querySelectorAll('.json-collapsible.collapsed').forEach(el => {
    el.classList.remove('collapsed');
  });
  showToast(t('raw_expand_all') || '已全部展开');
};

window.collapseAllJsonTree = function() {
  const container = document.getElementById('json-tree-viewer');
  if (!container) return;
  container.querySelectorAll('.json-collapsible').forEach(el => {
    el.classList.add('collapsed');
  });
  const root = container.firstElementChild;
  if (root && root.classList.contains('json-collapsible')) {
    root.classList.remove('collapsed');
  }
  showToast(t('raw_collapse_all') || '已全部收起');
};

function updateRawEditor() {
  const editor = document.getElementById('raw-editor');
  const treeViewer = document.getElementById('json-tree-viewer');
  const data = state[state.currentRaw] || {};
  const jsonStr = JSON.stringify(data, null, 2);

  if (editor) {
    editor.value = jsonStr;
  }
  if (treeViewer) {
    renderJsonTree(data, treeViewer, 2);
  }
}

// 9. 二次确认弹窗总线控制
let pendingMove = null;
let pendingDelete = null;

window.requestMoveTask = function(taskId, targetStatus) {
  const item = (state.todo.items || []).find(t => t.id === taskId);
  if (!item) return;
  pendingMove = { taskId, targetStatus };
  document.getElementById('modal-task-name').innerText = item.title || taskId;
  document.getElementById('modal-from-status').innerText = (item.status || 'pending').toUpperCase().replace('_', ' ');
  document.getElementById('modal-to-status').innerText = targetStatus.toUpperCase().replace('_', ' ');
  document.getElementById('modal-confirm').style.display = 'flex';
};

function closeModalConfirm() {
  pendingMove = null;
  document.getElementById('modal-confirm').style.display = 'none';
}

function confirmMoveTask() {
  if (!pendingMove) return;
  const { taskId, targetStatus } = pendingMove;
  const item = (state.todo.items || []).find(t => t.id === taskId);
  if (item) {
    item.status = targetStatus;
    renderKanban();
    updateRawEditor();
    persistFile('todo.json', state.todo);
    showToast(`${t('toast_task_moved')}${targetStatus}`);
  }
  closeModalConfirm();
}

window.requestDeleteTask = function(taskId) {
  const item = (state.todo.items || []).find(t => t.id === taskId);
  if (!item) return;
  pendingDelete = { taskId };
  document.getElementById('modal-del-task-name').innerText = item.title || taskId;
  document.getElementById('modal-delete').style.display = 'flex';
};

function closeModalDelete() {
  pendingDelete = null;
  document.getElementById('modal-delete').style.display = 'none';
}

function confirmDeleteTask() {
  if (!pendingDelete) return;
  const { taskId } = pendingDelete;
  state.todo.items = (state.todo.items || []).filter(t => t.id !== taskId);
  renderKanban();
  updateRawEditor();
  persistFile('todo.json', state.todo);
  showToast(t('toast_task_deleted'));
  closeModalDelete();
}

function renderAll() {
  applyI18n();
  renderStatusBar();
  renderBreadcrumb();
  renderTopology();
  renderKanban();
  renderPolicy();
  updateRawEditor();
}

// 10. 事件绑定与全系统初始化
function setupEvents() {
  const langSwitchBtn = document.getElementById('lang-switch-btn');
  if (langSwitchBtn) langSwitchBtn.onclick = toggleLanguage;

  const statusSourceBtn = document.getElementById('status-source-btn') || document.getElementById('text-source');
  if (statusSourceBtn) statusSourceBtn.onclick = () => selectDirectory();
  
  document.getElementById('btn-reset-data').onclick = () => {
    state.sessions = JSON.parse(JSON.stringify(window.DEFAULT_SESSIONS));
    state.todo = JSON.parse(JSON.stringify(window.DEFAULT_TODO));
    state.policy = JSON.parse(JSON.stringify(window.DEFAULT_POLICY));
    state.lease = JSON.parse(JSON.stringify(window.DEFAULT_LEASE));
    state.dirHandle = null;
    clearStoredDirHandle();
    updateSyncTimestamp('MEM');
    renderAll();
    showToast(t('toast_reset'));
  };

  const btnConfirm = document.getElementById('btn-modal-confirm');
  if (btnConfirm) btnConfirm.onclick = confirmMoveTask;
  const btnCancel = document.getElementById('btn-modal-cancel');
  if (btnCancel) btnCancel.onclick = closeModalConfirm;
  const btnClose = document.getElementById('btn-modal-close');
  if (btnClose) btnClose.onclick = closeModalConfirm;
  const modalMask = document.getElementById('modal-confirm');
  if (modalMask) {
    modalMask.onclick = (e) => {
      if (e.target.id === 'modal-confirm') closeModalConfirm();
    };
  }

  const btnDelConfirm = document.getElementById('btn-modal-del-confirm');
  if (btnDelConfirm) btnDelConfirm.onclick = confirmDeleteTask;
  const btnDelCancel = document.getElementById('btn-modal-del-cancel');
  if (btnDelCancel) btnDelCancel.onclick = closeModalDelete;
  const btnDelClose = document.getElementById('btn-modal-del-close');
  if (btnDelClose) btnDelClose.onclick = closeModalDelete;
  const modalDelMask = document.getElementById('modal-delete');
  if (modalDelMask) {
    modalDelMask.onclick = (e) => {
      if (e.target.id === 'modal-delete') closeModalDelete();
    };
  }

  window.addEventListener('keydown', (e) => {
    if (pendingDelete) {
      if (e.key === 'Escape') closeModalDelete();
      else if (e.key === 'Enter') confirmDeleteTask();
      return;
    }
    if (pendingMove) {
      if (e.key === 'Escape') closeModalConfirm();
      else if (e.key === 'Enter') confirmMoveTask();
      return;
    }
  });

  document.querySelectorAll('.tab-item').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.getAttribute('data-tab');
      state.currentTab = target;
      document.getElementById(target).classList.add('active');
      if (target === 'view-raw') updateRawEditor();
      renderBreadcrumb();
    };
  });

  document.querySelectorAll('.kanban-col').forEach(col => {
    const targetStatus = col.getAttribute('data-status');

    col.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!col.classList.contains('drag-over')) col.classList.add('drag-over');
    };

    col.ondragenter = (e) => {
      e.preventDefault();
      col.classList.add('drag-over');
    };

    col.ondragleave = (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    };

    col.ondrop = (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const taskId = e.dataTransfer.getData('text/plain');
      if (!taskId) return;
      const item = (state.todo.items || []).find(t => t.id === taskId);
      if (item && item.status !== targetStatus) {
        window.requestMoveTask(taskId, targetStatus);
      }
    };
  });

  document.getElementById('policy-vendor').onchange = (e) => {
    state.policy.active_vendor = e.target.value;
    renderStatusBar();
    updateRawEditor();
    persistFile('policy.json', state.policy);
  };
  document.getElementById('policy-lease-min').oninput = (e) => {
    state.policy.lease_minutes = parseInt(e.target.value, 10) || 25;
    updateRawEditor();
    persistFile('policy.json', state.policy, 300);
  };
  document.getElementById('policy-allow-push').onchange = (e) => {
    state.policy.allow_remote_push = e.target.checked;
    updateRawEditor();
    persistFile('policy.json', state.policy);
  };

  document.getElementById('btn-toggle-lease').onclick = () => {
    if (state.lease.status === 'LOCKED') {
      state.lease = { holder: null, acquired_at: null, expires_at: null, status: 'UNLOCKED' };
    } else {
      const now = new Date();
      const exp = new Date(now.getTime() + (state.policy.lease_minutes || 25) * 60000);
      state.lease = {
        holder: 'simulated_main_orchestrator',
        acquired_at: now.toISOString(),
        expires_at: exp.toISOString(),
        status: 'LOCKED'
      };
    }
    renderStatusBar();
    renderPolicy();
    persistFile('lease.json', state.lease);
    showToast(`LEASE -> ${state.lease.status}`);
  };

  const btnTree = document.getElementById('btn-raw-tree');
  const btnCode = document.getElementById('btn-raw-code');
  const treeViewer = document.getElementById('json-tree-viewer');
  const rawEditor = document.getElementById('raw-editor');
  const treeTools = document.getElementById('raw-tree-tools');

  function setRawMode(mode) {
    state.rawMode = mode;
    if (mode === 'tree') {
      if (btnTree) btnTree.classList.add('active');
      if (btnCode) btnCode.classList.remove('active');
      if (treeViewer) treeViewer.style.display = 'block';
      if (rawEditor) rawEditor.style.display = 'none';
      if (treeTools) treeTools.style.display = 'inline-flex';
      try {
        if (rawEditor && rawEditor.value) {
          const parsed = JSON.parse(rawEditor.value);
          state[state.currentRaw] = parsed;
          renderJsonTree(parsed, treeViewer, 2);
        } else {
          renderJsonTree(state[state.currentRaw] || {}, treeViewer, 2);
        }
      } catch (e) {
        renderJsonTree(state[state.currentRaw] || {}, treeViewer, 2);
      }
    } else {
      if (btnCode) btnCode.classList.add('active');
      if (btnTree) btnTree.classList.remove('active');
      if (treeViewer) treeViewer.style.display = 'none';
      if (rawEditor) {
        rawEditor.style.display = 'block';
        rawEditor.value = JSON.stringify(state[state.currentRaw] || {}, null, 2);
      }
      if (treeTools) treeTools.style.display = 'none';
    }
  }

  if (btnTree) btnTree.onclick = () => setRawMode('tree');
  if (btnCode) btnCode.onclick = () => setRawMode('code');

  const btnExpandAll = document.getElementById('btn-expand-all');
  if (btnExpandAll) btnExpandAll.onclick = expandAllJsonTree;

  const btnCollapseAll = document.getElementById('btn-collapse-all');
  if (btnCollapseAll) btnCollapseAll.onclick = collapseAllJsonTree;

  document.querySelectorAll('.raw-switch').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.raw-switch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentRaw = btn.getAttribute('data-file');
      updateRawEditor();
      renderBreadcrumb();
    };
  });

  document.getElementById('btn-apply-raw').onclick = () => {
    try {
      let val;
      const editorEl = document.getElementById('raw-editor');
      if (state.rawMode === 'code' && editorEl) {
        val = JSON.parse(editorEl.value);
      } else {
        val = state[state.currentRaw] || (editorEl ? JSON.parse(editorEl.value) : {});
      }
      if (state.currentRaw === 'sessions') {
        state.sessions = val;
        persistFile('sessions.json', state.sessions);
      } else if (state.currentRaw === 'todo') {
        state.todo = val;
        persistFile('todo.json', state.todo);
      } else if (state.currentRaw === 'policy') {
        state.policy = val;
        persistFile('policy.json', state.policy);
      }
      renderAll();
      showToast(`${t('toast_raw_applied')}${state.currentRaw}.json`);
    } catch (err) {
      alert('INVALID JSON: ' + err.message);
    }
  };

  // 1s 轮询扫描 (按用户批注，降低高频轮询开销) 与 5s 健康探测
  const pollTimerId = setInterval(pollFromDisk, 1000);
  const healthTimerId = setInterval(checkTopicHealth, 5000);
  console.info(`[Task-Loop:Timer] Background timers initialized: 1s pollFromDisk (id=${pollTimerId}), 5s checkTopicHealth (id=${healthTimerId})`);
}

async function initAutoConnect() {
  console.info('[Task-Loop:Timer] Auto-connect task initiated: checking IndexedDB stored directory handles...');
  const cachedHandle = await getStoredDirHandle();
  if (cachedHandle) {
    try {
      let perm = await cachedHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await cachedHandle.requestPermission({ mode: 'readwrite' });
      }
      if (perm === 'granted') {
        await loadFromDirectory(cachedHandle);
        renderAll();
        updateSyncTimestamp('RESTORE');
        console.info(`[Task-Loop:Timer] Directory handle restored from IndexedDB: ${cachedHandle.name || 'task-loop'}`);
        showToast(`${t('toast_dir_attached')}${cachedHandle.name || 'task-loop'}`);
        return;
      }
    } catch (e) {
      console.warn('[Auto-Connect] Restore DirectoryHandle failed:', e);
    }
  }

  console.info('[Task-Loop:Timer] Trying auto-fetch status files via HTTP...');
  const fetched = await autoFetchFromLocal();
  if (fetched) {
    console.info('[Task-Loop:Timer] Auto-fetch succeeded: status files synchronized');
    showToast(state.lang === 'zh' ? '已自动拉取本地最新状态文件' : 'Auto-fetched local status files');
  } else {
    console.info('[Task-Loop:Timer] Running in offline / embedded seed snapshot mode');
  }
}

// 页面启动装载
document.addEventListener('DOMContentLoaded', () => {
  setupEvents();
  renderAll();
  checkTopicHealth();
  initAutoConnect();
});
