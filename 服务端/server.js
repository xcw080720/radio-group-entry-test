#!/usr/bin/env node
/* ================================================================
   群规测验服务端 —— 零依赖（只用 Node 内置模块）
   ----------------------------------------------------------------
   启动：  node server.js
   停止：  Ctrl + C
   配置：  config.json

   对外接口
   ─────────────────────────────────────────────────────────────
   GET  /                     说明页
   GET  /quiz?sid=xxx         答题页（sid 省略则按本地题库出题）
   GET  /health               健康检查

   POST /api/session          创建答题会话（随机抽题）
       body { uid?, name?, groupId?, count? }
       resp { ok, sid, url, count, passScore, corePassRate }

   GET  /api/session/:sid     取题（不含答案）
       resp { ok, sid, name, count, questions:[…] }

   POST /api/session/:sid/submit   交卷判分
       body { answers: [ [选项下标…] | ["填词内容"] , … ] }
       resp { ok, score, passed, right, total, code, wrongs:[…] }

   GET  /api/session/:sid/result   查单人成绩
   GET  /api/list?token=xxx        全部提交记录（管理）
   GET  /api/stats?token=xxx       统计概览（管理）

   POST /webhook/qq           QQ bot 事件上报（HTTP 反向）
   WS   /ws                   OneBot 反向 WebSocket（NapCat 直连）
   ================================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { handleUpgrade } = require('./ws.js');
const quiz = require('../抽题器.js');

const DIR = __dirname;
const ROOT = path.join(DIR, '..');
const CFG = path.join(DIR, 'config.json');
const QUIZ_HTML = path.join(ROOT, '群规问卷.html');
const RESULTS_LOG = path.join(DIR, 'results.jsonl');

let CONFIG = JSON.parse(fs.readFileSync(CFG, 'utf8'));
let POOL = quiz.loadPool(path.join(ROOT, '题库.json'));

/* ---------------- 会话存储（内存） ---------------- */
const sessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000;   // 2 小时过期
const RESULT_LOG_KEEP = 5000;             // 结果留多少条

function newSid() { return crypto.randomBytes(8).toString('hex'); }

function makeCode(seed) {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  let s = (h1.toString(36) + h2.toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  while (s.length < 8) s += 'X';
  return s.slice(0, 4) + '-' + s.slice(4, 8);
}

function createSession(opts) {
  const o = opts || {};
  /* 同一个人 10 分钟内重复触发 → 复用未交卷的会话 */
  if (o.uid) {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.uid === o.uid && !s.result && now - s.createdAt < 10 * 60 * 1000) return s;
    }
  }
  const count = Math.max(1, Math.min(50, parseInt(o.count || CONFIG.drawCount, 10) || 10));
  const sid = newSid();
  const s = {
    sid: sid,
    uid: String(o.uid || ''),
    name: String(o.name || ''),
    groupId: String(o.groupId || ''),
    paper: quiz.buildPaper(POOL, count),
    result: null,
    code: '',
    createdAt: Date.now(),
    submittedAt: 0,
  };
  sessions.set(sid, s);
  return s;
}

function sweepSessions() {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(k);
  }
}
setInterval(sweepSessions, 10 * 60 * 1000).unref();

/* ---------------- 结果落盘 ---------------- */
function appendResult(rec) {
  try { fs.appendFileSync(RESULTS_LOG, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) {}
}
function readResults() {
  try {
    const t = fs.readFileSync(RESULTS_LOG, 'utf8').trim();
    if (!t) return [];
    const arr = t.split('\n').map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    return arr.slice(-RESULT_LOG_KEEP);
  } catch (e) { return []; }
}

/* ---------------- QQ bot 通道 ---------------- */
const wsClients = new Set();
let echoSeq = 0;

/* 优先走 WebSocket（OneBot 反向 WS），没连上就降级用 HTTP API */
function callApi(action, params) {
  const payload = JSON.stringify({ action: action, params: params || {}, echo: 'srv' + (++echoSeq) });
  let viaWs = false;
  wsClients.forEach(function (c) { if (c.alive) { c.send(payload); viaWs = true; } });
  if (viaWs) return Promise.resolve({ ok: true, via: 'ws' });

  const api = CONFIG.bot && CONFIG.bot.httpApi;
  if (!api) return Promise.resolve({ ok: false, via: 'none', reason: '未连接 WS，且未配置 httpApi' });

  let url = api.replace(/\/$/, '') + '/' + action;
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.bot.accessToken) headers['Authorization'] = 'Bearer ' + CONFIG.bot.accessToken;
  return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(params || {}) })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (j) { return { ok: true, via: 'http', resp: j }; })
    .catch(function (e) { return { ok: false, via: 'http', reason: String(e && e.message || e) }; });
}

