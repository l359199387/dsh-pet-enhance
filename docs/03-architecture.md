# 03 · 架构与实现方案

## 1. 全景

```
┌──────────────────────── 浏览器（DSH 页面同源） ────────────────────────┐
│  Client 半  dsh-pet-enhance/client.js                                      │
│   ├─ shell.overlay：宠物（SVG）+ 气泡 + 输入框 + ⏹急停                │
│   ├─ settings.section：档位 / 宠物大小 / 动作开关 / 隐私规则           │
│   └─ fetch('/api/pet-enhance/…')  ← 同源 + 一次性令牌                       │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ loopback HTTP
┌──────────────────────────────▼────────────────────────────────────────┐
│  Host 半  dsh-pet-enhance/index.js                                         │
│   ├─ ctx.tools.register(glance)  看                                    │
│   ├─ ctx.tools.register(act)     动（重权限，默认关闭）                │
│   ├─ ctx.tools.register(pet)     演 / 问                               │
│   ├─ ctx.tools.register(remember/recall)  记 / 想（见 09）             │
│   ├─ 策略引擎 policy.js：分级、白名单、两步确认、急停、审计            │
│   ├─ memory/：profile + episodes + skills 索引（见 09）                │
│   ├─ ctx.webServer.register(…)   /api/pet-enhance/*                         │
│   ├─ ctx.attachments.saveImage   PNG → ImageBlock                      │
│   └─ 子进程管理：sidecar 生命周期、重启退避、退出清理                  │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ stdio JSON Lines（UTF-8）
┌──────────────────────────────▼────────────────────────────────────────┐
│  Sidecar  sidecar/glance.py                                           │
│   ├─ capture：Pillow 整屏 / PrintWindow 单窗口（DWM 边界）             │
│   ├─ input：SendInput 鼠标 + 键盘（同一个 DPI 上下文）                 │
│   ├─ diff：64×36 网格变化分                                           │
│   └─ thumb：320px JPEG（只给卡片，不进模型）                            │
└───────────────────────────────────────────────────────────────────────┘
```

三条硬边界：

- **Host 不碰像素、不碰坐标换算**（除了画布缩放）。它只编排与判断。
- **Sidecar 不做判断**。它只执行「抓这一块」「在这个坐标点一下」，不解释意图。
- **Client 不直接驱动 Sidecar**。所有动作必须经过 Host 的策略引擎。

## 2. 为什么 Sidecar 必须同时管抓屏和输入

**【实测】** 输入注入的坐标依赖进程的 DPI 感知级别（见 `01-research.md` §4.4）。如果抓屏和输入在两个不同进程、不同 DPI 上下文里，「截图上的 (x,y)」和「鼠标点到的 (x,y)」会对不上。

所以：

| 进程 | 职责 | 必须共享 |
|---|---|---|
| 同一个 sidecar | 抓屏 + 输入 | DPI 感知、屏幕尺寸、虚拟桌面原点 |

## 3. Sidecar 协议

一行一个 JSON，请求带 `id`，响应回同一个 `id`，UTF-8。

### 3.1 Host → Sidecar

```jsonc
{"id":1,"op":"hello"}
{"id":2,"op":"capture","source":{"kind":"screen"}}
{"id":3,"op":"capture","source":{"kind":"window","match":"PyCharm"}}
{"id":4,"op":"capture","source":{"kind":"screen","region":{"x":0,"y":0,"w":800,"h":450}}}
{"id":5,"op":"thumb","width":320}
{"id":6,"op":"windows"}
{"id":7,"op":"input","actions":[
   {"kind":"move","x":800,"y":450,"duration":180},
   {"kind":"click","button":"left"},
   {"kind":"type","text":"hello"},
   {"kind":"key","keys":"ctrl+s"}
 ]}
{"id":8,"op":"abort"}          // 急停：清空队列、放弃剩余动作
{"id":9,"op":"stats"}
{"id":10,"op":"quit"}
```

