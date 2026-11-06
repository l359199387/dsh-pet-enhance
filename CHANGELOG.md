# 变更记录

只记**用户能感知的变化**和**实测数字**。重构、改名、补注释不记。

## 0.0.5 · 未发布

### C1 · 动手（默认关闭）

- sidecar `input`：move / click / double_click / right_click / drag / scroll / type / key / focus / wait / screen；`hello.input=true`。
- 中文 `type` 走剪贴板粘贴并尽量恢复；组合键 `key`（如 `ctrl+s`）。
- failsafe：动作前光标在左上角 ≤2px → `FAILSAFE`，不重试；`abort` op 可打断进行中的 input。
- 工具 `act` 已注册，**默认关闭**（`settings.actEnabled` 或 `DSH_GLANCE_ACT=1`）；急停会 `panic` + `sidecar.abort()`。
- dsh-pet「更多」增加 **允许动手 · 开/关**（与 settings 同步，点一下翻转）。
- `/status` 的 `stage` 为 `C1`；版本 `0.0.5`。

## 0.0.4 · 未发布

### 命名

- 宠物对外名称由「小瞥」改为 **小蓝鲸**（菜单急停、气泡、人格、文档一并改）。

### dsh-pet 右键

- 「更多」新增 **实时看屏幕 · 开/关**：点一下翻转；开着时约 15s 盯一帧，有变化冒泡；设置落盘 `settings.json`。
- 仍保留 **小蓝鲸急停**。

### B2 · 接到 dsh-pet 的聊天与看屏记忆

- 看屏闭环：L 对话意图 → 抓屏附图 → dsh-pet 开口；失败气泡说明原因。
- 会话记忆继续用 dsh-pet（近 8 轮）；小蓝鲸只把看屏情景追加到 `~/.dsh/glance/episodes/YYYY-MM.jsonl`。
- 附图对话注入小蓝鲸人格片段（不改写 dsh-pet 的 `whisperPrompt`）；启动时冒泡一次接入提示。
- `/status` 的 `stage` 改为 `B2`；版本 `0.0.4`。

## 0.0.3 · 未发布

### 接到 dsh-pet 自带对话（L）

- 探测到 dsh-pet 后：**不再**另开小蓝鲸输入框；悬停宠物按 `L`（或 `Ctrl+Shift+L`）用它自己的对话。
- Host `chat-bridge` 用绝对 origin 调 dsh-pet；提到看屏/截图等 → 抓一帧 → **`POST /chat` 附图**让宠物开口描述（失败则 `/broadcast` 报错）。动作接口带 `surface=any`。
- dsh-pet 右键「更多」只挂 **小蓝鲸急停**；对话能力全部让给 L。
- 修复：原先 Host 侧相对路径 `fetch` 在 Node 会失败，导致「看一眼屏幕」完全没反应。
- 修复：意图只认「屏幕」不认「桌面」——「看一眼我的桌面」不会触发抓屏；现已覆盖桌面/画面等说法。

### 宠物形象

- 小蓝鲸换成原创 Q 版蓝发鲸鱼娘（卫衣 + 鲸鳍耳 + 尾巴），128px；仍保留呼吸/眨眼/随光标看。
- **复用 dsh-pet（合法方式）**：探测到 `/dsh-pet-7340` 后默认隐藏自绘形象；**不**拷贝其 CC BY-NC-SA 素材。见 `assets/NOTICE.md`。
- **不是**社区同人「蓝色大肥鱼」原图；说明见 `assets/NOTICE.md`。

### 宠物出现（B1）

- 浏览器半 `client.js`：挂到 `shell.overlay`，右下角出现可拖的 SVG 小鲸鱼（呼吸 / 眨眼 / 眼珠随光标）。
- 位置写入 `localStorage`（`dsh-glance.pos`），刷新后还在；颜色走 `--dsw-alias-*`，深色模式不用硬编码底。
- 点击弹出输入框 + ⏹ 急停（打 `POST /api/glance/stop`，宠物进 `alarmed` 三秒）；真聊天仍是 B2。
- Host 新增 `GET /state`（活动窗口 + 宠物叶子）、`POST /pet`（idle/sleeping/alarmed）；`glance` 抓屏时宠物进 `looking`。
- `/status` 的 `stage` 改为 `B1`。

## 0.0.2 · 未发布

### 单窗口与常驻 sidecar（A2）

- `glance` 支持 `window`（按标题匹配单窗口）与 `region:"x,y,w,h"`（物理像素区域）；找不到窗口时返回最接近的三个标题候选。
- 新增常驻 Python sidecar（`sidecar/glance.py`）：`hello` / `capture` / `windows` / `thumb` / `quit` / `stats`；JSON Lines + UTF-8；抓屏与后续输入共享同一 DPI 进程。
- Host 侧 `src/sidecar.js`：握手 5s、退出后指数退避重建（1→30s）、连续 5 次失败停手；卸载时 `quit` + 硬杀，不留孤儿进程。
- 整屏在 sidecar 不可用时仍退回 PowerShell（A1 路径）；单窗口 / 区域没有这条退路，会明确报 sidecar 不可用。
- `/api/glance/status` 的 `stage` 改为 `A2`，并带上 `sidecar.alive/pid/hello`。
- `input` 在 A2 直接 `INPUT_BLOCKED`（动手是 C1）。

## 0.0.1 · 未发布

### 能看到屏幕（A1）

- 新增工具 `glance`：抓一帧整屏，作为图片交给模型。三档画布 `low 798 / standard 1050 / high 1260` 宽。
- 内置 DPI 感知：150% 缩放下不再把 2560×1440 报成 1707×960，也不会只抓到左上角那一块。
- 图只随**本次工具结果**返回，不主动推给会话；一次调用一张图。
- 抓屏失败/超时/取消都会给模型一句人话，宿主不会因此断掉一轮对话。
- 实测（本机 2560×1440、单显示器、`low` 档）：端到端 500–600ms，其中 PowerShell 启动 + 抓屏 + 缩放 + 编码约 565ms，PNG 约 430KB；同一张图里 DSH 窗口的中文正文清晰可读。
- 工具不依赖宿主内部包（不再 `import('@deepseek-ai/dsh-tools')`）：那在插件目录里解析不到，会让工具静默挂不上。工具契约直接写成标准 JSON Schema 后裸注册。

### 骨架与开发流程

- `GET /api/glance/status` 返回 `{ok, name, version, stage, home, uptimeMs, tools}`；装没装、工具挂没挂，一条请求就能看出来。
- 插件卸载后路由与工具都会被摘掉；`/status` 里 `tools` 随之清空。
- 新增 `tools/dev-check.mjs`：一条命令跑完「文件齐全 / 清单一致 / `node --check` / Python 编译 / 单测 / 无 `console.log` / 不 import 宿主包」。
- `/api/glance/status` 需要宿主签发的 cookie：外部浏览器直接打开会得到 401，这是正常的（`/api` 前缀有鉴权门），验证要走应用内或新会话。
- 新增 `docs/10-dev-process.md`：一个切片的八步循环、A1–F4 阶段闸门、故障排查顺序、回滚清单。