function notifyResult(s) {
  const r = s.result;
  if (!r) return;
  const text = [
    '【群规测验·提交】',
    '昵称：' + (s.name || '（未填）'),
    s.uid ? ('QQ：' + s.uid) : '',
    '成绩：' + r.score + ' 分（答对 ' + r.right + '/' + r.total + '）',
    '必答区：' + r.coreRight + '/' + r.coreTotal + '（' + Math.round(r.coreRate * 100) + '%）',
    '结果：' + (r.passed ? '✅ 通过' : '❌ 未通过'),
    '凭证码：' + s.code,
    '时间：' + new Date(s.submittedAt).toLocaleString('zh-CN'),
  ].filter(Boolean).join('\n');

  /* 1) 发到 QQ 群 */
  const gid = s.groupId || (CONFIG.bot && CONFIG.bot.notifyGroupId);
  if (CONFIG.bot && CONFIG.bot.enabled && gid) {
    callApi('send_group_msg', { group_id: Number(gid) || gid, message: text })
      .then(function (res) { if (!res.ok) log('⚠ 结果通知未发出：' + res.reason); });
  }

  /* 2) 再推一份到自定义地址 */
  const cb = CONFIG.bot && CONFIG.bot.callbackUrl;
  if (cb) {
    const body = JSON.stringify({ type: 'quiz_result', nickname: s.name, uid: s.uid, groupId: s.groupId, code: s.code, submittedAt: s.submittedAt, result: r });
    fetch(cb, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .catch(function (e) { log('⚠ callbackUrl 推送失败：' + (e && e.message)); });
  }
}

/* 处理 OneBot v11 事件 */
function handleOneBotEvent(ev, conn) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.post_type === 'meta_event' || ev.post_type === 'notice') return;
  if (ev.post_type !== 'message') return;

  const raw = String(ev.raw_message || ev.message || '').trim();
  const kws = (CONFIG.bot && CONFIG.bot.triggerKeywords) || ['答题'];
  const hit = kws.some(function (k) { return raw === k || raw.indexOf(k) !== -1; });
  if (!hit) return;

  const uid = String(ev.user_id || '');
  const gid = String(ev.group_id || '');
  const nick = (ev.sender && (ev.sender.card || ev.sender.nickname)) || '';
  const s = createSession({ uid: uid, name: nick, groupId: gid });
  const url = baseUrl() + '/quiz?sid=' + s.sid;

  log('▶ ' + (nick || uid) + ' 发起答题，sid=' + s.sid + '（' + s.paper.length + ' 题）');

  const reply = [
    '📝 群规准入测验',
    '',
    '共 ' + s.paper.length + ' 题，答对 ' + Math.round(s.paper.length * CONFIG.passScore / 100) + ' 题以上算通过。',
    '点击链接开始：' + url,
    '（链接 2 小时内有效）',
  ].join('\n');

  if (gid) callApi('send_group_msg', { group_id: Number(gid) || gid, message: reply });
  else if (uid) callApi('send_private_msg', { user_id: Number(uid) || uid, message: reply });
}

/* ---------------- 工具 ---------------- */
function log() { console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] ' + Array.prototype.join.call(arguments, ' ')); }

