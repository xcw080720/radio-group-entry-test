# 群规测验系统 · 对接文档

> **版本** v1.0 ｜ **更新** 2026-09-17
> **适用对象**：需要把测验接入 QQ 机器人、或自行部署这套系统的人
> **取代**：早期简版说明（已合并进本文档）

---

## 0. 三十秒上手

```bash
cd group-rules-quiz\服务端
node server.js
```

看到下面这行就成了：

```
群规测验服务已启动
本地：    http://127.0.0.1:8788
答题页：  http://127.0.0.1:8788/quiz
题库：    40 题，每次随机抽 10 题
```

浏览器打开 `http://127.0.0.1:8788/quiz` 就能答题。

**不需要 `npm install`** —— 整个服务端只用 Node 内置模块。要求 Node 18+。

---

## 1. 系统组成

```
group-rules-quiz/
├── 群规问卷.html              ← 答题页（外链图片版，85 KB）
├── 群规问卷-单文件版.html      ← 答题页（图片 base64 内嵌，229 KB，发群里用这个）
├── 题库.json                  ← 40 道题的题库池
├── 抽题器.js                  ← 随机抽题 + 判分（服务端与命令行共用同一份逻辑）
├── 导出题库.js                ← 从 HTML 抽题库到 JSON
├── 校验题库.js                ← 题库数据体检
├── 生成校对清单.js            ← 自动生成 Markdown 校对清单
├── 进度快照.md                ← 项目现状/决策/踩坑
├── 说明-接QQbot.md            ← （本文件）
├── 素材/                      ← 图片素材（蔡徐坤挡板、科比头像、篮球、砖块）
└── 服务端/
    ├── server.js              ← 主服务（HTTP + WebSocket，零依赖）
    ├── ws.js                  ← 手写的最小 WebSocket 服务端
    ├── config.json            ← 配置
    └── results.jsonl          ← 交卷记录，一行一条（自动生成）
```

---

## 2. 数据流

```
   ┌──────────┐
   │ 群员发   │   「答题」
   │  消息    │
   └────┬─────┘
        │  ① 事件上报（WS 或 HTTP）
        ▼
   ┌─────────────────────────────┐
   │  群规测验服务 :8788          │
   │                             │
   │  ② 随机抽 10 题 → 建会话     │
   │  ③ 回一条带链接的消息        │
   └──────────┬──────────────────┘
              │ 链接：/quiz?sid=xxxxxxxx
              ▼
   ┌─────────────────────────────┐
   │  群员在手机浏览器答题         │
   │  GET  /api/session/:sid     │  拉题（不含答案）
   │  POST /api/session/:sid/submit  交卷
   └──────────┬──────────────────┘
              │
              ▼
   ┌─────────────────────────────┐
   │  ④ 判分 + 写 results.jsonl   │
   │  ⑤ 成绩回发到群             │
   └─────────────────────────────┘
```

---

## 3. 接口规范

所有接口都在 `http://<host>:<port>` 下，返回 JSON（UTF-8），已开 CORS。

### 3.1 创建答题会话

