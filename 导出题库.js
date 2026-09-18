/* 导出题库：把 群规问卷.html 里的题库抽成独立的 题库.json
   用法：node 导出题库.js
   以后改题 → 跑这个 → 题库.json 同步更新，服务端自动用新版。 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const html = fs.readFileSync(path.join(DIR, '群规问卷.html'), 'utf8');
const m = html.match(/const QUESTIONS = (\[[\s\S]*?\n\]);/);
if (!m) { console.error('❌ 在 群规问卷.html 里找不到 QUESTIONS 数组'); process.exit(1); }

let Q;
try { Q = eval(m[1]); } catch (e) { console.error('❌ 题库解析失败：' + e.message); process.exit(1); }

/* 基本体检 */
const problems = [];
Q.forEach(function (q, i) {
  const n = i + 1;
  if (!q.q || !q.type) return problems.push('第' + n + '题缺题干或类型');
  if (q.type === 'fill') {
    if (!Array.isArray(q.accept) || !q.accept.length) problems.push('第' + n + '题（填词）缺 accept');
  } else {
    if (!Array.isArray(q.options) || q.options.length < 2) problems.push('第' + n + '题选项不足');
    if (!Array.isArray(q.answer) || !q.answer.length) problems.push('第' + n + '题缺答案');
  }
});
if (problems.length) { console.error('❌ 题库有问题：\n  ' + problems.join('\n  ')); process.exit(1); }

const out = path.join(DIR, '题库.json');
fs.writeFileSync(out, JSON.stringify(Q, null, 2), 'utf8');

const tc = {};
Q.forEach(function (q) { tc[q.type] = (tc[q.type] || 0) + 1; });
console.log('✅ 已导出 题库.json');
console.log('   题目总数：' + Q.length);
console.log('   题型分布：' + Object.keys(tc).map(function (k) { return k + ' ' + tc[k]; }).join(' / '));
console.log('   必答区：' + Q.filter(function (q) { return q.core !== false; }).length + ' 题');