function baseUrl() {
  const u = (CONFIG.publicUrl || '').replace(/\/$/, '');
  if (u) return u;
  return 'http://127.0.0.1:' + CONFIG.port;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function text(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': (type || 'text/html') + '; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve) {
    let b = '';
    req.on('data', function (d) { if (b.length < 2e6) b += d; });
    req.on('end', function () {
      if (!b) return resolve({});
      try { resolve(JSON.parse(b)); } catch (e) { resolve({ _raw: b }); }
    });
  });
}
function checkAdmin(url) {
  const t = url.searchParams.get('token') || '';
  return t && t === CONFIG.adminToken;
}

/* ---------------- HTTP 路由 ---------------- */
const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  /* ---- 健康检查 ---- */
  if (p === '/health') {
    return json(res, 200, {
      ok: true, service: 'group-rules-quiz', version: '1.0',
      pool: POOL.length, sessions: sessions.size, wsClients: wsClients.size,
      uptime: Math.round(process.uptime()) + 's',
    });
  }

  /* ---- 答题页 ---- */
  if (p === '/quiz' || p === '/quiz.html') {
    try {
      const html = fs.readFileSync(QUIZ_HTML, 'utf8');
      return text(res, 200, html, 'text/html');
    } catch (e) { return text(res, 500, '找不到 群规问卷.html'); }
  }

  /* ---- 创建会话 ---- */
  if (p === '/api/session' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      const s = createSession(b);
      log('＋ 创建会话 ' + s.sid + '（' + s.paper.length + ' 题）' + (s.name ? ' — ' + s.name : ''));
      json(res, 200, {
        ok: true, sid: s.sid, url: baseUrl() + '/quiz?sid=' + s.sid,
        count: s.paper.length, passScore: CONFIG.passScore, corePassRate: CONFIG.corePassRate,
      });
    });
  }

  /* ---- 取题 ---- */
  let m = p.match(/^\/api\/session\/([a-f0-9]+)$/);
  if (m && req.method === 'GET') {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { ok: false, error: '会话不存在或已过期' });
    if (s.result) return json(res, 200, { ok: true, sid: s.sid, done: true, name: s.name, code: s.code, passScore: CONFIG.passScore, corePassRate: CONFIG.corePassRate, result: s.result });
    const questions = s.paper.map(function (q) {
      if (q.type === 'fill') return { type: 'fill', sec: q.sec, core: q.core, q: q.q };
      return { type: q.type, sec: q.sec, core: q.core, q: q.q, options: q.options };
    });
    return json(res, 200, {
      ok: true, sid: s.sid, name: s.name, count: questions.length,
      passScore: CONFIG.passScore, corePassRate: CONFIG.corePassRate, questions: questions,
    });
  }

  /* ---- 交卷 ---- */
  m = p.match(/^\/api\/session\/([a-f0-9]+)\/submit$/);
  if (m && req.method === 'POST') {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { ok: false, error: '会话不存在或已过期' });
    if (s.result) return json(res, 200, { ok: true, already: true, score: s.result.score, passed: s.result.passed, code: s.code, result: s.result });
    return readBody(req).then(function (b) {
      const answers = Array.isArray(b.answers) ? b.answers : [];
      const g = quiz.grade(s.paper, answers);
      const passed = (g.score >= CONFIG.passScore) && (g.coreRate >= CONFIG.corePassRate);
      s.result = g;
      s.submittedAt = Date.now();
      s.code = makeCode(s.sid + '|' + s.name + '|' + g.score);
      s.result.code = s.code;

      appendResult({
        sid: s.sid, uid: s.uid, name: s.name, groupId: s.groupId, code: s.code,
        score: g.score, passed: passed, right: g.right, total: g.total,
        coreRight: g.coreRight, coreTotal: g.coreTotal,
        submittedAt: s.submittedAt,
      });

      log('✔ ' + (s.name || s.uid || s.sid) + ' 交卷：' + g.score + ' 分 · ' + (passed ? '通过' : '未通过'));
      notifyResult(s);

      json(res, 200, {
        ok: true, score: g.score, passed: passed, right: g.right, total: g.total,
        coreRight: g.coreRight, coreTotal: g.coreTotal, coreRate: g.coreRate,
        blank: g.blank, code: s.code, wrongs: g.wrongs,
        passScore: CONFIG.passScore, corePassRate: CONFIG.corePassRate,
      });
    });
  }

  /* ---- 查单人成绩 ---- */
  m = p.match(/^\/api\/session\/([a-f0-9]+)\/result$/);
  if (m && req.method === 'GET') {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { ok: false, error: '会话不存在或已过期' });
    if (!s.result) return json(res, 200, { ok: true, done: false });
    return json(res, 200, { ok: true, done: true, sid: s.sid, name: s.name, uid: s.uid, code: s.code, submittedAt: s.submittedAt, result: s.result });
  }

  /* ---- 名单（管理） ---- */
  if (p === '/api/list' && req.method === 'GET') {
    if (!checkAdmin(url)) return json(res, 403, { ok: false, error: 'token 不对' });
    const all = readResults();
    const onlyFail = url.searchParams.get('fail') === '1';
    const list = onlyFail ? all.filter(function (r) { return !r.passed; }) : all;
    return json(res, 200, { ok: true, count: list.length, list: list.slice(-500).reverse() });
  }

  /* ---- 统计（管理） ---- */
  if (p === '/api/stats' && req.method === 'GET') {
    if (!checkAdmin(url)) return json(res, 403, { ok: false, error: 'token 不对' });
    const all = readResults();
    const pass = all.filter(function (r) { return r.passed; }).length;
    const avg = all.length ? Math.round(all.reduce(function (a, b) { return a + b.score; }, 0) / all.length) : 0;
    return json(res, 200, {
      ok: true, total: all.length, passed: pass, failed: all.length - pass,
      passRate: all.length ? Math.round(pass / all.length * 100) + '%' : '—',
      avgScore: avg, poolSize: POOL.length, drawCount: CONFIG.drawCount,
      activeSessions: sessions.size,
    });
  }

  /* ---- QQ bot HTTP 上报 ---- */
  if (p === '/webhook/qq' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      /* 支持 OneBot 单事件或数组；也支持 {post_type:...} */
      const events = Array.isArray(b) ? b : [b];
      events.forEach(function (ev) {
        try { handleOneBotEvent(ev, null); } catch (e) { log('⚠ 事件处理失败：' + e.message); }
      });
      json(res, 200, { ok: true, status: 'ok', handled: events.length });
    });
  }

  /* ---- 首页 ---- */
  if (p === '/' || p === '/index.html') {
    const b = baseUrl();
    return text(res, 200, indexPage(b));
  }

  json(res, 404, { ok: false, error: '没有这个接口：' + p });
});