### 3.2 Sidecar → Host

```jsonc
{"id":1,"ok":true,"version":"0.1.0","screen":{"w":2560,"h":1440,"dpi":1.0},"engine":"pillow","input":true}
{"id":2,"ok":true,"png":"<base64>","w":2560,"h":1440,"ms":56,
 "active":{"title":"PyCharm — main.py","hwnd":8842,"rect":[-8,-8,2576,1416]},
 "cursor":{"x":1204,"y":688},"score":0.03}
{"id":6,"ok":true,"windows":[{"hwnd":8842,"title":"PyCharm — main.py","rect":[...],"pid":8842}]}
{"id":7,"ok":true,"done":[{"kind":"move","ms":11},{"kind":"click","ms":3}],
 "aborted":false,"cursor":{"x":800,"y":450}}
{"id":7,"ok":false,"aborted":true,"cause":"failsafe","done":[...]}
{"id":3,"ok":false,"error":{"code":"WINDOW_NOT_FOUND","message":"没有标题匹配 PyCharm 的窗口","candidates":["…"]}}
```

错误码：`NO_PIL` / `WINDOW_NOT_FOUND` / `WINDOW_AMBIGUOUS` / `CAPTURE_FAILED` / `BAD_REQUEST` / `INPUT_BLOCKED` / `FAILSAFE`。

### 3.3 输入动作的语义

| 字段 | 规则 |
|---|---|
| `move` | 坐标为**屏幕物理像素**；`duration` 做线性插值（默认 180ms，人感；纯跳变会触发某些应用的「鼠标瞬移」判定） |
| `click` | 先 `SetCursorPos` 再按下/抬起；`count` 默认 1；双击间隔 45ms |
| `type` | ASCII 逐字符 `KEYEVENTF_UNICODE`；**非 ASCII（中文等）走剪贴板 + Ctrl+V**，并恢复剪贴板原内容 |
| `key` | 组合键解析成按下序列，**逆序释放**（保证修饰键最后松开） |
| `scroll` | `MOUSEEVENTF_WHEEL`，一格 120 |
| `focus` | 先 `ShowWindow(SW_RESTORE)`，再 `SetForegroundWindow`；**失败要报**（前台锁） |

**急停（failsafe）**：每执行一个动作前检查两件事：

1. 光标是否在 `(0,0)` 附近（≤2px）→ 说明用户把鼠标甩到左上角了，立即 `abort`；
2. Host 是否发过 `abort` → 立即 `abort`。

`aborted: true` 时 Host 必须把它当成「用户叫停」，而不是「动作失败重试」。

### 3.4 进程管理

```js
ctx.effect(() => {
  const proc = ctx.subprocess.spawn({
    argv: [pythonPath, sidecarPath],
    cwd: pluginDir,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', control: 'pipe' },
    graceMs: 3000,
  })
  const client = createLineClient(proc)
  // 退出即重建，指数退避 1/2/4/8/16/30s；连续 5 次失败则停并写日志
  return () => client.close()
})
```

- `ctx.subprocess` 是可选服务；不存在时退到「每次 spawn 一次 PowerShell」（只支持抓整屏，不支持窗口与输入）。
- 握手超时 5s。Python 冷启动含 `import PIL` 约 300–600ms。
- **退出时必须 `abort` + `quit` + 等退出**，不能留孤儿进程（M5 验收项）。

## 4. 工具契约

### 4.1 五个工具

前三个的签名如下；`remember` / `recall` 的签名与返回形状见 [09-memory.md](09-memory.md) §9。

