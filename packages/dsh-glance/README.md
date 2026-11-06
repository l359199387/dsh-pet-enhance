# dsh-glance

小蓝鲸：DSH 的桌面宠物插件。看得见、会说话、能动手。

当前是 **C2**：抓屏 + dsh-pet L 看屏/干活桥 + `act`（策略分级、头顶气泡两步确认、审计、急停、动作后指纹校验；默认关闭动手）。启用：桌宠右键「更多」→ **允许动手 · 开**，或 `settings.json` 的 `actEnabled: true` / `DSH_GLANCE_ACT=1`。

```
Harness「插件」页 → 从目录安装 → 选这个目录
```

装完重启宿主后：

1. 新会话让模型调一次 `glance()`（外部浏览器打开 `/api/glance/status` 会 401，属正常）；
2. 再试 `glance({window:"…"})`，应只看到该窗口；找不到时会给出最多三个标题候选。

- 失败日志：`~/.dsh/glance-error.log`
- 数据目录：`~/.dsh/glance/`（可用 `DSH_GLANCE_HOME` 覆盖）
- 开发流程与阶段闸门：仓库根的 `docs/10-dev-process.md`

## 结构

| 文件 | 职责 |
|---|---|
| `src/index.js` | 入口：建目录、挂路由、挂工具、挂 sidecar（只装配） |
| `src/state.js` | 宠物叶子状态（counter） |
| `src/trust.js` | `/api/glance/*` 的信任栅栏 |
| `src/log.js` | 失败留痕（`~/.dsh/glance-error.log`） |
| `src/sidecar.js` | Python 进程 + JSON Lines 协议 + 重建退避 |
| `src/capture.js` | sidecar 优先，PowerShell 整屏降级 |
| `src/tool-spec.js` | 模型看到的参数、说明、输出 schema |
| `src/tool-glance.js` | 抓 → 存附件 → 交图 |
| `client.js` | `shell.overlay` 小鲸鱼 |
| `sidecar/glance.py` | 抓屏（Pillow / PrintWindow） |
| `sidecar/capture.ps1` | A1 降级：DPI 感知整屏 |

## 测试

```
node ../../tools/dev-check.mjs
```

会跑 `node --test`；`capture.test.mjs` / `sidecar.test.mjs` 在 Windows 上会真的抓屏或起 Python。协议单测：

```
python sidecar/test_protocol.py
```