/* ---------------- WebSocket 升级（OneBot 反向 WS） ---------------- */
server.on('upgrade', function (req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws' && url.pathname !== '/onebot') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return;
  }
  const ok = handleUpgrade(req, socket, head, function (conn) {
    wsClients.add(conn);
    log('🔌 OneBot 已连接（当前 ' + wsClients.size + ' 个）');
    conn.on('message', function (txt) {
      let ev; try { ev = JSON.parse(txt); } catch (e) { return; }
      /* OneBot 心跳 */
      if (ev.post_type === 'meta_event' && ev.meta_event_type === 'heartbeat') return;
      /* API 应答 */
      if (ev.echo && ev.status) return;
      try { handleOneBotEvent(ev, conn); } catch (e) { log('⚠ 事件处理失败：' + e.message); }
    });
    conn.on('close', function () {
      wsClients.delete(conn);
      log('🔌 OneBot 断开（剩 ' + wsClients.size + ' 个）');
    });
  });
  if (!ok) log('⚠ WebSocket 握手失败');
});

/* ---------------- 首页 HTML ---------------- */
function indexPage(base) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>群规测验服务</title><style>'
    + 'body{font-family:-apple-system,"Microsoft YaHei",sans-serif;max-width:720px;margin:0 auto;padding:32px 20px;'
    + 'background:#f8fafc;color:#0f172a;line-height:1.7}'
    + 'h1{font-size:24px;margin:0 0 6px}.sub{color:#64748b;font-size:14px;margin-bottom:26px}'
    + 'div.card{background:#fff;border-radius:16px;padding:20px 22px;margin-bottom:14px;box-shadow:0 8px 24px -12px rgba(15,23,42,.16)}'
    + 'h2{font-size:15px;margin:0 0 12px;color:#334155}'
    + 'code{background:#f1f5f9;padding:2px 6px;border-radius:6px;font-size:13px;color:#4f46e5}'
    + 'a{color:#4f46e5}.ok{color:#059669;font-weight:700}.row{font-size:14px;padding:5px 0;color:#475569}'
    + '</style></head><body>'
    + '<h1>群规测验服务</h1><div class="sub">零依赖 Node 服务 · 随机抽题 · 可接 QQ bot</div>'
    + '<div class="card"><h2>状态</h2>'
    + '<div class="row">题库：' + POOL.length + ' 题　每次抽取：' + CONFIG.drawCount + ' 题</div>'
    + '<div class="row">及格：总分 ≥ ' + CONFIG.passScore + '　必答区 ≥ ' + Math.round(CONFIG.corePassRate * 100) + '%</div>'
    + '<div class="row">在线 QQ bot 连接：' + wsClients.size + ' 个</div>'
    + '</div>'
    + '<div class="card"><h2>常用入口</h2>'
    + '<div class="row">· 答一份试试：<a href="' + base + '/quiz?sid=">' + base + '/quiz</a>（无 sid 时用本地题库出题）</div>'
    + '<div class="row">· 健康检查：<a href="' + base + '/health">' + base + '/health</a></div>'
    + '<div class="row">· 名单（要 token）：<code>' + base + '/api/list?token=你的adminToken</code></div>'
    + '<div class="row">· 统计：<code>' + base + '/api/stats?token=你的adminToken</code></div>'
    + '</div>'
    + '<div class="card"><h2>接 QQ bot</h2>'
    + '<div class="row">协议端（NapCat / Lagrange / go-cqhttp）填：</div>'
    + '<div class="row">· 反向 WS 地址：<code>ws://本机IP:' + CONFIG.port + '/ws</code></div>'
    + '<div class="row">· 或 HTTP 上报地址：<code>' + base + '/webhook/qq</code></div>'
    + '<div class="row">群里发「' + ((CONFIG.bot && CONFIG.bot.triggerKeywords) || ['答题']).join(' / ') + '」即会收到答题链接。</div>'
    + '</div></body></html>';
}

/* ---------------- 启动 ---------------- */
server.listen(CONFIG.port, CONFIG.host, function () {
  log('═══════════════════════════════════════');
  log('  群规测验服务已启动');
  log('  本地：    http://127.0.0.1:' + CONFIG.port);
  log('  答题页：  http://127.0.0.1:' + CONFIG.port + '/quiz');
  log('  题库：    ' + POOL.length + ' 题，每次随机抽 ' + CONFIG.drawCount + ' 题');
  log('  QQ bot：  反向 WS  ws://本机IP:' + CONFIG.port + '/ws');
  log('            或 HTTP  POST http://本机IP:' + CONFIG.port + '/webhook/qq');
  if (!CONFIG.adminToken || CONFIG.adminToken === 'change-me-please') {
    log('  ⚠ 提醒：config.json 里的 adminToken 还是默认值，建议改掉');
  }
  log('═══════════════════════════════════════');
});

process.on('SIGINT', function () { log('收到 Ctrl+C，正在关闭…'); server.close(function () { process.exit(0); }); setTimeout(function () { process.exit(0); }, 1500); });
process.on('uncaughtException', function (e) { log('⚠ 未捕获异常：' + (e && e.stack || e)); });
