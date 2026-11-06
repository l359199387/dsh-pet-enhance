# 06 · 宠物：形象、状态机、人格、动画

## 1. 为什么要有「宠物」而不是「一个面板」

同样的能力，做成面板就是工具；做成宠物是**同居者**。差别在三点：

1. **它有自己的状态**。它现在是在睡觉、在看你、还是在干活，一眼可见——你不需要读日志。
2. **它有回应**。你点它，它会有反应；你急停，它会「炸毛」。这让「它在动你的鼠标」这件事有实感，而不是无声的脚本。
3. **它会被打断**。一个能被随手打断的东西，才让人敢让它动鼠标。

## 2. 形象（v1：自绘 SVG）

**不复制 dsh-pet 的素材**（其动画为 CC BY-NC-SA 4.0，禁止商用）。v1 用纯 SVG + CSS 动画，跟随主题 token：

- v1.1：原创 Q 版蓝发鲸鱼娘（深蓝渐变发、鲸鳍耳、尾巴、卫衣），角色色固定；面板/气泡仍走 `--dsw-alias-*`。
- **不复制**社区同人「蓝色大肥鱼 / 鲸鱼娘」成图（二创版权归原作者）；气质只对齐 DeepSeek 官方蓝鲸标识。
- 尺寸默认 128px，可 96 / 128 / 160 三档。

分层结构（便于分部件动画）：

```
<g id="body">     圆角躯干（呼吸：scaleY 0.97↔1.0，3.2s）
<g id="eyes">     两只眼（眨眼：scaleY 1→0.1→1，120ms，随机 3–8s）
<g id="mouth">    嘴（形状随状态换 path）
<g id="arms">     两只小手（acting 时抬起）
<g id="fx">       状态特效（thinking 的三点、alarmed 的炸毛线）
```

**宠物包（pet pack，v2）**：一个目录，含 `pet.json`（名字、尺寸、锚点）+ 若干 `.webp` / `.webm`（状态名 → 文件）。用户可放自己的形象；不内置任何第三方素材。

## 3. 状态机

```
        ┌──────────────────────────────┐
        │                              │
        ▼                              │
   ┌────────┐  glance  ┌─────────┐     │
   │  idle  │─────────>│ looking │─────┘
   └────────┘          └─────────┘
     │   ▲                   │
     │   │ 动作完成          │ 模型开始生成
     │   │                   ▼
     │   │              ┌──────────┐
     │   └──────────────│ thinking │
     │                  └──────────┘
     │                       │ act 开始
     │                       ▼
     │                  ┌────────┐
     │◄─────────────────│ acting │
     │   动作结束        └────────┘
     │                       │ 需要确认
     │                       ▼
     │                  ┌────────┐
     └─────────────────│ asking │
                        └────────┘

任意状态 ──(用户点睡觉 / 10min 无交互)──> sleeping
任意状态 ──(急停)──> alarmed ──(3s)──> idle
```

**状态来源**（谁能改它）：

| 来源 | 可改的状态 |
|---|---|
| Host（工具调用前后） | `looking` / `thinking` / `acting` |
| 策略引擎 | `asking` / `alarmed` |
| 用户 UI | `sleeping` / `idle` |
| 会话事件（`agent/status`、`tool/result`） | `thinking` / `idle` 的兜底同步 |

**优先级**：`alarmed` > `asking` > `acting` > `looking` > `thinking` > `sleeping` > `idle`。高优先级状态打断低优先级动画，低优先级**不排队**（宠物不是播放器，错过就错过）。

## 4. 人格（persona）

一段可配置的文本，默认：

> 你是一只住在 DSH 里的小鲸鱼，名字叫小蓝鲸。你话不多，说人话，不说教。
> 你看得见用户的屏幕，但你不偷看——只在被叫到时看。
> 你能操作电脑，但你怕给用户添麻烦：能一步做完的不要做两步，拿不准就停下来问。
> 你不吹自己，也不道歉个没完。做错了就说做错了，然后说怎么办。
> 用户急停的时候，你立刻停，不辩解。

人格参与两处：

1. **`pet` 工具的 `say`**：告诉模型「用这个口吻说话」。
2. **聊天（`/api/pet-enhance/chat`）**：拼进系统提示。

**人格不能覆盖安全规则**（`docs/07-safety.md`）。人格是「怎么说」，安全是「能不能做」，后者永远优先。

## 5. 说话气泡

- 最多 3 行、约 80 字；超出截断并加「…」，完整话进对话。
- 3 种气泡：`say`（普通）、`ask`（带「？」和按钮）、`alarm`（红边）。
- `ask` 带 1–3 个按钮（`好` / `不要` / `让我看看`），点击即回答，等价于 `userQuestions` 的答复。
- 气泡点击 → 展开成完整对话。
- **气泡是唯一的「说到你眼前」的通道**。模型的普通回复文本不进气泡（那会刷屏），只有它显式 `pet({say})` 的内容才进。

这一条是从 see-now 学来的（`say` 是唯一通道），但我们反过来：**默认不说，说了就一定要被看见**。

## 6. 动作清单（v1，SVG 程序化动画）

不需要视频素材，全部用 CSS/SVG 组合：