```http
POST /api/session
Content-Type: application/json
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `uid` | string | 否 | 用户唯一标识（QQ 号）。**填了的话 10 分钟内重复触发会复用同一份卷子**，防止刷题 |
| `name` | string | 否 | 昵称，会预填到答题页的输入框 |
| `groupId` | string | 否 | 群号，交卷后会往这个群发成绩 |
| `count` | number | 否 | 抽几题，默认读配置里的 `drawCount` |

**响应**

```json
{
  "ok": true,
  "sid": "35907001eba687cf",
  "url": "http://127.0.0.1:8788/quiz?sid=35907001eba687cf",
  "count": 10,
  "passScore": 60,
  "corePassRate": 0
}
```

> `sid` 是 16 位十六进制，会话有效期 **2 小时**。

---

### 3.2 取题

```http
GET /api/session/:sid
```

**响应（未交卷）**

```json
{
  "ok": true,
  "sid": "35907001eba687cf",
  "name": "张三",
  "count": 10,
  "passScore": 60,
  "corePassRate": 0,
  "questions": [
    {
      "type": "case",
      "sec": "呼号",
      "core": true,
      "q": "【案例】某成员把群昵称里的呼号写成了「BG2XYZ」……",
      "options": [
        "严重违规 —— 移出群聊并加入群黑名单",
        "无违规，属于正常交流",
        "轻微违规 —— 撤回消息并禁言 1 天"
      ]
    }
  ]
}
```

> ⚠️ **这个接口不会返回答案**（`answer` / `accept` / `explain` 都被剥掉了），前端拿不到正确答案，所以服务端模式无法作前即时判分 —— 这是正常的。
> 选项顺序**已经打乱**，前端不应再打乱一次。

**响应（已交卷）**

```json
{
  "ok": true,
  "sid": "…",
  "done": true,
  "name": "张三",
  "code": "1RZH-OPX1",
  "passScore": 60,
  "corePassRate": 0,
  "result": { "score": 100, "passed": true, "right": 10, "total": 10, "wrongs": [], "…": "…" }
}
```

---

### 3.3 交卷

```http
POST /api/session/:sid/submit
Content-Type: application/json
```

**请求体**

```json
{
  "answers": [ [1], [0,2], ["疑罪从无"], [] ]
}
```

- 数组长度 = 题目数，**顺序与题目一一对应**
- 单选 / 判断 / 案例题：`[选项下标]`
- 多选：`[下标, 下标, …]`（**全对才算对**，漏选多选都算错）
- 填词题：`["填的内容"]`（去空格与标点后比对，大小写不敏感）
- 未作答：`[]`

**响应**

```json
{
  "ok": true,
  "score": 60,
  "passed": true,
  "right": 6,
  "total": 10,
  "coreRight": 6,
  "coreTotal": 10,
  "coreRate": 0.6,
  "blank": 0,
  "code": "1VA1-OEB1",
  "passScore": 60,
  "corePassRate": 0,
  "wrongs": [
    {
      "index": 2,
      "sec": "内容载体",
      "type": "case",
      "question": "【案例】某成员发了段录音，录音里他在骂另一位群友。",
      "yours": "无违规，属于正常交流",
      "correct": "轻微违规 —— 撤回消息并禁言 1 天",
      "explain": "轻微违规。骂人不分形式，录音里的骂也是骂。……依据：群规〈群成员的违规〉。"
    }
  ]
}
```

> **重复交卷会被拒绝**，返回 `{"ok":true,"already":true,…}` 并带上原成绩。

---

### 3.4 查单人成绩

```http
GET /api/session/:sid/result
```

```json
{ "ok": true, "done": true, "sid": "…", "name": "张三", "uid": "10001",
  "code": "1RZH-OPX1", "submittedAt": 1789655441350, "result": { "…": "…" } }
```

未交卷时返回 `{"ok":true,"done":false}`。

---

### 3.5 管理接口

需要带 `token`（即 `config.json` 里的 `adminToken`），**token 不对返回 403**。

```http
GET /api/stats?token=你的adminToken
```
```json
{ "ok": true, "total": 2, "passed": 1, "failed": 1, "passRate": "50%",
  "avgScore": 50, "poolSize": 40, "drawCount": 10, "activeSessions": 2 }
```

```http
GET /api/list?token=你的adminToken          # 全部提交记录
GET /api/list?token=你的adminToken&fail=1   # 只看没通过的
```
```json
{ "ok": true, "count": 2, "list": [
  { "sid": "…", "uid": "10002", "name": "反面教材", "groupId": "123456",
    "code": "16UT-GU0S", "score": 0, "passed": false, "right": 0, "total": 10,
    "coreRight": 0, "coreTotal": 10, "submittedAt": 1789655441350 }
] }
```

> 记录持久化在 `服务端/results.jsonl`，一行一条 JSON，可直接用脚本/Excel 处理。

---

### 3.6 健康检查

```http
GET /health
```
```json
{ "ok": true, "service": "group-rules-quiz", "version": "1.0",
  "pool": 40, "sessions": 2, "wsClients": 0, "uptime": "74s" }
```

---

## 4. 接 QQ 机器人

服务端**同时支持三种接法**，任选其一即可；WebSocket 优先于 HTTP。

### 4.1 方式 A：反向 WebSocket（推荐）

在 OneBot v11 协议端（**NapCat / Lagrange / go-cqhttp** 等）里找到「反向 WebSocket」配置，填：

```
ws://<本机IP>:8788/ws
```

（别名 `/onebot` 也支持。协议端在同一台机器就用 `ws://127.0.0.1:8788/ws`）

连上后服务端会打印：

```
🔌 OneBot 已连接（当前 1 个）
```

**优点**：机器人主动连过来，结果通知直接复用这条连接下发，不用额外配 HTTP API 地址。

---