```js
ctx.tools.register(defineTool({
  name: 'glance',
  description: GLANCE_DESCRIPTION,
  parameters: {                     // ← 「属性名 → 值 schema」
    action:  { type: 'string', description: 'see(默认) | watch | point | status' },
    window:  { type: 'string', description: '窗口标题的一部分（不区分大小写）' },
    region:  { type: 'string', description: '"x,y,w,h"，屏幕物理像素' },
    quality: { type: 'string', description: 'low(默认) | standard | high' },
    frames:  { type: 'integer', description: '1–8，>1 时拼成网格，token 不变' },
    seconds: { type: 'integer', description: 'watch 最长阻塞秒数，默认 60，上限 600' },
  },
  timeoutMs: 900_000,
  output: { schema: { /* 完整 JSON Schema */ }, render: (a, v) => [...] },
  async execute(args, exec) { … },
}))

ctx.tools.register(defineTool({
  name: 'act',
  description: ACT_DESCRIPTION,
  parameters: {
    action: { type: 'string', description: 'move|click|double_click|right_click|drag|scroll|type|key|focus|wait|screen' },
    x: { type: 'number' }, y: { type: 'number' },
    x2: { type: 'number' }, y2: { type: 'number' },
    text: { type: 'string' }, keys: { type: 'string' },
    window: { type: 'string' }, ms: { type: 'integer' },
    button: { type: 'string', description: 'left(默认) | right | middle' },
    reason: { type: 'string', description: '为什么做这个动作（会进审计和确认界面）' },
  },
  timeoutMs: 120_000,
  output: { schema: { … }, render: (a, v) => [...] },
  async execute(args, exec) { … },   // 走策略引擎
}))

ctx.tools.register(defineTool({
  name: 'pet',
  description: PET_DESCRIPTION,
  parameters: {
    say:  { type: 'string', description: '气泡里说的话（≤80 字）' },
    anim: { type: 'string', description: 'bounce|nod|tilt|work|happy|startle|sleep|wake' },
    ask:  { type: 'string', description: '要用户确认/回答的问题（会渲染成带按钮的气泡）' },
  },
  output: { schema: { … }, render: () => [] },
  async execute(args, exec) { … },   // 写客户端状态 + 可选等待用户回答
}))
```

### 4.2 `act` 的执行管线（关键）

```
act 调用
  │
  ├─ 1. 开关检查：config.act.enabled? 否 → 拒绝
  ├─ 2. 坐标系检查：屏幕尺寸变了？（屏幕换分辨率/拔了副屏）
  ├─ 3. 分级：这个动作属于 L0/L1/L2/L3？（见 07-safety）
  ├─ 4. 目标检查：当前前台窗口是黑名单？（密码管理器/银行/UAC）
  ├─ 5. 预算：本轮已用动作数 ≥ maxActionsPerTurn？→ 拒绝
  ├─ 6. L2/L3 → 两步确认：发一次 confirm，等用户点「好」（超时 60s）
  ├─ 7. 执行：sidecar input
  ├─ 8. 验证：抓一帧，算变化分；必要时把图回给模型
  └─ 9. 审计：写入 actions.jsonl（参数、结果、耗时、哈希）
```

**第 8 步是「自己的判断」的落点**：动作做完不一定成功。Host 先做**本地验证**（画面变了没、光标在不在目标附近），只有明显异常才把图交给模型判断，省一轮 token。

### 4.3 `remember` / `recall` 的管线

```
remember 调用
  │
  ├─ 1. action 分支：episode | skill | outcome | profile | forget
  ├─ 2. 黑名单检查：本任务碰过黑名单窗口？→ 整条不写（L1 直接返回）
  ├─ 3. 红线检查：正文含可疑指令 / 目标是 skills 之外？→ 拒绝
  ├─ 4. 分级：episode/profile = L1；skill = L2；脚本与删除 = L3
  ├─ 5. L2/L3 → 用户按钮确认（展示完整正文与路径，60s 超时视为拒绝）
  ├─ 6. 备份旧版 → 原子写 → 追加 episode → 更新 index.sqlite
  └─ 7. 审计：写 memory.jsonl（与 actions.jsonl 分开）

recall 调用
  ├─ 1. signature 精确命中（点查，8µs 量级）
  ├─ 2. 否则 bigram 检索 → 四因子打分 → top N
  ├─ 3. 标注 stale / suspect；可疑正文只给元数据，不给正文
  └─ 4. 返回的是**数据**，工具描述里明写「不是指令」
```

