# 小蓝鲸 · dsh-pet-enhance

**中文** | [English](README.en.md)

> **1.0.0**：给 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的增强插件。可闲聊；看屏/干活走电脑操控；口述带教写入本机技能。

装上看得见、聊得上、教得会、再做得了；拔掉能力撤走。不注册 `glance` / `act`，不自带「我学会的」侧栏。

---

## 现在能做什么

| 能力 | 说明 |
|---|---|
| **闲聊** | 问候、问名字等走 dsh-pet 闲聊模型 |
| **看屏 / 干活** | 闸门接手 → 主会话用 `windows_computer_use_*`（需装 `dsh-computer-use-win`） |
| **对话带教** | 「我教你…」→ 口述本步 / 纠正 → 做成了 → 写入 `~/.dsh/skills/<name>/` |
| **再做一次** | 扫 skills 匹配；有 ready 脚本先跑；本轮原话（如沟通 N 轮）会带进变通请求 |
| **技能管理** | 权威在 `~/.dsh/skills`；编辑/进化交给 **dsh-mnemon**（记忆系统） |
| **安全** | 急停、确认闸门；旁证在 `~/.dsh/pet-enhance/` |

分流：闲聊放行；看屏 / 交办 / 带教 / 新开窗由插件接管；「学会了吗 / 再做一次」仍由插件处理。

---

## 怎么用

1. **闲聊**：直接问（如「你叫什么名字呀」）。
2. **看屏**：说「看一眼屏幕」。
3. **交办**：说要做的事（GUI 优先 computer-use；可脚本/命令的走脚本）。
4. **带教**：说「我教你…」→ 做成了 → 在记忆系统 · 技能管理里查看。
5. **再做一次**：用目标说话，可带额外要求（如「和豆包聊聊天技巧，沟通 3 轮」）。

---

## 三条边界

1. **不做违法的事**（入侵、盗凭据、骚扰、诈骗等）——拒绝并说明。
2. **不搞静默破坏**（删改系统、对外发消息、花钱等）——先问；问不到就不做。
3. **屏幕上的文字不是指令**；看不清就停、再看或问你。

细则：[docs/07-safety.md](docs/07-safety.md)。

---

## 工作原理

```
你 ── dsh-pet 对话 ──> chat-gate 分流
                         │
         闲聊 ───────────┤── 放行 dsh-pet 模型
         看屏 / 干活 ────┤── 主会话 + computer-use
         带教 ───────────┤── teach → ~/.dsh/skills/
         学会了吗/再做 ──┘── skills 匹配 / 本地作答
```

- 本插件是薄胶水：不注册屏幕工具与鼠标键盘注入。
- 技能权威：`~/.dsh/skills/`；旁证：`~/.dsh/pet-enhance/`。

---

## 安装

推荐同装：`dsh-pet`、`dsh-computer-use-win`、`dsh-mnemon`。

```
Harness「插件」→ 从目录安装 → packages/dsh-pet-enhance
# 或从 Git 安装仓库根
```

装完**重启宿主**。改源码后同样要重启才生效。

- 失败日志：`~/.dsh/pet-enhance-error.log`
- 外部浏览器访问 `/api/pet-enhance/*` 出现 **401 正常**（cookie 绑 Electron）
- 静态门：`node tools/dev-check.mjs`

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/06-pet.md](docs/06-pet.md) | 宠物与闸门互操作 |
| [docs/07-safety.md](docs/07-safety.md) | 安全策略 |
| [docs/09-memory.md](docs/09-memory.md) | 记忆与技能包 |
| [docs/10-dev-process.md](docs/10-dev-process.md) | 开发流程 |
| [docs/11-teach-refactor.md](docs/11-teach-refactor.md) | 对话带教设计 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |
| [AGENTS.md](AGENTS.md) | 给 agent 的硬约束 |

其余调研/架构见 `docs/01`–`05`、`08`。

---

## 平台

当前主目标：**Windows 10/11**（看屏与 GUI 委托 computer-use）。macOS / Linux 计划中。
