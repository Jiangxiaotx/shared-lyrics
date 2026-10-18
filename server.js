'use strict';
// 共享歌词 · 本地服务（无需安装任何依赖，Node.js 内置模块即可运行）
// 职责：1) 启动 PowerShell 桥接进程，读取/控制电脑上的 QQ 音乐；2) 给手机提供网页和接口。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8899);
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'cache');
const LYR_CACHE_FILE = path.join(CACHE_DIR, 'lyrics.json');
const LOCAL_LYR_DIR = path.join(ROOT, 'lyrics');

let bridge = null;
let bridgeBuf = '';
let bridgeLines = 0;
let lastRaw = '';
let restarts = 0;
let parseFail = 0;
let failMsg = '';
let lastLineAt = Date.now();
let state = { ok: true, found: false, status: 'Unknown', title: '', artist: '', album: '', pos: 0, dur: 0, receivedAt: Date.now() };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 桥接进程 ----------
function startBridge() {
  const script = path.join(ROOT, 'bridge.ps1');
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  bridge = ps;
  ps.stdout.setEncoding('utf8');
  ps.stderr.setEncoding('utf8');
  restarts++;
  ps.stdout.on('data', onBridgeData);
  ps.stderr.on('data', (d) => {
    const t = String(d).trim();
    if (t) console.log('[bridge] ' + t);
  });
  ps.on('error', (e) => console.log('[bridge] 启动失败：' + e.message));
  ps.stdin.on('error', (e) => console.log('[bridge] stdin 错误：' + e.message));
  lastLineAt = Date.now();
  ps.on('exit', (code) => {
    if (bridge === ps) bridge = null;
    state = Object.assign({}, state, { found: false });
    setTimeout(startBridge, 3000);
  });
}

function onBridgeData(chunk) {
  bridgeBuf += chunk;
  let idx;
  while ((idx = bridgeBuf.indexOf('\n')) >= 0) {
    const line = bridgeBuf.slice(0, idx).trim();
    bridgeBuf = bridgeBuf.slice(idx + 1);
    if (!line) continue;
    bridgeLines++;
    lastLineAt = Date.now();
    lastRaw = line.slice(0, 200);
    if (line.indexOf('ST ') === 0) {
      try {
        const obj = JSON.parse(line.slice(3));
        state = Object.assign({ ok: true }, obj, { receivedAt: Date.now() });
      } catch (e) { parseFail++; failMsg = e.message + ' :: ' + line.slice(0, 90); }
    } else if (line.indexOf('ERR') === 0) {
      console.log('[bridge] ' + line);
    }
  }
}

function sendCmd(cmd) {
  try {
    if (!bridge || !bridge.stdin.writable) return false;
    bridge.stdin.write(cmd + '\n');
    return true;
  } catch (e) {
    console.log('[bridge] 写入指令失败：' + e.message);
    return false;
  }
}

// 看门狗：桥接进程 6 秒没有任何输出就重启它
setInterval(function () {
  if (bridge && Date.now() - lastLineAt > 6000) {
    console.log('[bridge] 6 秒无响应，重启桥接进程');
    try { bridge.kill(); } catch (e) {}
  }
}, 3000);

// 把状态换算成“此刻”的进度
function currentState() {
  const d = Object.assign({}, state);
  delete d.receivedAt;
  if (d.found && d.status === 'Playing') {
    const extra = (Date.now() - state.receivedAt) / 1000;
    const max = d.dur > 0 ? d.dur : Number.MAX_SAFE_INTEGER;
    d.pos = Math.min(max, Math.max(0, d.pos + extra));
  }
  d.serverTime = Date.now();
  return d;
}

