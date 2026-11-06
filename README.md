# 一瞥 · dsh-glance

> 一只住在 DSH 里的小宠物：**它看得见你的屏幕，会说话，能聊天，你让它做的事它会自己动手——鼠标、键盘、命令。**

**小瞥**（宠物名）不是摆设。你指着屏幕上的一块问「这是啥」，它看得见；你说「帮我把这个设置改成中文」，它会真的去点。它也有脾气：违法的事不做，破坏性的事先问你，看不懂就停下来问，而不是瞎点。

这是一个 DeepSeek Harness 的**可热插拔插件**。装上它，桌面右下角多一只小东西；拔掉它，什么都不留。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **看见** | 整屏 / 单个窗口 / 一小块区域；按变化量筛帧，静止屏幕几乎不花钱 |
| **说话** | 气泡 + 表情 + 动作；默认沉默，只在值得说的时候开口 |
| **聊天** | 点它一下就能打字聊；会话内记得最近几轮，跨会话靠下面那行「记得住」 |
| **动手** | 移动鼠标、点击、拖动、滚轮、按键、输入文字、聚焦窗口（软件层 `SendInput`） |
| **用工具** | 文件、命令、脚本走 DSH 已有的 `read/write/edit/pwsh` 等工具，不重复造 |
| **记得住** | 教一次就沉淀成技能：任务轨迹落本地、成功做法写成 `SKILL.md`、下次一句话就能调出来 |
| **自己判断** | 风险分级、两步确认、紧急停止、本地先验证再叫模型 |

---

## 三条边界（写在最前面）

1. **不做违法的事。** 入侵他人设备、窃取凭据、绕过安全控制、骚扰、诈骗、破解授权——一律拒绝并说明原因。
2. **不搞破坏。** 删除、覆盖、卸载、关机、改系统设置、发消息给别人、花钱——都属于「必须先问」的级别；问不到就不做。
3. **不装懂。** 看不清（小字、弹窗、加载中）就停下来重新看，或者问你；**绝不猜着点**。

完整规则见 [docs/07-safety.md](docs/07-safety.md)。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-research.md](docs/01-research.md) | 参考项目拆解（see-now / tts-bridge / dsh-pet）+ 记忆先行者 + 本机实测 |
| [docs/02-product.md](docs/02-product.md) | 产品形态、宠物交互、用户故事、不做的事 |
| [docs/03-architecture.md](docs/03-architecture.md) | 三层架构、sidecar 协议、工具契约、路由、宠物渲染、语音 |
| [docs/04-roadmap.md](docs/04-roadmap.md) | A–F 阶段路线与逐条验收标准 |
| [docs/05-risks.md](docs/05-risks.md) | 风险表、成本模型、隐私与合规 |
| [docs/06-pet.md](docs/06-pet.md) | 宠物形象、状态机、人格、动画清单 |
| [docs/07-safety.md](docs/07-safety.md) | **安全策略：风险分级、两步确认、急停、审计** |
| [docs/08-chat-voice.md](docs/08-chat-voice.md) | 聊天协议与语音（先文字，后语音） |
| [docs/09-memory.md](docs/09-memory.md) | **记忆与技能包：教一次，下次会做**（四层记忆、检索打分、技能沉淀、投毒防御） |
| [docs/10-dev-process.md](docs/10-dev-process.md) | **开发流程：一个切片的八步循环、阶段闸门、故障排查、回滚清单** |
| [AGENTS.md](AGENTS.md) | 给后续 agent 的硬约束 |

---

## 工作原理（一张图）

```
        你 ──打字/点它/框一块──> 宠物气泡
                                    │
                            ┌───────▼────────┐
                            │  Client 半      │  shell.overlay：形象/气泡/输入框
                            │  (浏览器页面)   │  1fps 缩略图 + 语音
                            └───────┬────────┘
                                    │ 同源 HTTP + 一次性令牌
                            ┌───────▼────────┐
                            │  Host 半        │  glance/act/pet/remember/recall
                            │  (DSH 进程)     │  策略引擎 + 确认 + 审计 + 记忆
                            └───┬────────┬───┘
                    stdio JSON  │        │  ctx.attachments.saveImage
                    ┌───────────▼──┐  ┌──▼──────────────┐
                    │ Python 侧车   │  │ 模型（看图/回话）│
                    │ 抓屏 + 输入   │  └─────────────────┘
                    └──────────────┘
```

- **侧车（sidecar）**只做两件事：把像素抓出来、把输入打出去。它不认识 DSH，也不做判断。
- **Host** 做所有判断：能不能做、要不要问、做完有没有成功、这件事值不值得记下来。
- **模型**只通过工具看和动；**它看不到、也打不出任何未经 Host 检查的动作。**

记忆分四层（详见 [09](docs/09-memory.md)）：

```
事实 profile.md  →  轨迹 episodes/*.jsonl  →  技能 SKILL.md  →  工具包 scripts/
（常驻 ≤2KB）      （append-only 证据）      （~/.dsh/skills，按需加载）  （确定性步骤）
```

只往上提炼、不跨层覆盖；权威在文件、索引（`index.sqlite`）可随时删了重建。

---

## 安装（B2：看得见、能盯窗口、接 dsh-pet 看屏聊天）

本机**没有** `dsh` 命令行，走 GUI：

```
Harness「插件」页 → 从目录安装 → 选 packages/dsh-glance
```

装完重启宿主，检查三处：

1. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `dsh-glance`，且 `node_modules/dsh-glance` 是指向本仓库的链接（逐文件 junction，不是拷贝）；
2. 打开任意会话应看到小瞥（未装 dsh-pet 时是右下角 SVG；**已装 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 时**左下角控制条，形象由 dsh-pet 渲染——我们不拷贝它的 CC BY-NC-SA 素材）；
3. 新会话里说「看一眼我屏幕」→ `glance` 出图；卸载后工具与宠物消失、无残留 `python` 进程。外部浏览器直接打开 `/api/glance/status` 会 401，属正常。

没装上或工具没挂上，先看 `~/.dsh/glance-error.log`。开发期的完整循环（改代码 → 校验 → 重装 → 实测 → 拔插演练）见 [docs/10-dev-process.md](docs/10-dev-process.md)。

---

## 平台

| 平台 | 抓屏 | 输入控制 | 状态 |
|---|---|---|---|
| Windows 10/11 | Pillow / PrintWindow | `SendInput` | 主目标（本机已验证） |
| macOS | `screencapture` / Quartz | CGEvent | 计划中 |
| Linux X11 | `import` / Xlib | XTest | 计划中 |
| Wayland | PipeWire 门户 | 受限 | 暂不支持输入注入 |

> **只做软件层输入**（注入到当前桌面会话），不碰硬件层（Arduino/CH9329 之类）。这样权限最小、可急停、可审计。