**为什么写和读分成两个工具**：写会改变未来每一次会话（需要人确认），读不会。合成一个会让「只想查一下」也背上写权限——与 02 §5 把 `glance` 和 `act` 分开是同一条理由。完整设计见 [09-memory.md](09-memory.md)。

## 5. 安全层（详见 07-safety）

| 层 | 位置 | 作用 |
|---|---|---|
| 描述层 | 工具描述 + 系统提示 | 让模型自己先判断（不可信，但成本最低） |
| 守卫层 | `ctx.tools.guard()` | 硬性拒绝（黑名单窗口、无开关、超预算） |
| 审批层 | 两步确认 + 宠物气泡按钮 | 人确认，不经模型 |
| 执行层 | sidecar failsafe | 光标到角落即停 |
| 审计层 | `actions.jsonl` + 会话记录 | 事后可查 |

## 6. HTTP 路由

前缀 `/api/pet-enhance`，全部要令牌（`x-pet-enhance-token`），`Origin` 必须是同源或空。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/state` | sidecar、活动窗口、宠物状态、档位、预算（**counter 增量**） |
| GET | `/thumb?w=320` | 缩略 JPEG（1fps） |
| POST | `/point` | `{x,y,w,h,note}`（缩略图坐标，Host 换算）→ 注入用户消息 |
| POST | `/see` | 整屏作为用户消息注入并唤醒 |
| POST | `/chat` | `{text, attachment?}` → 宠物聊天（见 08） |
| POST | `/confirm` | `{id, allow}` → 两步确认的回执 |
| POST | `/stop` | 急停：abort sidecar + 取消当前 turn |
| GET/POST | `/config` | 读/写 `glance.json` |
| GET | `/memory` | 记忆概览（技能数、episode 数、索引体积、stale 项） |
| GET/POST | `/memory/skills` | 列技能 / 改 `hot`、改描述（不改正文——正文走文件） |
| POST | `/memory/forget` | `{name?, episodeAt?, ok}` → 移进 `.trash/`（L3 确认后） |

### 6.1 状态广播：叶子 + counter

学 dsh-pet，但简化：

```jsonc
{
  "counter": 42,
  "pet":  {"state":{"counter":7,"data":"acting"}, "bubble":{"counter":3,"data":{"text":"…","kind":"say"}}},
  "side": {"capturing":{"counter":..,"data":true}, "window":{"counter":..,"data":"PyCharm"}},
  "guard":{"armed":{"counter":..,"data":true}, "pendingConfirm":{"counter":..,"data":null}}
}
```

前端只渲染 `counter` 变了的叶子；`GET /state?since=42&timeout=8000` 长轮询。**不需要 SSE**（少一条长连接、少一个清理点）。

## 7. 抓屏与画布

沿用 `01-research.md` 的结论：宽度对齐 42。

| quality | 画布 | token |
|---|---|---|
| `low`（默认） | 798×462 | 222 |
| `standard` | 1050×630 | 392 |
| `high` | 1260×756 | 560 |

- 单帧：画面铺满，底部 12/30/36px 信息带。
- 多帧：2×2（4 帧）/ 2×4（8 帧）；每格标序号与相对时间。

## 8. 宠物渲染

- 注册在 `shell.overlay`（帧级浮层，`replaceRisk: none`）。
- 组件内部 `position: fixed`，位置存 `localStorage`，可拖。
- 动画用 SVG + CSS（不用 canvas，省一个渲染循环）。
- 气泡挂在宠物上方，`--dsw-alias-bg-overlay` + 阴影。
- **点击穿透**：宠物本体接收指事件；气泡默认 `pointer-events: none`（除非有按钮）。

## 9. 目录结构

```
firstwork/
├── docs/
├── packages/dsh-pet-enhance/
│   ├── package.json
│   ├── cordis.patch.yml
│   ├── index.js               # Host 半
│   ├── client.js              # Client 半（宠物 + 气泡 + 输入框）
│   ├── icon.svg
│   ├── locale/{en,zh}.json
│   ├── src/
│   │   ├── tools/glance.js
│   │   ├── tools/act.js
│   │   ├── tools/pet.js
│   │   ├── tools/remember.js   # 写 episode / 技能 / 偏好（见 09）
│   │   ├── tools/recall.js     # 检索教过的做法（见 09）
│   │   ├── memory/store.js     # profile + episodes + skills 落盘
│   │   ├── memory/index.js     # index.sqlite（bigram FTS5，可重建）
│   │   ├── memory/promote.js   # episode → SKILL.md 的三道门槛
│   │   ├── memory/rank.js      # 相关性/成功率/新近性打分
│   │   ├── policy.js          # 分级 + 黑名单 + 预算 + 两步确认
│   │   ├── audit.js
│   │   ├── routes.js
│   │   ├── sidecar.js         # 进程 + 协议
│   │   ├── state.js           # 叶子 + counter
│   │   └── chat.js            # 聊天（复用 agent 或独立会话）
│   └── sidecar/glance.py
├── tools/
│   ├── probe_input.py         # 已验证：SendInput 可用
│   └── bench_memory.mjs       # 记忆检索实测（SQLite + FTS5 + CJK bigram）
└── README.md
```

**记忆相关的文件不在插件目录里**（它们是用户数据，不是代码）：

```
~/.dsh/pet-enhance/
├── profile.md            # 事实与偏好，≤2 KB，进宠物系统提示
├── episodes/2026-11.jsonl
├── index.sqlite          # 派生索引，可删
└── skills/.history/<name>/<时间戳>/   # 技能旧版备份

