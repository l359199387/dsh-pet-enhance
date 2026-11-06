# 01 · 调研：两个参考项目 + 本机实测

本文是设计前的证据部分。事实分三类，互相不混：

- **【源码】**：从仓库代码里读到的，带文件行号。
- **【实测】**：在这台机器上跑出来的数字（Windows 10 / 2560×1440）。
- **【推断】**：设计判断，不是事实。

参考仓库已克隆到 `C:\deepseekwork\_ref\`：

| 仓库 | 版本 | 许可 | 一句话 |
|---|---|---|---|
| [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) | 0.1.4 | Apache-2.0 | 按画面变化量筛帧，多帧拼一张图喂给模型 |
| [Yuuyuko-uu/dsh-tts-bridge](https://github.com/Yuuyuko-uu/dsh-tts-bridge) | 1.3.3 | 自定义插件许可 | 盯会话轮次，把文本交给浏览器里的 DeepSeek 页面朗读 |

---

## 1. DSH 插件的骨架（两个项目完全一致）

**【源码】** 一个可安装的 bundle 由这几个文件构成（`dsh-see-now/package.json`、`dsh-tts-bridge/package.json`）：

```
package.json          # 声明 dsh.bundle.patch 与 dsh.client
cordis.patch.yml      # - insert: [{ id, name }]
index.js / lib/index.js   # Host 半：export apply / inject / Config
client.js / lib/client.js # Client 半：window.__ModuleLoader__.load({...})
```

`package.json` 里关键两段：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": false, "inject": [] }
}
```

**【源码】** 补丁只有三行（`dsh-see-now/cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-see-now
      name: dsh-see-now
```

**【推断】** 这一行同时激活 Host 半和 `dsh.client` 声明的网页半。所以「可热插拔」不是额外功能：装 = 插，卸 = 拔，中间态（禁用）由 `set_bundle` 控制，所有注册都必须是 `ctx.effect` 拥有的，否则拔不干净。

### 1.1 Host 半的形状

**【源码】** `dsh-see-now/src/index.js:431`：

```js
export async function apply(ctx) {
  try { return await registerAll(ctx) }
  catch (e) {
    ctx?.logger?.error?.(...)          // 只在开发者工具里
    writeLoadError(e)                   // ← 关键：写 ~/.dsh/see-now/plugin-error.log
    if (process.env.DSH_SEE_DEBUG) throw e
    return () => {}
  }
}
```

**【源码】** `dsh-tts-bridge/lib/index.js:15`：

```js
export const inject = ['webServer', 'sessions', 'sessionTitle', 'workspaceRegistry', 'timer']
```

**【推断】** 两个项目的失败姿态值得照抄：

1. 插件加载失败**不能让应用起不来**，但**必须留下用户能找到的痕迹**（写文件，不只 `logger.error`）。
2. 可选服务（`webServer`、`attachments`）**不要写进 `inject`**——写进去会让没有该服务的部署连插件都起不来，工具也一起消失。用 `ctx.inject(['webServer'], (scoped) => …)` 按需挂，并且**在那个回调里注册**，因为服务可能比插件晚挂载（`dsh-see-now/src/index.js:452-458` 有明确注释）。

### 1.2 工具的契约细节（踩过的坑）

**【源码】** `dsh-see-now/src/tool-spec.js:4-9` 的注释：

> `parameters` 是「属性名 → 值 schema」的映射，**不是**完整 JSON Schema。写成 `{type:'object', properties:{...}}` 会被宿主拒绝：
> `unsupported JSON schema: parameters.type must be a value schema object`。
> （`output.schema` 反而是完整 JSON Schema —— 两个形状不一样。）

**【源码】** `dsh-see-now/src/index.js:354-356`：

> `saveImage` 必须 `.call(svc, …)`：它内部读 `this.compression`，方法取下来裸调会丢 `this`，报 `Cannot read properties of undefined (reading 'compression')` —— 所有出图工具一起挂。

