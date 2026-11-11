# dsh-pet-enhance

**中文** · UI language: 中文 / English（侧栏「我学会的」可切换；默认中文）

给 **dsh-pet** 的增强插件（小蓝鲸）：看屏/GUI 委托 **dsh-computer-use-win**，带教与脚本仍在本插件。

English project README: [../../README.en.md](../../README.en.md)

当前是 **0.5.1**：不注册 `glance` / `act`。对宠物说「看一眼」或交办任务 → 叫醒主会话，用 `windows_computer_use_*`；有 ready 脚本仍优先跑脚本。需已安装 `dsh-computer-use-win` 并重启 DSH。验收见仓库 `docs/04-roadmap.md`。

```
Harness「插件」页 → 从目录安装 → 选这个目录
```

装完重启宿主后：

1. 确认本机已装 `dsh-computer-use-win`；
2. 对宠物说「看一眼屏幕」→ 主会话应调用 computer-use 观察工具，宠物气泡出文字结论；
3. 外部浏览器打开 `/api/pet-enhance/status` 会 401，属正常；在 Electron 窗口内可见 `glanceRemoved: true`、`computerUse: "delegated"`。

- 失败日志：`~/.dsh/pet-enhance-error.log`
- 数据目录：`~/.dsh/pet-enhance/`（可用 `DSH_PET_ENHANCE_HOME` 覆盖）
- 开发流程与阶段闸门：仓库根的 `docs/10-dev-process.md`

## 结构

| 文件 | 职责 |
|---|---|
| `src/index.js` | 入口：建目录、挂路由、桥接（不注册 glance/act） |
| `src/computer-use-delegate.js` | 薄胶水：安装探测 + 叫醒提示 |
| `src/chat-bridge.js` | 看屏意图 → 叫醒 computer-use 观察 |
| `src/agent-bridge.js` | 交办 → 叫醒 computer-use 操作 |
| `src/state.js` | 宠物叶子状态（counter） |
| `src/trust.js` | `/api/pet-enhance/*` 的信任栅栏 |
| `src/log.js` | 失败留痕 |
| `src/sidecar.js` / `tool-glance.js` 等 | 保留源码，本版本不装配 |

## 测试

```
node ../../tools/dev-check.mjs
```

会跑 `node --test`；`capture.test.mjs` / `sidecar.test.mjs` 在 Windows 上会真的抓屏或起 Python。协议单测：

```
python sidecar/test_protocol.py
```
