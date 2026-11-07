# 10 · 开发流程：从「能装」到「能做完一件事」

> 01–09 回答「做成什么样」。这一篇回答**每天怎么干**：一次只推一个可验收的切片，每一步都有命令、有证据、有回滚。

## 1. 现在能不能开始：四个前置条件

| 条件 | 现状 | 影响 |
|---|---|---|
| Node / Python 运行时 | ✅ DSH 自带（PATH 上没有，必须写绝对路径） | 所有脚本都得走 `dsh-runtimes/...` |
| 版本控制 | ✅ 本机有 git 2.54（仓库已 `git init`） | 每完成一个切片就提交，能回滚 |
| 可安装的包 | ✅ `packages/dsh-pet-enhance/`（Sprint 0 骨架已就位） | 装不上就什么都验不了 |
| 插件安装通道 | ⚠️ **GUI「插件页 → 从目录安装」**（本机 PATH 无 `dsh` CLI） | 每次改完要重装或重启 DSH 才生效 |

**结论**：可以开始。但前两个阶段的工作不能并行——A 阶段没跑通（能看到真实截图），后面所有判断都是猜的。

## 2. 一个切片的固定循环（八步，不跳）

```
① 写一个最小切片  → ② node --check  → ③ dev-check 全绿  → ④ 装进 profile
                                                                      ↓
⑧ 记一笔（文档/CHANGELOG） ← ⑦ 卸干净检查 ← ⑥ 拔掉一次 ← ⑤ 按验收标准实测
```

| 步 | 做什么 | 命令 / 动作 | 通过标准 |
|---|---|---|---|
| ① | 只做一个可验收的最小切片 | — | 能一句话说出「这次验收什么」 |
| ② | 语法 | `node --check src/index.js` | 退出码 0 |
| ③ | 静态门 | `node tools/dev-check.mjs` | 全绿（见 §3） |
| ④ | 安装 | GUI 插件页 → 从目录安装 → 选 `packages/dsh-pet-enhance`；改代码后重启 DSH | profile `package.json` 的 `dsh.profile.bundles` 里有 `dsh-pet-enhance`，且 `node_modules/dsh-pet-enhance` 是链接 |
| ⑤ | 实测 | 按 04 的对应验收项逐条做 | 每条都有「看到什么」的记录，不是「应该行」 |
| ⑥ | 拔掉一次 | 插件页禁用 → 再启用 | 没有残留进程、路由 404、`~/.dsh/pet-enhance/` 不被继续写 |
| ⑦ | 卸载检查 | 卸载 → 查残留 | `node_modules/dsh-pet-enhance` 消失；`~/.dsh/pet-enhance/` 里的用户数据**保留**（可以搬回来） |
| ⑧ | 记录 | 更新 `CHANGELOG.md` + 相关文档的「实测」段 | 数字/坑写进文档，别留在对话里 |

**为什么⑥要单列**：热插拔是这个插件的卖点，也是它最容易坏的地方（裸 `setInterval`、裸 `spawn` 都会让「拔掉」变成「看起来拔掉了」）。每次切片都拔一次，问题当场暴露。

## 3. 环境事实（照抄，不要临场找）

**运行时（PATH 上没有，必须绝对路径）**

```
C:\Users\13591\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
C:\Users\13591\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
C:\Users\13591\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs
```

**安装会动的地方（排查时按这个顺序看）**

| 位置 | 里面是什么 |
|---|---|
| `~/.dsh/profiles/desktop/package.json` | 依赖列表 + `dsh.profile.bundles`——**装了没装看这里**（`dsh-pet-enhance` 出现在 bundles 里才是装了） |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | profile 自己的 patch（模型、UI、插件市场）。**本地目录安装的插件不会写进这里**，它的行由插件包内 `cordis.patch.yml` 在加载时插入 |
| `~/.dsh/profiles/desktop/node_modules/dsh-pet-enhance` | 实际被加载的代码（官方说本地目录安装是「链接 checkout」，不是拷贝；本机实测是**逐文件 junction**：`Get-Item …\dsh-pet-enhance | Select LinkType,Target`） |
| `~/.dsh/profiles/desktop/.plugin-manager/logs/operation-*/pnpm.log` | 安装失败的唯一现场 |
| `~/.dsh/pet-enhance-error.log` | 插件自己写的失败日志（硬约束 6） |

**注意**：链接 checkout 也好、副本也好，**宿主是启动时 import 的**。改完 `packages/` 里的源码必须重启宿主（或重装）才生效，否则你验的是旧进程里那份旧代码。这是本项目最容易浪费半小时的坑。