### 4.2 方式 B：HTTP 上报

协议端 → 「HTTP 上报 / 事件上报」→ 填：

```
http://<本机IP>:8788/webhook/qq
```

这种方式下服务端**无法主动推消息**，需要再配 `config.json` 里的 `bot.httpApi`：

```json
"httpApi": "http://127.0.0.1:3000"
```

（OneBot 的 HTTP API 地址；有 `access_token` 就一并填 `bot.accessToken`）

---

### 4.3 方式 C：自己写 bot

直接调 §3 的 HTTP 接口即可，不依赖任何协议端特性：

```js
// 伪代码
const s = await fetch('http://127.0.0.1:8788/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ uid: qq, name: nick, groupId: gid })
}).then(r => r.json());

await sendGroupMsg(gid, '点这里答题：' + s.url);
```

---

### 4.4 事件与消息格式（OneBot v11）

**上行事件**（协议端 → 服务端）

```json
{
  "post_type": "message",
  "message_type": "group",
  "group_id": 123456,
  "user_id": 10003,
  "raw_message": "答题",
  "sender": { "nickname": "群友", "card": "群名片" }
}
```

服务端只处理 `post_type === "message"` 且 `raw_message` **命中触发词**的事件；
`meta_event`（心跳）和 `notice` 一律忽略。

**下行指令**（服务端 → 协议端）

```json
{ "action": "send_group_msg", "params": { "group_id": 123456, "message": "……" }, "echo": "srv1" }
```

---

### 4.5 配上之后会发生什么

1. 群员在群里发「**答题**」（或「群规」「考试」「quiz」）
2. 机器人自动回复：

```
📝 群规准入测验

共 10 题，答对 6 题以上算通过。
点击链接开始：http://你的域名/quiz?sid=xxxxxxxx
（链接 2 小时内有效）
```

3. 群员点开答题、交卷
4. 服务端把成绩**回发到该群**（或你指定的通知群）：

```
【群规测验·提交】
昵称：张三
QQ：10003
成绩：60 分（答对 6/10）
必答区：6/10（60%）
结果：✅ 通过
凭证码：1VA1-OEB1
时间：2026/9/17 23:11:14
```

**想让不合格的单独进管理群？** 在 `config.json` 设 `bot.notifyGroupId`；
**想再推一份到别处**（企微/飞书/自建服务）？设 `bot.callbackUrl`，服务端会 POST：

```json
{ "type": "quiz_result", "nickname": "张三", "uid": "10003",
  "groupId": "123456", "code": "1VA1-OEB1", "submittedAt": 1789655441350,
  "result": { "…": "…" } }
```

---

## 5. 数据结构

### 5.1 题库格式（`题库.json`）

```json
[
  {
    "sec": "呼号",
    "core": true,
    "type": "case",
    "q": "【案例】某成员把群昵称里的呼号写成了「BG2XYZ」……",
    "options": [
      "无违规，属于正常交流",
      "轻微违规 —— 撤回消息并禁言 1 天",
      "严重违规 —— 移出群聊并加入群黑名单"
    ],
    "answer": [2],
    "explain": "严重违规。……依据：群规〈群成员的违规〉。"
  }
]
```

| 字段 | 说明 |
|---|---|
| `sec` | 章节（答题卡与统计用） |
| `core` | `true` = 必答区（计入核心正确率）；`false` = 非必答 |
| `type` | `case` 案例 / `single` 单选 / `multi` 多选 / `judge` 判断 / `fill` 填词 |
| `q` | 题干 |
| `options` | 选项数组（`fill` 类型没有这个字段） |
| `answer` | **正确选项下标**，从 0 开始；多选可多个 |
| `accept` | 仅 `fill` 用：可接受的答案写法数组，第一个用于展示 |
| `explain` | 解析，答错时展示 |

### 5.2 抽题配额（`抽题器.js` 顶部）

```js
const DEFAULT_QUOTA = { case: 10 };   // 当前题库全是 case 题
```

某类题不够时会用其他题型补足，总数始终等于 `drawCount`。

### 5.3 成绩记录（`服务端/results.jsonl`）

```json
{"sid":"2e656cdc4c446bd0","uid":"10002","name":"反面教材","groupId":"",
 "code":"16UT-GU0S","score":0,"passed":false,"right":0,"total":10,
 "coreRight":0,"coreTotal":10,"submittedAt":1789655441350}
```

---

## 6. 配置说明（`服务端/config.json`）

