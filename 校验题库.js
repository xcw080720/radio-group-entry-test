/* 题库数据校验：只读，跑完即删 */
const fs = require('fs');
const p = 'C:/Users/辰苇/group-rules-quiz/群规问卷.html';
const html = fs.readFileSync(p, 'utf8');
const m = html.match(/const QUESTIONS = (\[[\s\S]*?\n\]);/);
if (!m) { console.log('❌ 未找到 QUESTIONS 数组'); process.exit(1); }
let Q;
try { Q = eval(m[1]); } catch (e) { console.log('❌ 解析失败: ' + e.message); process.exit(1); }

console.log('题目总数: ' + Q.length);
let bad = 0;
const tc = {};

Q.forEach(function (q, i) {
  const n = i + 1;
  const e = [];
  const t = q.type;
  tc[t] = (tc[t] || 0) + 1;
  if (['single', 'multi', 'judge', 'fill', 'scene', 'case'].indexOf(t) === -1) e.push('type 非法:' + t);
  if (!q.sec) e.push('缺 sec 章节');
  if (!q.q || !q.q.trim()) e.push('题干为空');
  if (!q.explain || q.explain.indexOf('依据') === -1) e.push('解析缺失或未标依据');

  if (t === 'fill') {
    if (!Array.isArray(q.accept) || q.accept.length === 0) e.push('fill 未设 accept');
    else if (q.accept.some(function (a) { return !a || !String(a).trim(); })) e.push('fill 的 accept 含空值');
    if (q.q.indexOf('____') === -1) e.push('fill 题干缺挖空标记 ____');
    if (q.options) e.push('fill 不应带 options');
  } else {
    if (!Array.isArray(q.options) || q.options.length < 2) e.push('选项不足 2 个');
    const seen = {};
    (q.options || []).forEach(function (o) { if (seen[o]) e.push('选项重复:' + o); seen[o] = 1; });
    if (!Array.isArray(q.answer) || q.answer.length === 0) e.push('未设正确答案');
    (q.answer || []).forEach(function (a) {
      if (typeof a !== 'number' || a < 0 || a >= q.options.length) e.push('答案越界:' + a);
    });
    if ((t === 'single' || t === 'judge' || t === 'scene') && q.answer.length !== 1) e.push(t + ' 答案数=' + q.answer.length + '（应为1）');
    if (t === 'multi' && q.answer.length < 2) e.push('多选答案只给了 ' + q.answer.length + ' 个');
    if (t === 'judge' && (q.options.length !== 2 || q.options[0] !== '正确' || q.options[1] !== '错误')) e.push('判断题选项须为[正确,错误]');
    if (t === 'scene' && q.q.indexOf('【情景】') === -1 && q.q.indexOf('【真实案例】') === -1) e.push('scene 题干缺【情景】/【真实案例】标记');
  }

  if (e.length) bad++;
  const ans = (t === 'fill') ? (q.accept ? q.accept[0] : '') : (q.answer || []).map(function (a) { return String.fromCharCode(65 + a); }).join('');
  console.log((e.length ? '❌' : '✅') + ' ' + String(n).padStart(2, '0') + ' [' + t + '] ' + q.sec + '  答案=' + ans + (e.length ? '   ⚠ ' + e.join('; ') : ''));
});

const core = Q.filter(function (q) { return q.core !== false; });
const need = Math.ceil(Q.length * 60 / 100);
const cpr = parseFloat((html.match(/corePassRate\s*:\s*([0-9.]+)/) || [0, 0])[1]);
const coreNeed = Math.ceil(core.length * cpr);
console.log('');
console.log('题型分布: ' + Object.keys(tc).map(function (k) { return k + ' ' + tc[k]; }).join(' / '));
console.log('必答区: ' + core.length + ' 题；情境区: ' + (Q.length - core.length) + ' 题');
console.log('及格条件: 总分 ≥ 60（需答对 ' + need + '/' + Q.length + '）' + (cpr > 0 ? (' + 必答区 ≥ ' + Math.round(cpr*100) + '%（需答对 ' + coreNeed + '/' + core.length + '）') : ' · 未启用必答区门槛'));
console.log(bad === 0 ? '✅ 题库校验全部通过' : '⚠️ ' + bad + ' 题存在数据问题');