## 4. 仓库骨架（Sprint 0 已建）

```
packages/dsh-pet-enhance/
├── package.json          # name/version/type=module/main + dsh.bundle.patch
├── dsh.plugin.json       # 插件清单：entry.name + inject
├── cordis.patch.yml      # 一行 insert（profile 装进来就靠它）
├── src/
│   ├── index.js          # 入口：export name / inject / apply（只装配）
│   ├── trust.js          # /api/pet-enhance/* 的信任栅栏（前缀路由不经内核准入）
│   ├── log.js            # 写 ~/.dsh/pet-enhance-error.log（带 64KB 轮转）
│   ├── sidecar.js        # Python 进程 + JSON Lines + 握手/重建/退避
│   ├── capture.js        # sidecar 优先；PowerShell 整屏降级
│   ├── tool-spec.js      # glance 的参数/输出/说明（模型看到的就是这里）
│   └── tool-glance.js    # 抓一帧 → 存附件 → 交图
├── sidecar/
│   ├── glance.py         # hello/capture/windows/thumb/input/abort/quit
│   ├── input_win.py      # C1：SendInput + failsafe
│   ├── test_protocol.py  # 协议单测（不许动鼠标）
│   └── capture.ps1       # A1 的降级抓屏（DPI aware + 整屏 + 缩放）
├── test/                 # node --test：trust / apply / capture / tool-glance / sidecar / state
└── client.js             # B1：shell.overlay 悬浮小鲸鱼
```


每个文件的**唯一职责**：

- `index.js` 只做装配：建目录、注册路由、把服务接起来。业务逻辑一律放 `src/` 的其他文件。
- `trust.js` 是所有自定义前缀路由的**入口闸门**。不写它，任何本机进程都能改你的记忆和确认状态（见 07 §13）。
- `log.js` 只负责「失败留痕」，**不吞异常**：写完日志照样返回失败。
- `sidecar.js` 管进程与协议；像素与坐标换算在 Python 侧，Host 不自己算 DPI。
- `capture.js` 统一「给我一张 PNG」：有 sidecar 走它，整屏可退 PowerShell；窗口/区域没有退路。
- `tool-spec.js` 是模型看到的全部文案；`tool-glance.js` 是流程（抓 → 存 → 交）；两者分开，改文案不用碰逻辑。

`tools/dev-check.mjs` 是 §2 第③步的执行者：文件齐全 → JSON 可解析 → 全部 `node --check` → Python 编译 → 扫 `console.log` → 清单一致性。一条命令，退出码即结论。

## 5. 阶段闸门（操作化版）

04 写的是「验收标准」，这里是**每次开工前问自己的那一句**：

| 阶段 | 一句话 DoD | 冒烟动作（做不到就是没过） |
|---|---|---|
| **A1** | 能拿到一张真实的 PNG，并说清它是屏幕的哪一块 | `glance` 返回图；`meta.screen` 是物理像素、图宽 ≤ 档位画布宽；一张 2560×1440 的屏实测 500–600ms |
| **A2** | 单窗口抓取 + DPI 正确 | 缩放 125% 下抓窗口，图不糊、坐标不加倍 |
| **B1** | 宠物出现在右下角，能点、能拖 | 刷新页面它还在；拔插件它就消失 |
| **B2** | dsh-pet L 说「看一眼桌面」真看屏 | 冒泡描述画面；`episodes/` 多一行 |
| **B2** | 说一句话，气泡里有回答 | 关掉模型 → 有明确报错，不是静默 |
| **C1** | 能移动鼠标并读回位置 | 移到 (0,0) 再读，值是 (0,0) |
| **C2** | 每个 `act` 都过策略引擎 | 故意发 L3 动作，未确认被拒 |
| **C3** | 端到端记事本闭环 + 纪律 | 说「打开记事本写下今天日期保存到桌面再关掉」：glance→act→验证；失败重试一次；`actions.jsonl` 有记录；预算/急停有气泡 |
| **D** | watch 连续多帧不乱 | 连看 3 次，不重复同一张、不自杀式唤醒 |
| **E** | 语音与打包 | 关掉语音整套功能仍可用 |
| **F1–F4** | 见 09 §11 | 重启后还能想起教过的事 |

**闸门规则**：前一阶段没通过，不写后一阶段的代码。唯一的例外是「为了验证而临时搭的桩」，桩必须在同一次提交里标 `TODO(阶段X)` 并说明何时删。