// ---------- 歌词 ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch (e) { console.log('[lyrics] 写缓存失败：' + e.message); }
}
function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\-—_·.,，。()（）\[\]【】]/g, '');
}
async function getJson(url, headers) {
  const res = await fetch(url, {
    headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 SharedLyrics/1.0' }, headers || {}),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

async function fromLrclib(title, artist, dur) {
  const q = encodeURIComponent((title + ' ' + artist).trim());
  const arr = await getJson('https://lrclib.net/api/search?q=' + q);
  if (!Array.isArray(arr) || !arr.length) return null;
  const nt = norm(title);
  let best = null;
  for (const it of arr) {
    const same = norm(it.trackName) === nt || norm(it.trackName).indexOf(nt) >= 0;
    const near = dur > 0 && it.duration ? Math.abs(it.duration - dur) : 99;
    const score = (same ? 10 : 0) + (near < 5 ? 5 : near < 15 ? 2 : 0) + (it.syncedLyrics ? 3 : 0);
    if (!best || score > best.score) best = { score: score, item: it };
  }
  if (!best || best.score < 3) return null;
  const it = best.item;
  return { synced: it.syncedLyrics || '', plain: it.plainLyrics || '', source: 'LRCLIB', title: it.trackName, artist: it.artistName, dur: it.duration || 0 };
}

// 用 QQ 音乐搜索拿封面 / 专辑 / 时长（只请求一次，结果缓存）
async function qqMeta(title, artist) {
  const q = encodeURIComponent((title + ' ' + artist).trim());
  const s = await getJson('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w=' + q + '&format=json', {
    Referer: 'https://y.qq.com/'
  });
  const list = s && s.data && s.data.song && s.data.song.list ? s.data.song.list : [];
  if (!list.length) return null;
  const nt = norm(title);
  const song = list.find(function (x) { return norm(x.songname) === nt; }) || list[0];
  return {
    mid: song.songmid || song.mid || '',
    album: song.albumname || '',
    cover: song.albummid ? 'https://y.qq.com/music/photo_new/T002R300x300M000' + song.albummid + '.jpg' : '',
    dur: song.interval || 0
  };
}

// QQ 音乐没有封面时，用 iTunes 搜索兜底（免费、不需要 key）
async function itunesCover(title, artist) {
  try {
    const q = encodeURIComponent((title + ' ' + artist).trim());
    const j = await getJson('https://itunes.apple.com/search?term=' + q + '&limit=1&media=music');
    const r = j && j.results && j.results[0];
    if (!r || !r.artworkUrl100) return '';
    return String(r.artworkUrl100).replace('100x100bb', '300x300bb');
  } catch (e) { return ''; }
}

async function fromQQ(title, artist, meta) {
  let m = meta;
  if (!m || !m.mid) {
    const nt0 = norm(title);
    const q = encodeURIComponent((title + ' ' + artist).trim());
    const s = await getJson('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w=' + q + '&format=json', {
      Referer: 'https://y.qq.com/'
    });
    const list = s && s.data && s.data.song && s.data.song.list ? s.data.song.list : [];
    if (!list.length) return null;
    const song = list.find(function (x) { return norm(x.songname) === nt0; }) || list[0];
    m = { mid: song.songmid || song.mid || '', album: song.albumname || '', cover: song.albummid ? 'https://y.qq.com/music/photo_new/T002R300x300M000' + song.albummid + '.jpg' : '', dur: song.interval || 0, songname: song.songname, singer: (song.singer || []).map(function (x) { return x.name; }).join('/') };
  }
  const mid = m.mid;
  if (!mid) return null;
  const l = await getJson('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + mid + '&format=json&nobase64=1', {
    Referer: 'https://y.qq.com/portal/player.html'
  });
  if (!l || !l.lyric) return null;
  const text = String(l.lyric).replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); });
  return { synced: text, plain: '', source: 'QQ音乐', title: m.songname || title, artist: m.singer || artist, dur: m.dur || 0, album: m.album || '', cover: m.cover || '' };
}

function fromLocal(title) {
  try {
    if (!fs.existsSync(LOCAL_LYR_DIR)) return null;
    const files = fs.readdirSync(LOCAL_LYR_DIR);
    const nt = norm(title);
    const hit = files.find(function (f) { return norm(f.replace(/\.lrc$/i, '')) === nt; });
    if (!hit) return null;
    return { synced: fs.readFileSync(path.join(LOCAL_LYR_DIR, hit), 'utf8'), plain: '', source: '本地文件' };
  } catch (e) { return null; }
}

