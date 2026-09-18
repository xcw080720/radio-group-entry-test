/* 接口自测：跑一遍完整流程（建会话 → 取题 → 交卷 → 查成绩 → 统计）
   用法：node _apitest.js            （服务需已启动）
   跑完可删。 */
const fs = require('fs');
const path = require('path');
const BASE = process.env.QUIZ_BASE || 'http://127.0.0.1:8788';
const TOKEN = 'change-me-please';

function j(v) { return JSON.stringify(v); }

async function waitHealth(n) {
  for (let i = 0; i < (n || 20); i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  return null;
}

(async function () {
  console.log('▶ 目标：' + BASE);

  const health = await waitHealth(20);
  if (!health) { console.error('❌ 服务没起来，检查 server.js 是否已启动'); process.exit(1); }
  console.log('✅ /health →', j(health));

  /* 1. 建会话 */
  const s = await (await fetch(BASE + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: '10001', name: '测试同学', groupId: '123456' }),
  })).json();
  console.log('✅ 建会话 →', j({ sid: s.sid, count: s.count, passScore: s.passScore }));
  if (!s.ok) process.exit(1);

  /* 2. 取题 */
  const q = await (await fetch(BASE + '/api/session/' + s.sid)).json();
  console.log('✅ 取题 → 共 ' + q.count + ' 题，题型：' + q.questions.map(function (x) { return x.type; }).join(', '));
  console.log('   第1题：' + q.questions[0].q);
  const hasAnswerKey = JSON.stringify(q).indexOf('"answer"') !== -1 || JSON.stringify(q).indexOf('"accept"') !== -1;
  console.log((hasAnswerKey ? '❌ 泄漏了答案！' : '✅ 取题接口未泄漏答案'));

  /* 3. 全部答对（对照题库原文找出正确项） */
  const pool = JSON.parse(fs.readFileSync(path.join(__dirname, '题库.json'), 'utf8'));
  const byQ = {};
  pool.forEach(function (p) { byQ[p.q] = p; });

  const answersRight = q.questions.map(function (qq) {
    const src = byQ[qq.q];
    if (!src) return qq.type === 'fill' ? ['不知道'] : [0];
    if (qq.type === 'fill') return [src.accept[0]];
    const texts = src.answer.map(function (i) { return src.options[i]; });
    return qq.options.map(function (t, i) { return texts.indexOf(t) !== -1 ? i : -1; }).filter(function (i) { return i !== -1; });
  });

  const r1 = await (await fetch(BASE + '/api/session/' + s.sid + '/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: answersRight }),
  })).json();
  console.log('✅ 全对交卷 →', j({ score: r1.score, passed: r1.passed, right: r1.right + '/' + r1.total, code: r1.code }));
  if (r1.score !== 100) console.log('   ⚠ 全对却不是 100 分，判分可能有问题');
  if (!r1.passed) console.log('   ⚠ 全对却没通过');

  /* 4. 重复交卷应被拒 */
  const r1b = await (await fetch(BASE + '/api/session/' + s.sid + '/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: [] }),
  })).json();
  console.log((r1b.already ? '✅ 重复交卷被正确拒绝' : '⚠ 重复交卷未被拦截'));

  /* 5. 再开一局，全答错 */
  const s2 = await (await fetch(BASE + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: '10002', name: '反面教材' }),
  })).json();
  const q2 = await (await fetch(BASE + '/api/session/' + s2.sid)).json();
  const answersWrong = q2.questions.map(function (qq) {
    if (qq.type === 'fill') return ['瞎写的'];
    const src = byQ[qq.q];
    const texts = src ? src.answer.map(function (i) { return src.options[i]; }) : [];
    const wrongs = qq.options.map(function (t, i) { return texts.indexOf(t) === -1 ? i : -1; }).filter(function (i) { return i !== -1; });
    return wrongs.length ? [wrongs[0]] : [];
  });
  const r2 = await (await fetch(BASE + '/api/session/' + s2.sid + '/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: answersWrong }),
  })).json();
  console.log('✅ 全错交卷 →', j({ score: r2.score, passed: r2.passed, wrongs: r2.wrongs.length }));
  console.log('   错题示例：' + (r2.wrongs[0] ? (r2.wrongs[0].question.slice(0, 30) + '… → 正确：' + r2.wrongs[0].correct) : '无'));

  /* 6. 单人成绩查询 */
  const one = await (await fetch(BASE + '/api/session/' + s.sid + '/result')).json();
  console.log('✅ 查成绩 →', j({ done: one.done, name: one.name, code: one.code }));

  /* 7. 管理接口 */
  const bad = await fetch(BASE + '/api/list?token=wrong');
  console.log((bad.status === 403 ? '✅ token 错误被拒绝（403）' : '⚠ token 校验有问题，状态码 ' + bad.status));
  const stats = await (await fetch(BASE + '/api/stats?token=' + TOKEN)).json();
  console.log('✅ /api/stats →', j(stats));
  const list = await (await fetch(BASE + '/api/list?token=' + TOKEN)).json();
  console.log('✅ /api/list → 共 ' + list.count + ' 条，最近一条：' + j(list.list[0]));

  /* 8. WebSocket（OneBot 反向 WS） */
  if (typeof WebSocket !== 'undefined') {
    await new Promise(function (resolve) {
      const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
      const t = setTimeout(function () { console.log('⚠ WS 连接超时'); try { ws.close(); } catch (e) {} resolve(); }, 4000);
      ws.onopen = function () {
        console.log('✅ WebSocket 握手成功');
        /* 模拟一条群消息「答题」 */
        ws.send(JSON.stringify({
          post_type: 'message', message_type: 'group', group_id: 123456, user_id: 10003,
          raw_message: '答题', sender: { nickname: '群里的小伙伴' },
        }));
        setTimeout(function () { clearTimeout(t); ws.close(); resolve(); }, 1500);
      };
      ws.onmessage = function (e) {
        let d; try { d = JSON.parse(e.data); } catch (err) { return; }
        if (d.action === 'send_group_msg') {
          console.log('✅ 收到下发的发消息指令 →');
          console.log('   ' + String(d.params.message).split('\n').join('\n   '));
        }
      };
      ws.onerror = function () { clearTimeout(t); console.log('⚠ WS 连接出错'); resolve(); };
    });
  }

  console.log('\n══════ 接口自测完成 ══════');
  process.exit(0);
})().catch(function (e) { console.error('❌ 测试异常：', e); process.exit(1); });
