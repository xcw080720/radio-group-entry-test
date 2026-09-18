/* ================================================================
   抽题器 —— 从题库里随机抽题，生成一份「试卷」
   ----------------------------------------------------------------
   用途：H5 问卷、QQ bot、命令行都调用这一份逻辑，保证判分口径一致。

   CLI 用法：
     node 抽题器.js            # 默认抽 10 题
     node 抽题器.js 20         # 抽 20 题
     node 抽题器.js 10 --json  # 输出 JSON（给别的程序用）
   ================================================================ */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

/* 默认题型配额（总和 = 抽题数）。改这里就能调整每次考试的题型结构。 */
/* 第二代题库全是 case（案例三档判定）题，所以配额就是 case */
const DEFAULT_QUOTA = { case: 10 };

function shuffle(a0) {
  const a = a0.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function loadPool(file) {
  return JSON.parse(fs.readFileSync(file || path.join(DIR, '题库.json'), 'utf8'));
}

/* 按题型配额抽题；某类不够时用其他题补足 */
function drawQuestions(pool, count, quota) {
  const q = quota || DEFAULT_QUOTA;
  const picked = [];
  const used = {};

  Object.keys(q).forEach(function (type) {
    const group = pool.filter(function (x) { return x.type === type; });
    shuffle(group).slice(0, q[type]).forEach(function (x) {
      if (!used[x.q]) { used[x.q] = 1; picked.push(x); }
    });
  });

  if (picked.length < count) {
    shuffle(pool).forEach(function (x) {
      if (picked.length < count && !used[x.q]) { used[x.q] = 1; picked.push(x); }
    });
  }
  return shuffle(picked).slice(0, count);
}

/* 把一道题random化：选项打乱，并算出正确项的新位置 */
function prepareQuestion(src) {
  if (src.type === 'fill') {
    return { type: 'fill', sec: src.sec, core: src.core !== false, q: src.q, accept: src.accept.slice(), explain: src.explain || '' };
  }
  const opts = src.options.map(function (t, i) { return { t: t, c: src.answer.indexOf(i) !== -1 }; });
  const sh = shuffle(opts);
  const answer = [];
  sh.forEach(function (o, i) { if (o.c) answer.push(i); });
  return {
    type: src.type, sec: src.sec, core: src.core !== false,
    q: src.q, options: sh.map(function (o) { return o.t; }), answer: answer,
    explain: src.explain || '',
  };
}

/* 生成整份试卷 */
function buildPaper(pool, count, quota) {
  return drawQuestions(pool, count, quota).map(prepareQuestion);
}

/* 判分：answers[i] 为所选下标数组；fill 题为 [输入文本] */
function grade(paper, answers) {
  let right = 0, coreRight = 0, coreTotal = 0, blank = 0;
  const wrongs = [];
  paper.forEach(function (q, i) {
    const a = answers[i] === undefined || answers[i] === null ? [] : answers[i];
    if (q.core) coreTotal++;
    let ok;
    if (q.type === 'fill') {
      const txt = String(a[0] === undefined ? '' : a[0]).trim();
      if (!txt) blank++;
      ok = matchFill(txt, q.accept);
    } else {
      if (!a.length) blank++;
      const mine = a.slice().sort().join(',');
      const std = q.answer.slice().sort().join(',');
      ok = (mine !== '' && mine === std);
    }
    if (ok) { right++; if (q.core) coreRight++; }
    else wrongs.push({
      index: i, sec: q.sec, type: q.type, question: q.q,
      yours: q.type === 'fill' ? (String(a[0] || '').trim() || '（未作答）') : a.map(function (k) { return q.options[k] || ''; }).join(' / '),
      correct: q.type === 'fill' ? q.accept[0] : q.answer.map(function (k) { return q.options[k] || ''; }).join(' / '),
      explain: q.explain || '',
    });
  });
  const total = paper.length;
  const score = Math.round(right / total * 100);
  return {
    score: score, right: right, total: total, wrongs: wrongs, blank: blank,
    coreRight: coreRight, coreTotal: coreTotal,
    coreRate: coreTotal ? coreRight / coreTotal : 1,
  };
}

/* 填词判分：去空格与标点后完全相等 */
function normFill(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\s+/g, '')
    .replace(/[，。、；：""''「」『』（）()【】\[\]《》〈〉!！?？.,;:~·\-—_]/g, '').toUpperCase();
}
function matchFill(raw, accept) {
  const u = normFill(raw);
  if (!u) return false;
  for (let i = 0; i < (accept || []).length; i++) { if (u === normFill(accept[i])) return true; }
  return false;
}

module.exports = {
  DEFAULT_QUOTA: DEFAULT_QUOTA, shuffle: shuffle, loadPool: loadPool,
  drawQuestions: drawQuestions, prepareQuestion: prepareQuestion,
  buildPaper: buildPaper, grade: grade, matchFill: matchFill, normFill: normFill,
};

/* ---------------- CLI ---------------- */
if (require.main === module) {
  const args = process.argv.slice(2);
  const n = parseInt(args[0] || '10', 10);
  const asJson = args.indexOf('--json') !== -1;
  const pool = loadPool();
  const paper = buildPaper(pool, n);

  if (asJson) {
    console.log(JSON.stringify(paper, null, 2));
  } else {
    console.log('══════ 随机抽出 ' + paper.length + ' 题 ══════');
    paper.forEach(function (q, i) {
      console.log('\n' + (i + 1) + '. [' + q.type + ' | ' + q.sec + '] ' + q.q);
      if (q.type === 'fill') {
        console.log('   （填词题）参考答案：' + q.accept[0]);
      } else {
        q.options.forEach(function (o, k) {
          console.log('   ' + String.fromCharCode(65 + k) + '. ' + o + (q.answer.indexOf(k) !== -1 ? '   ← 正确' : ''));
        });
      }
    });
    const tc = {};
    paper.forEach(function (q) { tc[q.type] = (tc[q.type] || 0) + 1; });
    console.log('\n题型分布：' + Object.keys(tc).map(function (k) { return k + ' ' + tc[k]; }).join(' / '));
    console.log('（题库池共 ' + pool.length + ' 题，每次抽取均随机）');
  }
}