**【源码】** `dsh-see-now/src/index.js:1228-1243`：重复安装时 `tools.register` 抛 `tool "see_now" is already registered`，**不能让它冒到 apply 的兜底里把整个插件判死**，也不能「只是不注册工具」——否则两套常驻循环同时叫醒模型。正确做法：整份退掉。

**【源码】** `dsh-see-now/src/tool-spec.js:23`：`TOOL_TIMEOUT_MS = 900_000`，且注释说明「必须明显大于 `seconds` 默认值」——120s 的超时会把静止屏幕上的正常等待判成超时。

### 1.3 取图为什么必须走工具返回值

**【源码】** `dsh-see-now/src/index.js:4-6`：

> 唯一的取图方式是 `watch`：它阻塞到「攒够一张」或超时，然后把图作为**工具返回值**交给宿主。不要用 `sessionController.prompt` 往会话里推 —— 那样模型看到图又去调工具、自己唤醒自己，停不下来（0.0.1 就是死在这儿）。

**【推断】** 这条是硬约束。任何「后台主动推图给模型」的设计都会形成自唤醒环。我们的「指着说」是**用户手势产生的 user message**，不是后台推图，所以在约束之外——但要在文档里写清楚这条界线。

---

## 2. see-now 的省 token 设计（值得直接继承的数学）

**【源码】** `README.md:75-92`：

成本口径（宿主 DeepSeek-V4，14px patch 向上对齐 → 42px 一格 → `rows×(cols+1)+2`）：

| 档位 | 画布（画面 + 音轨条） | 每张 token |
|---|---|---|
| `low`（默认） | 798×450 + 12px = **798×462** | **222** |
| `standard` | 1050×600 + 30px = 1050×630 | 392 |
| `high` | 1260×720 + 36px = 1260×756 | 560 |
| `ultra` | 1596×900 + 24px = 1596×924 | 860 |

要点：

1. **宽度对齐 42，不对齐 16:9**。800 会被 pad 到 812 = 19.3 格，白算一整列；798 正好 19 列。
2. **一张图塞 4 帧还是 8 帧，价格一样**——所以「多留一帧」几乎免费，「漏掉一帧」才贵。
3. token 是按 42px 一行算的**阶梯函数**，画面下方空着的高度照样收钱；所以「音轨条」不额外花钱（我们不需要音轨，但可以用这条空带放时间戳/窗口名）。

**【源码】** `README.md:94-116` 的长期成本提醒，很重要：

- 一张 798×450 PNG ≈ 130 KB，base64 ≈ 173 KB；
- 宿主在**单个请求内**保留的 base64 图片超过 `maxRequestImageBytes`（默认 20 MiB）时，会把**最老的图片永久替换成占位文字**并重试；
- 「永久」意味着**改会话历史**，前缀缓存从被改处往后全部失效，那一段重新计费；
- 20 MiB ÷ 173 KB ≈ 120 张；默认节奏一小时上下就撞线。

**【推断】** 结论落到我们的设计上：

- 默认每次只交**一张单帧**（222 token），不要一上来就多帧；
- `watch` 模式必须带**叫醒预算**（N 次没人理就停），并在 `status` 里显式报告；
- 长会话建议分段，这条写进 README 的「怎么用」。

## 3. see-now 的交互形态（我们只借鉴一半）

**【源码】** 它有：`see_now` 工具（watch/peek/start/stop/status/window/region/help）、一个**独立 Python + tkinter 悬浮窗进程**（每 250ms 读一次 `~/.dsh/watch-window.json` 决定显隐）、一个**全屏取框窗**（`pick_region.py`）、一个设置页（`/api/see-now/*` 四条路由）、以及「音轨/台词」转写。

**【推断】** 我们不照抄的地方：