const lyricPending = new Map();
async function getLyrics(title, artist, dur) {
  const key = (title + '|' + artist).toLowerCase();
  const cache = readJson(LYR_CACHE_FILE, {});
  const cached = cache[key];
  // 旧缓存没有 cover 字段的，重新查一次封面
  if (cached && cached.synced && Object.prototype.hasOwnProperty.call(cached, 'cover')) return cached;
  if (lyricPending.has(key)) return await lyricPending.get(key);
  const task = (async function () {
    let meta = null;
    let out = null;
    const metaPromise = qqMeta(title, artist).catch(function () { return null; });
    try { out = await fromLrclib(title, artist, dur); } catch (e) { console.log('[lyrics] LRCLIB 失败：' + e.message); }
    meta = await metaPromise;
    if (meta && !meta.cover) meta.cover = await itunesCover(title, artist);
    if (!out || !out.synced) { try { out = await fromQQ(title, artist, meta); } catch (e) { console.log('[lyrics] QQ 失败：' + e.message); } }
    if (!out) out = fromLocal(title);
    if (out) { out.cover = out.cover || (meta && meta.cover) || ''; }
    if (out && meta) {
      out.album = out.album || meta.album || '';
      if (!out.dur) out.dur = meta.dur || 0;
    }
    if (!out && meta) out = { synced: '', plain: '', source: 'none', cover: meta.cover || '', album: meta.album || '', dur: meta.dur || 0 };
    if (out && out.synced) {
      const c = readJson(LYR_CACHE_FILE, {});
      c[key] = out;
      writeJson(LYR_CACHE_FILE, c);
    }
    return out || { synced: '', plain: '', source: 'none' };
  })();
  lyricPending.set(key, task);
  try { return await task; } finally { lyricPending.delete(key); }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve) {
    let data = '';
    req.on('data', function (c) { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', function () {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel.split('?')[0]);
  const file = path.join(PUB, path.normalize(rel).replace(/^([.][.][\\/])+/, ''));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('找不到页面'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (p === '/api/state') { sendJson(res, 200, currentState()); return; }
  if (p === '/api/control' && req.method === 'POST') {
    const body = await readBody(req);
    const cmd = String(body.cmd || '');
    const allow = ['play', 'pause', 'toggle', 'next', 'prev', 'seek'];
    if (allow.indexOf(cmd) < 0) { sendJson(res, 400, { ok: false, msg: '不支持的指令' }); return; }
    let line = cmd;
    if (cmd === 'seek') {
      // 跳转要验证是否真的生效：有的播放器（QQ 音乐）会返回成功但位置不动
      const target = Number(body.val || 0);
      const started = sendCmd('seek ' + target.toFixed(2));
      if (!started) { sendJson(res, 503, { ok: false, msg: '桥接进程未就绪' }); return; }
      await sleep(1300);
      const after = currentState();
      const applied = after.found && Math.abs(after.pos - target) < 8;
      sendJson(res, 200, {
        ok: applied,
        applied: applied,
        pos: after.pos,
        msg: applied ? '' : 'QQ 音乐客户端不接受外部跳转，进度条已还原'
      });
      return;
    }
    const ok = sendCmd(line);
    sendJson(res, ok ? 200 : 503, { ok: ok, msg: ok ? '' : '桥接进程未就绪' });
    return;
  }
  if (p === '/api/lyrics') {
    const title = u.searchParams.get('title') || '';
    const artist = u.searchParams.get('artist') || '';
    const dur = Number(u.searchParams.get('dur') || 0);
    if (!title) { sendJson(res, 200, { synced: '', source: 'none' }); return; }
    try {
      const r = await getLyrics(title, artist, dur);
      sendJson(res, 200, r);
    } catch (e) {
      sendJson(res, 200, { synced: '', source: 'none', msg: e.message });
    }
    return;
  }
  if (p === '/api/cover') {
    const title = u.searchParams.get('title') || '';
    const artist = u.searchParams.get('artist') || '';
    if (!title) { sendJson(res, 200, { cover: '' }); return; }
    try {
      const m = await qqMeta(title, artist);
      let cover = (m && m.cover) || '';
      if (!cover) cover = await itunesCover(title, artist);
      sendJson(res, 200, { cover: cover, album: (m && m.album) || '' });
    } catch (e) { sendJson(res, 200, { cover: '' }); }
    return;
  }
  if (p === '/api/health') { sendJson(res, 200, { ok: true, bridge: !!bridge, ts: Date.now() }); return; }
  if (p === '/api/debug') { sendJson(res, 200, { bridgePid: bridge ? bridge.pid : 0, restarts: restarts, lines: bridgeLines, parseFail: parseFail, failMsg: failMsg, lastRaw: lastRaw, bridgeBuf: bridgeBuf.slice(0, 120) }); return; }
  serveStatic(req, res, p);
});

server.on('error', function (e) {
  if (e && e.code === 'EADDRINUSE') {
    console.log('端口 ' + PORT + ' 已被占用：服务可能已经在运行了。');
    console.log('可以直接打开 http://localhost:' + PORT + ' 使用。');
    process.exit(0);
  }
  console.log('启动失败：' + (e && e.message));
  process.exit(1);
});

process.on('uncaughtException', function (e) {
  console.log('未捕获异常：' + (e && e.stack || e));
});

server.listen(PORT, '0.0.0.0', function () {
  const ips = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (it) {
      if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
    });
  });
  console.log('==============================================');
  console.log(' 共享歌词 已启动');
  console.log(' 电脑本机：http://localhost:' + PORT);
  ips.forEach(function (ip) { console.log(' 手机访问：http://' + ip + ':' + PORT); });
  console.log(' 保持本窗口开着；关闭窗口即停止服务');
  console.log('==============================================');
  startBridge();
});

process.on('SIGINT', function () {
  if (bridge && bridge.stdin.writable) bridge.stdin.end();
  process.exit(0);
});