## 6. 提交约定

- 一个切片一次提交；提交信息用 `A1: 抓全屏 PNG` 这种「阶段: 做了什么」。
- 提交前跑一遍 `tools/dev-check.mjs`，绿了才提交。
- `CHANGELOG.md` 只记**用户能感知的变化**和**实测数字**（例：`PrintWindow 30–80ms，Pillow 56ms`），不记「重构了 xxx」。
- 版本：开发期 `0.0.x`，首个可安装版本 `0.1.0`（对应 A 阶段通过）。

## 7. 故障排查顺序（照这个顺序，别跳）

1. **工具根本没出现** → 看 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有没有 `dsh-pet-enhance`；没有就是没装上。
2. **装上了但工具没出现** → 看 `~/.dsh/pet-enhance-error.log`；`apply` 里任何一次 throw 都会让整行静默失败。
3. **改了代码没变化** → 宿主持有旧进程：重启宿主（或重装插件）再看。
4. **安装就失败** → `.plugin-manager/logs/operation-*/pnpm.log`；常见是 `package.json` 里 `dsh.bundle.patch` 路径写错。
5. **路由 401 / 403 / 404** → 401 是 `/api` 前缀的鉴权门（外部浏览器没有 cookie，属正常，别去改 `trust.js`）；403 是 `trust.js` 在正常工作（不是 bug）；404 是前缀没匹配上，检查 `ROUTE_PREFIX` 与 `webServer.register` 的 `path` 是否一致。
6. **拔掉后还有东西在跑** → `Get-Process python` 看 sidecar；有残留就是某处注册没走 `ctx.effect`。

## 8. 回滚与卸载残留检查

**禁用 → 启用**（不卸载，验热插拔）：

- 插件页禁用后：`/api/pet-enhance/status` 应 404；宠物消失；`Get-Process python` 无新增。
- 再启用：不需要重启 DSH 就恢复（做不到就是注册没走 effect）。

**卸载**（验干净）：

- `~/.dsh/profiles/desktop/node_modules/dsh-pet-enhance` 消失；
- profile `package.json` 的 `dsh.profile.bundles` 里不再有 `dsh-pet-enhance`；
- `Get-Process python` 无残留 sidecar（卸载要真的停掉它，不能只停在文件层面）；
- `~/.dsh/pet-enhance/` **保留**（这是用户数据：profile、episodes、技能都在里面）；
- `~/.dsh/pet-enhance-error.log` 保留（下次装上还能看到上次为什么坏）。

## 9. 节奏

- **一次会话只推一个切片**，最多两个（同类小改）。切片太大，验收就会变成「看起来都行」。
- 每完成一个阶段，回头补 05 的风险表：新写法带来新风险（比如 A1 的抓屏频率、C1 的坐标换算），当下就写进 R 表，别攒。
- 每个阶段结束跑一次「拔插演练」（§8），这是唯一能证明「可热插拔」的方式。

## 10. 坑速查（写代码前扫一眼）

| 症状 | 原因 | 出处 |
|---|---|---|
| `Cannot find package '@deepseek-ai/dsh-tools'` | Host-only bundle import 了宿主自带的包（插件目录里没有它） | 硬约束 20 |
| `unsupported JSON schema: parameters.type must be a value schema object` | 用 `defineTool` 时把 `parameters` 写成了完整 JSON Schema；裸注册时反过来——必须写完整 JSON Schema | 硬约束 1 / 20 |
| 工具挂上了但模型调不动 / 参数校验报 schema 错 | `parameters` 留成了 `{ 属性: {type} }` 的 DSL 映射 | 硬约束 20 |
| `/api/pet-enhance/status` 返回 401 | 正常：`/api` 前缀要宿主签发的 cookie，外部浏览器没有 | 07 §13 |
| `ctx.attachments` 是 undefined / 报错 | 没写进 `inject`；`?.` 挡不住 get 陷阱 | 01 §1.2 |
| 抓到的图坐标偏一半 | 没开 `SetProcessDPIAware()` | 硬约束 10 |
| 模型自己叫醒自己 | 从后台往会话推图 | 硬约束 3 |
| 前缀路由谁都能访问 | 没写 `trust.js` 的闸门 | 07 §13 |
| 中文搜「桌面」搜不到 | 用了 `unicode61` / `trigram` | 硬约束 17 |
| 拔掉插件后还有东西在跑 | 裸 `setInterval` / 裸 `spawn` | 硬约束 4 |