1. **不做独立悬浮窗进程**。它的窗是 `examples/floating-chat/window.py`（71 KB）级别的自绘窗口，跨平台、要自己管位置/DPI/心跳。我们直接把卡片渲染在 DSH 页面里（`shell.overlay` 槽），天然跟随主题、语言、缩放，也不需要第二个进程。
2. **不做音轨/台词**。那是「陪看视频」的能力，不是「一起用电脑」。
3. **不做模型主动 `say` 的语音**（我们只做文字气泡）。TTS 是 tts-bridge 的地盘。

### 3.1 tts-bridge 教会我们的两件事

**【源码】** `lib/turn-scanner.js`：每 1.5s 用 `ctx.interval` 扫一次被监听的会话，`session.snapshotEvents(tracked.seq)` 只取增量，按 `data.turn` 累积 `assistant/message` 的 text，在 `turn/end` 且 `reason.kind === 'completed'` 时吐出整轮文本。

**【推断】** 「盯一轮说完」的正确写法是**投影增量 + 在 turn/end 上收口**，不是订阅 `session/event` 再全量重扫。我们如果要做「AI 说完话把卡片刷新」，照这个来。

**【源码】** `lib/local-gate.js:1-18`：桌面宿主给**每一个**插件注册的 HTTP 路由套了一层闸：请求里没有 Electron 渲染进程的 `x-dsh-desktop-renderer` 令牌、且设置里没开「允许浏览器访问」时，一律 `403 Browser access is disabled`。浏览器扩展拿不到这个令牌，所以 tts-bridge 另开一个只监听 `127.0.0.1` 的小门：

- 只认 `chrome-extension://` 来源，网页（http/https/`null`）连 403 body 都读不到；
- 除 `/where` 外要求每次启动新发的内存令牌，`timingSafeEqual` 定长比较；
- 只放行固定几条路径。

**【推断】** 对我们是好消息：**卡片就在 DSH 页面里，是同源 fetch**，走 `ctx.webServer.register` 就够。如果实测发现桌面宿主也拦同源，再降级到 tts-bridge 那种独立端口，代价是多一个监听。

---

## 4. 本机环境实测

### 4.1 有什么、没什么

| 项 | 结果 |
|---|---|
| OS | Windows 10，PowerShell 5.1.19041 |
| 显示器 | 1 块，2560×1440，工作区 2560×1400（无任务栏遮挡底部 40px） |
| PATH 上的 `ffmpeg` / `node` / `python` | **都没有** |
| DSH 自带运行时 | `C:\Users\13591\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\` 下有 `python\python.exe`（3.12.14，Pillow 12.3.0、tkinter 8.6）和 `node\bin\node.exe` |

**【推断】** 这是最关键的一条：**see-now 依赖 ffmpeg，这台机器装不上就用不了**。所以我们的抓屏不能押在 ffmpeg 上。

### 4.2 抓屏候选方案实测

| 方案 | 全屏耗时 | 能抓窗口？ | 依赖 | 备注 |
|---|---|---|---|---|
| Pillow `ImageGrab.grab(all_screens=True)` | **56 ms** | 否（只能整屏） | 自带 Python + Pillow | 一次调用拿到 2560×1440 |
| PowerShell `Graphics.CopyFromScreen` | **48 ms** | 否 | 系统自带 | 每帧 spawn 一次 pwsh，进程启动 ~200ms 未计入 |
| `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` | 单窗口，~30-80 ms | **是** | ctypes | 实测抓到 Edge 最大化窗口 2576×1416，内容完整（已人眼核对） |
| ffmpeg `ddagrab`/`gdigrab` | — | 是 | ffmpeg | 本机没有，放弃 |

**【实测】** 窗口枚举（`EnumWindows`）拿到 12 个有标题的可见窗口，包括 DSH 自己（`Deeppseek harness …`，pid 22640）和 Edge。

**【实测】** 两个坑：

1. **控制台编码**：中文标题经 PowerShell 管道回来是乱码（`�ٶ�����`）。sidecar 必须 `sys.stdout.reconfigure(encoding='utf-8')`，且 JSON 用 `ensure_ascii=False`，Host 按 UTF-8 解。
2. **DPI**：最大化窗口 `GetWindowRect` 返回 `(-8, -8, 2576×1416)`——带 8px 不可见边框。要用 `SetProcessDPIAware()` + `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 拿真实边界，否则截图会带黑边、坐标也会偏。

