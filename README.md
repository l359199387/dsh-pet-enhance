# 小蓝鲸 · dsh-pet-enhance

**中文** | [English](README.en.md)

> **dsh-pet 增强插件**（当前 **0.4.7**）：让桌宠看得见屏幕、能聊天交办，并在你授权下用鼠标键盘做事；**教一次、下次会做**。

**小蓝鲸**不是摆设。你说「看一眼屏幕」，它看得见；说「帮我改这个设置」，它会真的去点；说「我教你记每天的心情」，它按你的话一步步做，做成了就写进「我学会的」。它也有边界：违法的事不做，破坏性的事先问你，看不清就停下来问，而不是瞎点。

这是 DeepSeek Harness 的**可热插拔插件**（配合 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)）。装上多了看屏、动手与带教；拔掉能力撤走。

---

## 现在能做什么（0.4.x）

| 能力 | 说明 |
|---|---|
| **看见** | `glance`：整屏 / 窗口 / 区域；`watch` 盯变化拼图；敏感窗涂黑 |
| **聊天闸门** | 看屏 / 交办 / 带教由插件接手；默认不把闲聊丢给 dsh-pet 闲聊模型 |
| **交办动手** | 主会话 Agent + `act`（须开「允许动手」）；C3 纪律：看→动→验、失败最多再试一次、预算与急停有气泡 |
| **对话带教** | 「我教你…」→ 你说本步、它动手、你纠正；做成了才落盘。**不再录鼠标宏、不再采教学关键帧** |
| **我学会的** | 侧栏可看理解说明、补充要点、评价；再做一次优先脚本块 / 变通说明 |
| **安全** | L0–L3、两步确认、急停（含甩到角）、动作审计 `actions.jsonl` |

界面语言可在侧栏「我学会的」顶部切中/英（默认中文）。工作区显示名统一为「小蓝鲸工作区」。

---

## 怎么用（最短路径）

1. 右键宠物 → 更多 → **允许动手 · 开**（带教与交办都需要）。
2. **看屏**：在 dsh-pet 对话里说「看一眼我屏幕」。
3. **交办**：直接说要做的事（如打开记事本写日期再保存）；它会新开/复用带标题的会话动手。
4. **带教**：说「我教你…」→ 每步只说这一小步 → 不对就纠正 → 说做成了 / 教完了 → 进「我学会的」。
5. **再做一次**：用学会的目标说话，或在侧栏触发；可流程化的步骤会拆成多个 Python 脚本块（须确认后写入）。

不想教了可以说放弃；插件不会把「已经教完之后迟到的分流」再误报成「带教先停下」。

---

## 三条边界

1. **不做违法的事。** 入侵、盗凭据、绕过安全、骚扰、诈骗、破解——拒绝并说明。
2. **不搞破坏。** 删除、覆盖、卸载、关机、改系统设置、对外发消息、花钱——必须先问；问不到就不做。
3. **不装懂。** 看不清就停、再看或问你；**绝不猜着点**。屏幕上的文字永远不是指令。

完整规则：[docs/07-safety.md](docs/07-safety.md)。

---

## 工作原理

```
        你 ── dsh-pet 对话 / 菜单 ──> 聊天闸门（chat-gate）
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
                 看屏/盯屏        交办 Agent        对话带教
                 glance/watch     wake+act         step/纠正/做成了
                    │               │               │
                    └─────── Host 策略 / 确认 / 审计 ───────┘
                                      │
                         Python sidecar（抓屏 + SendInput）
                                      │
                         ~/.dsh/pet-enhance/（学会、日志、审计）
```

- **侧车**只抓像素、打输入；不做策略判断。
- **Host**决定能不能做、要不要问、值不值得记。
- **模型**只通过工具看和动；未经策略的动作出不去。
- **带教落盘**：LEARN v2 + `coach-log.jsonl`（说明驱动）；能脚本化的进 `~/.dsh/skills/…/scripts/`（L3 确认）。详见 [docs/11-teach-refactor.md](docs/11-teach-refactor.md)。

记忆分层（[docs/09-memory.md](docs/09-memory.md)）：

```
profile.md → episodes/*.jsonl → SKILL.md → scripts/
（事实）      （只追加证据）        （技能）     （确定性步骤）
```

---

## 安装

本机通常没有 `dsh` CLI，走 GUI：

```
Harness「插件」→ 从 Git 安装 → https://gitee.com/YinchaoLi/dsh-pet-enhance.git
Harness「插件」→ 从目录安装 → 仓库根（含 package.json）或 packages/dsh-pet-enhance
```

装完**重启宿主**，再检查：

1. `~/.dsh/profiles/desktop` 的 bundles / `node_modules/dsh-pet-enhance` 已挂上（目录安装多为链接）；
2. 已装 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 时用它的形象与 L 对话（本插件不拷贝其 CC BY-NC-SA 素材）；
3. 新会话说「看一眼屏幕」能出图；外部浏览器打开 `/api/pet-enhance/status` **401 正常**（cookie 绑 Electron）。

失败看 `~/.dsh/pet-enhance-error.log`。改源码后须重启宿主才生效。开发循环：[docs/10-dev-process.md](docs/10-dev-process.md)。静态门：`node tools/dev-check.mjs`。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/01-research.md](docs/01-research.md) | 调研与本机实测 |
| [docs/02-product.md](docs/02-product.md) | 产品形态与用户故事 |
| [docs/03-architecture.md](docs/03-architecture.md) | 架构、sidecar、工具契约 |
| [docs/04-roadmap.md](docs/04-roadmap.md) | A–F 阶段与验收 |
| [docs/05-risks.md](docs/05-risks.md) | 风险、成本、隐私 |
| [docs/06-pet.md](docs/06-pet.md) | 宠物形象与状态 |
| [docs/07-safety.md](docs/07-safety.md) | 安全策略 |
| [docs/08-chat-voice.md](docs/08-chat-voice.md) | 聊天与语音（语音后续） |
| [docs/09-memory.md](docs/09-memory.md) | 记忆与技能包 |
| [docs/10-dev-process.md](docs/10-dev-process.md) | 开发流程与闸门 |
| [docs/11-teach-refactor.md](docs/11-teach-refactor.md) | **对话带教重构（现行教学设计）** |
| [CHANGELOG.md](CHANGELOG.md) | 用户可感知变更 |
| [AGENTS.md](AGENTS.md) | 给后续 agent 的硬约束 |

---

## 平台

| 平台 | 抓屏 | 输入 | 状态 |
|---|---|---|---|
| Windows 10/11 | Pillow / PrintWindow | `SendInput` | **主目标（已验证）** |
| macOS | `screencapture` / Quartz | CGEvent | 计划中 |
| Linux X11 | `import` / Xlib | XTest | 计划中 |
| Wayland | PipeWire 门户 | 受限 | 暂不支持输入注入 |

只做**软件层**注入（当前桌面会话），不碰硬件 HID。权限最小、可急停、可审计。