| 动作名 | 触发器 | 表现 |
|---|---|---|
| `breathe` | 常驻 | 躯干轻微缩放 |
| `blink` | 随机 3–8s | 眼睛闭合 |
| `look_around` | idle 15s | 眼珠左右移动 |
| `wake` | 从 sleeping | 抖动一下 + 睁眼 |
| `nod` | 收到指令 | 上下点一下 |
| `tilt` | 看不懂 | 歪头 |
| `raise_hand` | asking | 小手举起 |
| `work` | acting | 小手快速摆动 + 头顶齿轮（或三点） |
| `startle` | alarmed | 放大 1.1 + 红色描边 + 抖动 |
| `sleep` | sleeping | 眼睛变 `— —`，身体放平，`zzz` 飘 |
| `happy` | 任务成功 | 弹跳一次 |

**动作由 Host 指令驱动**（`pet({anim:"nod"})`），也可以在 Client 内部按状态自动播。两者不冲突：Host 指令优先播一次，播完回当前状态的常驻动画。

## 7. 与 dsh-pet 的互操作（推荐装上）

[dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的**代码 MIT、素材 CC BY-NC-SA 4.0**。我们**绝不拷贝**其 webm/设定图进仓库；要「用它的宠物」，请用户自己安装 dsh-pet，我们走开放 API。

探测：`GET /dsh-pet-7340/state` 成功 → 进入代理模式：

- **隐藏**自绘 SVG 形象；**双击宠物**打开 dsh-pet 自带对话弹窗（同右键「对话」/ 悬停 `L`）；**单击**仍为 dsh-pet 原 Q 弹。
  - 网页：双击发裸 `L` / 备援钮 `Ctrl+Shift+L`。
  - 桌面独立窗：Host 启动时给已装 dsh-pet 的 Helper 打幂等 `dblclick → showChatFromMenu` 补丁，并 `POST /reload`；升级 dsh-pet 后重启宿主会再打一次。
- Host 用 **绝对 origin**（`webServer.getOrigin()`）调 dsh-pet；相对路径在 Node 里会直接失败。
- **`pet-router`** 统一轮询 `GET /chat`（近 8 轮）：每句先经 `classify-utterance` **本地分流（默认 0 token，不叫醒主会话）**；「学会了吗」对照 playbook 冒泡回答。禁止把分流提示 followup 进带工具会话（会误 click）。仅 `DSH_PET_ENHANCE_CLASSIFY=wake` 才允许旧危险路径。分发：
  - `glance` → `chat-bridge` 抓帧附图让宠物开口。
  - `task` → `agent-bridge` 叫醒**主会话** Agent（模型调 `glance`/`act`），结束后回灌气泡；未开「允许动手」只提示。
  - `teach` / `teach_end` → 教学模式；`chat` → 不另抢话（桌宠自己已答）。
- **C2 `act` 管线**：策略分级 → 黑名单窗拒点 → 每轮预算 20 → L2/L3 等 `/api/pet-enhance/confirm`（**宠头顶气泡「好/不要」**，网页 overlay + 桌面 Helper 补丁；60s 超时拒）→ sidecar → 指纹校验 → `actions.jsonl`。
- **桌面动手护盾**：`act`/`input` 期间写 `~/.dsh/pet-enhance/desktop-act.lock`；Helper `windows.js` 补丁见锁则强制点击穿透并停翻 `setIgnoreMouseEvents`（否则鼠标扫过宠体会弄丢置顶，看起来像「卡没了」）；结束后删锁并 `HWND_TOPMOST` 重钉。
- **教学 → 自动化（1:1）**：须开「实时看屏幕」→ 教学中头顶常驻可点 **「我教完了」**（`/api/pet-enhance/teach-end`）→ 点击/滑轮附近截图作证据 → 理解阶段要 **OK+FAST 快捷路径**（不鼓励机械复刻）并 **主动多问几句**（目的/变通/以达成目的为准）→ learned↔automations（`strategy.approach=smart`）。**未明说每周几/几点/每隔… → 不向 Harness `schedule.create`、不定时不开启**；只有明确时刻才登记运行时间。用户再说「去看看B站 / 继续刷…」时：匹配学习目标关键词、**每轮重置动作预算**、有学习理解则优先叫醒变通（不盲打 `bilibli1` 这类地址栏脏输入）；「再做一次」才回落最近一对。**学完关实时看屏幕**；教完不自动动手。
- **侧栏「我学会的」**（`sidebar.panellist` + `main` key=`pet-enhance-learned`）：卡片格子 + 序号 + 标题模糊搜索；展示**学习理解**与**执行记录**（跑自动化时写入 `learned/<id>/runs.json`）。每条记录可评「好/一般/差」并写评语，`POST /api/pet-enhance/learned/:id/runs/:runId/rate` 叫醒模型改正理解。编辑弹窗可改目标 / 填**补充**（保存后并入理解并清空）；删除弹窗二次确认，联动清 `learned`+`automations`+skill，若有 `scheduleId` 则 `schedule.delete`。
- 每次看屏追加 `~/.dsh/pet-enhance/episodes/YYYY-MM.jsonl`（无图；敏感窗标题跳过）。
- 右键「更多」挂三项（状态写入 `~/.dsh/pet-enhance/settings.json`）：
  - **实时看屏幕 · 开/关**：开则约每 15s 盯一帧，有变化冒泡；关则只保留主动看屏。
  - **允许动手 · 开/关**：对应 `actEnabled`；关则 `act` 拒绝真动手。
  - **小蓝鲸急停**。
- 未装 dsh-pet 或本地关掉「用 dsh-pet」时，回退内置 SVG + 面板。

我们不注册 `petApi7340`（避免冲突）；自己的 Cordis 名是 `petEnhance`（尚未挂）。