### 4.3 Harness 侧可用的接口（用 `cordis_inspect_query` 确认，非猜测）

| 能力 | 结论 |
|---|---|
| `ctx.tools.register(definition)` | 返回 disposer；`parameters` 是「属性名→值 schema」映射；`output: {schema, render}` |
| `ctx.attachments.saveImage({data, mediaType, name})` | 返回 `ImageAttachmentRef`；`ImageBlock = {type:'image', attachment}` |
| `ctx.webServer.register({kind, path, handler})` | `kind` 为 `exact`/`prefix`；返回 disposer |
| `ctx.webServer.tapIndex(fn)` / `webserver/index-inject` | 往 index.html 注入全局变量（可用来下发一次性令牌） |
| `ctx.sessions.list()` / `.get(id)` | 内存会话表；`Session.snapshotEvents(seq)` 取增量 |
| `agent.inject()` / `agent.followup()` | 注入上下文 / 唤醒下一轮 |
| Client 槽位 | `shell.overlay`（帧级浮层）、`conversation.composer.dock`（输入框下方流内）、`main`（keyed 主面板）、`sidebar.panellist`（图标→主面板） |
| 主题 token | `--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary`、`--dsw-alias-brand-primary` 等 |
| Client 内建 | `ctx`(get/on/provide/effect)、`React`、`host.call`、`styles.insert`、`console` |

**【推断】** 卡片放 `shell.overlay`：它是「Frame-wide floating layer, above every column and outside their scroll containers」，正好等于「右下角悬浮卡」；而且 `replaceRisk: none`。`conversation.composer.dock` 是流内元素，做不了拖拽悬浮。

---

## 4.4 输入控制实测（软件层）

**【实测】** 自带 Python 的 ctypes 直接调 `SendInput`，不需要任何第三方库、不需要管理员权限：

| 操作 | 结果 |
|---|---|
| 绝对坐标移动（`MOUSEEVENTF_ABSOLUTE\|MOVE`，0–65535 归一） | 调用到生效 0ms；`GetCursorPos` 立即读到目标点（有 1px 取整误差） |
| 相对移动（`MOUSEEVENTF_MOVE`） | 正常 |
| 按键（`KEYBDINPUT`，VK 码） | CapsLock 按下/释放使状态翻转，再按一次恢复原状 |
| 结构体布局 | **必须**用 `Union` 装 `MOUSEINPUT/KEYBDINPUT`（`INPUT` 是 union + padding），手写偏移会崩 |

三点必踩的坑：

1. **`INPUT` 是 union**。写成 `('type', DWORD), ('mi', MOUSEINPUT)` 会让 `sizeof(INPUT)` 偏小，`SendInput` 返回 0 且不报错。
2. **绝对坐标要归一化到 0–65535**，且分母是 `屏幕宽度 - 1`；用 `屏幕宽度` 会差 1px，多屏时误差累积。
3. **必须 `SetProcessDPIAware()`**。否则 125%/150% 缩放下坐标全部按逻辑像素解释，点哪儿偏哪儿。

**从这些事实得到的约束**：

- 输入注入必须和抓屏在**同一个 sidecar 进程**里（同一个 DPI 上下文、同一套坐标），否则坐标对不上。
- 每次动作后必须**重新抓一帧验证**，不能假设「点了就生效」。
- 必须有**急停**：指针移到屏幕左上角 `(0,0)` 时立刻放弃剩余动作（PyAutoGUI 的 failsafe 思路），再叠加一个热键。

---

