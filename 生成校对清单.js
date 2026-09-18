/* 从「群规问卷.html」的题库自动生成 Markdown 校对清单
   用法：node 生成校对清单.js
   改完题目后跑一次，清单自动同步，不用手工维护。 */
const fs = require('fs');
const DIR = 'C:/Users/辰苇/group-rules-quiz/';
const html = fs.readFileSync(DIR + '群规问卷.html', 'utf8');

const m = html.match(/const QUESTIONS = (\[[\s\S]*?\n\]);/);
if (!m) { console.log('❌ 未找到 QUESTIONS 数组'); process.exit(1); }
const Q = eval(m[1]);
const vm = html.match(/rulesVersion\s*:\s*"([^"]+)"/);
const ver = vm ? vm[1] : '（未标注）';

const TL = { single: '单选', multi: '多选', judge: '判断', fill: '挖空填词', scene: '情景运用', case: '案例判定' };
const coreN = Q.filter(function (q) { return q.core !== false; }).length;

const out = [];
out.push('# 群规准入测验 —— 题目校对清单');
out.push('');
out.push('> **题库依据**：' + ver);
out.push('> **题目总数**：' + Q.length + ' 题（必答区 ' + coreN + ' 题 / 情景运用区 ' + (Q.length - coreN) + ' 题）');
out.push('> **及格条件**：总分 ≥ 60 且必答区正确率 ≥ 90%');
out.push('> **校对方式**：在每题下方的「校对」处批注，或直接告诉汐改哪一题。');
out.push('');
out.push('---');
out.push('');

Q.forEach(function (q, i) {
  const n = String(i + 1).padStart(2, '0');
  out.push('### 第 ' + n + ' 题 ｜ ' + TL[q.type] + ' ｜ ' + q.sec + (q.core === false ? '（非必答）' : ''));
  out.push('');
  out.push('**题干**：' + q.q);
  out.push('');
  if (q.type === 'fill') {
    out.push('**✅ 正确填词**：`' + q.accept[0] + '`'
      + (q.accept.length > 1 ? '（也接受：' + q.accept.slice(1).map(function (a) { return '`' + a + '`'; }).join('、') + '）' : ''));
  } else {
    q.options.forEach(function (o, k) {
      out.push('- ' + String.fromCharCode(65 + k) + '. ' + o + (q.answer.indexOf(k) !== -1 ? '　**← 正确**' : ''));
    });
    out.push('');
    out.push('**✅ 正确答案**：' + q.answer.map(function (a) { return String.fromCharCode(65 + a); }).join(' '));
  }
  out.push('');
  out.push('**解析**：' + q.explain);
  out.push('');
  out.push('`校对： ☐ 同意　☐ 改：`');
  out.push('');
  out.push('---');
  out.push('');
});

out.push('## 统计');
out.push('');
const tc = {};
Q.forEach(function (q) { tc[q.type] = (tc[q.type] || 0) + 1; });
out.push('**题型**：' + Object.keys(tc).map(function (k) { return TL[k] + ' ' + tc[k]; }).join(' · '));
out.push('');
const sc = {};
Q.forEach(function (q) { sc[q.sec] = (sc[q.sec] || 0) + 1; });
out.push('**章节**：' + Object.keys(sc).map(function (k) { return k + ' ' + sc[k]; }).join(' · '));
out.push('');

fs.writeFileSync(DIR + '题目校对清单.md', out.join('\n'), 'utf8');
console.log('✅ 已生成「题目校对清单.md」，共 ' + Q.length + ' 题');