改完**必须重启服务**才生效。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `port` | 8788 | 端口 |
| `host` | 0.0.0.0 | 监听地址 |
| `publicUrl` | `http://127.0.0.1:8788` | **重要**：发给群员的链接前缀。本机测就填 127.0.0.1，上线要填公网域名/IP |
| `drawCount` | 10 | 每次抽几题 |
| `passScore` | 60 | 总分及格线 |
| `corePassRate` | **0** | 必答区正确率下限；**0 = 不启用这道门槛**（当前就是关掉的） |
| `adminToken` | change-me-please | 管理接口的钥匙，**务必改掉** |
| `bot.enabled` | true | 是否启用机器人联动 |
| `bot.triggerKeywords` | `["答题","群规","考试","quiz"]` | 群里发哪些词触发 |
| `bot.httpApi` | 空 | OneBot HTTP API 地址（用反向 WS 时可不填） |
| `bot.accessToken` | 空 | OneBot 的 access_token |
| `bot.notifyGroupId` | 空 | 成绩发到哪个群（留空则回原群） |
| `bot.callbackUrl` | 空 | 额外的结果推送地址 |

---

## 7. 前端两个版本

| 文件 | 大小 | 用法 |
|---|---|---|
| `群规问卷-单文件版.html` | **229 KB** | **发群里用这个** —— 图片已 base64 内嵌，单独一个文件就完整 |
| `群规问卷.html` | 85 KB | 开发用 —— 引用 `素材/` 目录里的图片，改起来方便 |

两者**功能完全一样**，只是图片的引用方式不同。

**前端行为**：
- URL 带 `?sid=xxx` → **服务端模式**：从接口拉题，交卷提交给服务端
- URL 不带参数 → **本地模式**：从文件内自带的题库随机抽题，本地判分（适合完全离线的场景）

---

## 8. 部署

### 有公网服务器
```bash
# 把整个 group-rules-quiz 目录传上去
cd group-rules-quiz/服务端
node server.js          # 或用 pm2 / screen 常驻
```
把 `publicUrl` 改成公网地址；想走 80 端口就用 Nginx 反代到 8788。

### 只有本机
用内网穿透（frp / cloudflared / 花生壳）把 8788 暴露成公网地址，
再把 `publicUrl` 改成那个地址。

### 长期挂着（Windows）
用 `nssm` 注册成系统服务，或放进任务计划程序开机自启。

---

## 9. 判分规则（前后端一致）

| 题型 | 判定 |
|---|---|
| 单选 / 判断 / 案例 | 所选下标与 `answer` **完全一致** |
| 多选 | **全对才算对**，漏选、多选都算错 |
| 填词 | 去掉空格与标点后**完全相等**（大小写不敏感） |

**通过条件**：`总分 ≥ passScore` **且** `必答区正确率 ≥ corePassRate`
（`corePassRate = 0` 时等于只看总分）

---

## 10. 常见问题

**Q：群员点链接打不开？**
`publicUrl` 必须是**群员能访问到的地址**。`127.0.0.1` 只有本机能开。

**Q：同一人点两次「答题」会给两份卷子吗？**
不会。同 `uid` 在 10 分钟内重复触发会**复用同一份未交卷的卷子**。

**Q：会话有效期？**
2 小时。超时后链接失效，需要重新发起。

**Q：改了题目怎么办？**
1. 编辑 `群规问卷.html` 里的题库区（搜「② 题库区」）
2. 跑 `node 导出题库.js` 更新 `题库.json`
3. **重启服务**（服务启动时读一次题库）
4. 如果用的是单文件版，重跑一遍内嵌脚本

**Q：端口被占用？**
改 `config.json` 的 `port`。

**Q：想改成纯随机抽题（不管题型）？**
编辑 `抽题器.js` 顶部的 `DEFAULT_QUOTA`，把配额都改成 0。

**Q：前端拿不到答案，怎么在答题时给即时反馈？**
只有**本地模式**能即时判分（答案在文件里）。
服务端模式为了防作弊，答案不下发，所以答完统一在结果页给反馈。

---

## 11. 改题库的完整流程

```bash
# 1. 改题：编辑 群规问卷.html，搜「② 题库区」
# 2. 体检
node 校验题库.js
# 3. 导出给服务端用
node 导出题库.js
# 4. 重新生成校对清单（可选）
node 生成校对清单.js
# 5. 重启服务
```

---

*文档结束。有问题就找汐 🐋*