## 5. dsh-pet：宠物本身怎么做

**【源码/文档】** `PC2005-cloud/dsh-pet`（MIT 代码 + CC BY-NC-SA 4.0 素材）。它是一个完整的三件套工程：

```
① prompts/      动画生成提示词配方（绿幕规范 + 按秒分解）
② 素材链        源视频 → 透明动画（VP9-alpha webm / Safari 用 hevc mov）
③ dsh-pet/      插件本体：src/host、src/client、src/shared、src/standalone、runtime/electron-helper
```

值得直接学的设计：

1. **状态用「叶子 + 版本号」广播**。`GET /state` 返回 `{counter, sections, pets}`，每个叶子是 `{counter, data}`；**counter 变了才渲染**。支持 `?since=&timeout=` 长轮询（≤10s）。前端首拉只记基线不渲染。这是「多端（浏览器/桌面/第三方）看同一只宠物」的正解。
2. **占用锁（lock）**：第三方要驱动宠物必须先 `POST /lock` 拿 `lockId`，占用期间宠物完全静止、别的来源全让路；用户一拖宠物立刻抢回。**这是「谁在控制它」的显式归属**。
3. **宠物是「外部可控的实体」，不是工具**：`/whisper`（让它自己生成一句）、`/broadcast`（投喂固定文本、不生成）、`/anim`（点播动画）、`/position`、`/throw`、`/sleep`。第三方插件通过 HTTP 或页内 Cordis 服务 `ctx.get('petApi7340')` 驱动。
4. **工作状态六档**：思考 / 工作 / 整理 / 等待 / 成功 / 出错，跟随会话事件切动画，气泡里说具体在做的事（«读文件» «改 index.ts» «跑 npm test»）。
5. **桌面形态用 Electron 透明置顶窗**（`runtime/electron-helper/`），带 DPI 线性化、多屏工作区判定、任务栏/最顶层 watchdog。这是「宠物要浮在所有窗口之上」的唯一可靠做法。
6. **语音双通道**：合成（默认 edge 在线）与识别（默认宿主 `speechToText`）各留一个注册槽，第三方可替换；**不回落**——注册了坏了就是没声音，不静默换人。

**【推断】** 我们的取舍：

| 学 | 不学 |
|---|---|
| 「叶子 + counter」状态模型（多端一致） | 不复刻 100+ 段视频动画（成本高、素材许可受限） |
| 「占用锁」表达控制权归属 | 不做独立 Electron 壳（v1 先住浏览器 overlay；桌面壳作为阶段 E） |
| 六档工作状态（模型在做啥，宠物就演啥） | 不做余额/待办/梦话这些周边 |
| 语音双槽可替换 | 不内嵌 edge TTS（先走浏览器 `speechSynthesis`） |
| 「宠物是实体，可被外部驱动」 | 不做「第三方消息免确认」——我们的输入控制必须过安全层 |

**素材与许可**：dsh-pet 的动画素材是 CC BY-NC-SA 4.0（禁止商用），代码 MIT。我们**不复制它的素材**；v1 用自绘 SVG/CSS 小宠物，后续开放「宠物包」格式让用户自己放 webp/webm。

---

## 6. 从调研到设计的九条硬结论

1. **不依赖 ffmpeg。** 抓屏用自带 Python（Pillow/ctypes），坏掉时退 PowerShell。
2. **图只走工具返回值。** 后台推图 = 自唤醒环。
3. **`parameters` 和 `output.schema` 形状不同**，别抄错。
4. **`saveImage.call(svc, …)`**，别丢 `this`。
5. **所有注册归 `ctx.effect`**，否则「热拔」拔不干净。
6. **失败要写文件**，因为 `logger.error` 用户看不见。
7. **抓屏与输入必须在同一个 sidecar**，共享 DPI 上下文与坐标系。
8. **输入注入必须有急停、有验证、有审计。** 软件层 `SendInput` 已验证可用，但它没有「撤销」。
9. **宠物是多端共享的状态机**，不是一段动画；用「叶子 + counter」广播，用锁表达控制权。