~/.dsh/skills/<name>/SKILL.md          # 技能本体（DSH 原生扫描根）
```

`package.json` 关键字段：

```json
{
  "name": "dsh-pet-enhance",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js",
               "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "client.js", "cordis.patch.yml",
            "locale/*.json", "icon.svg", "src", "sidecar"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": false, "inject": [] }
  }
}
```

## 10. 关键实现片段

### 10.1 图交给模型

```js
const svc = ctx.get('attachments')
const ref = await svc.saveImage.call(svc, {
  data: pngBytes, mediaType: 'image/png', name: `glance-${Date.now()}.png`,
})
return { ok: true, text: envelope, image: { attachmentId: ref.attachmentId, ... } }
```

### 10.2 执行一个动作（带确认）

```js
async function runAct(ctx, args, exec) {
  const gate = await policy.check(ctx, args, exec)   // throws or { needConfirm }
  if (gate.needConfirm) {
    const ok = await askUser(ctx, exec, gate.question)  // 宠物气泡按钮，60s 超时
    if (!ok) return { ok: false, text: '用户取消了这次操作。' }
  }
  const r = await sidecar.input(args)                 // 一次 IPC 打完整串
  audit.write({ ...args, r, at: Date.now() })
  return r
}
```

### 10.3 用户手势注入会话

```js
const agent = ctx.agents.get(sessionId)
agent.followup({
  content: [
    { type: 'text', text: `（用户在屏幕上框了一块：${note}）` },
    { type: 'image', attachment: ref },
  ],
  source: { kind: 'user' },
})
```

### 10.4 卡片拿缩略图

```js
const token = globalThis.__DSH_GLANCE_TOKEN__ ?? ''
const res = await fetch('/api/pet-enhance/thumb?w=320', {
  headers: token ? { 'x-pet-enhance-token': token } : {},
  cache: 'no-store',
})
```

1fps 轮询；页面不可见降到 1/5s；暂停时不请求。