## 7. 记忆的先行者（为 09 做的调研）

详见 [09-memory.md](09-memory.md) §3。这里只留结论与出处，不进设计细节。

| 项目 | 关键机制 | 出处 |
|---|---|---|
| Voyager | 技能库 = **可执行代码 + 自然语言描述**，按描述检索复用；环境反馈驱动的自我修复 | [arXiv:2305.16291](https://arxiv.org/abs/2305.16291) |
| MemGPT / Letta | **分层记忆**（main context 有硬预算，其余外部存储，按需换页） | [arXiv:2310.08560](https://arxiv.org/abs/2310.08560) |
| Generative Agents | 检索打分 = **新近性 + 重要性 + 相关性**；观察 → 反思 → 更高层记忆 | [arXiv:2304.03442](https://arxiv.org/abs/2304.03442) |
| Agent Skills / Claude Code | `SKILL.md` + frontmatter，**渐进披露**（目录只有 name + description，正文按需加载） | [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) |
| Cline Memory Bank | 结构化 markdown，人和模型共读，可 diff、可 review | [docs.cline.bot](https://docs.cline.bot/best-practices/memory-bank) |
| UFO² | 知识基底含**真实执行轨迹**（demos / traces），不只是文档 | [github.com/microsoft/UFO](https://github.com/microsoft/UFO) |

**【推断】** 我们要的不是「一个能记住的模型」，而是**一套能被人审阅、能被回滚、读起来只要微秒**的文件约定。所以格式学 Agent Skills、分层学 MemGPT、打分学 Generative Agents、沉淀学 Voyager，落地全用 DSH 现成零件。

### 7.1 DSH 自带的 skill 系统（本机 0.2.1-rc.5 确认存在）

| 组件 | 关键事实 |
|---|---|
| `@deepseek-ai/dsh-skill` | `ctx.skills.register(skill)` 运行时注册；`registerProvider({name,list,get})` 提供方注册；同名按 rank 裁决；`SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/` |
| `@deepseek-ai/dsh-skill-filesystem` | 扫描 5 个根：项目 `.dsh/skills`(100) → `.agents/skills`(200) → custom(300) → `$DSH_HOME/skills`(400) → `$DSH_AGENTS_HOME/skills`(500)；Chokidar 监视，**新/删/改无需重启** |
| `@deepseek-ai/dsh-tool-skill` | 首次请求前一条持久目录（name + 描述截断 500 字）；`skill` 工具按名加载；`/name` 用户直接调用；目录变化**追加全量替换** |
| `@deepseek-ai/dsh-storage-json` | 领域 KV，原子发布（临时文件 + fsync + rename）；`single` 每次重写整单元 |
| `@deepseek-ai/dsh-session-query-sqlite` | 会话全文检索：`node:sqlite` + FTS5 + `tokenize='unicode61'`，派生索引可重置 |

**【实测】** 中文检索的三个坑（本机 SQLite 3.53.4）：

1. `tokenize='unicode61'` 把整段中文当一个 token——查「保存」**0 命中**，查整句才命中。
2. `tokenize='trigram'` 要求 ≥3 字符——查「保存」（2 字）**0 命中**，查「保存到桌面」命中。
3. 自建 bigram 字段 + `unicode61` + 短语查询 → 2 字、5 字、英文单词都能命中，且 `save desktop` 这种不连续的不误命中。

**【实测】** 5000 条、两个 FTS 索引（trigram + bigram）：批量写入 102–105 ms，冷启动重开 1.0 ms，点查 6–7 µs，5 字短语检索 15–20 µs，`LIKE '%…%'` 409–444 µs（慢 25 倍以上且随行数线性退化）。脚本：`tools/bench_memory.mjs`（预热后 3 轮取中位数）。
