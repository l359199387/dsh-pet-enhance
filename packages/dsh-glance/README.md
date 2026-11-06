# dsh-glance

小瞥：DSH 的桌面宠物插件。看得见、会说话、能动手。

当前是 **A1**：装得上、拔得掉，`glance` 能抓一帧整屏交给模型。

```
Harness「插件」页 → 从目录安装 → 选这个目录
```

装完重启宿主，打开 `http://127.0.0.1:50521/api/glance/status` 应返回
`{ "ok": true, "stage": "A1", "tools": ["glance"] }`。

- 失败日志：`~/.dsh/glance-error.log`
- 数据目录：`~/.dsh/glance/`（可用 `DSH_GLANCE_HOME` 覆盖）
- 开发流程与阶段闸门：仓库根的 `docs/10-dev-process.md`

## 结构

| 文件 | 职责 |
|---|---|
| `src/index.js` | 入口：建目录、挂路由、挂工具（只装配） |
| `src/trust.js` | `/api/glance/*` 的信任栅栏 |
| `src/log.js` | 失败留痕（`~/.dsh/glance-error.log`） |
| `src/define.js` | 取宿主的 `defineTool` |
| `src/capture.js` | 起 PowerShell 抓整屏，拿回 PNG |
| `src/tool-spec.js` | 模型看到的参数、说明、输出 schema |
| `src/tool-glance.js` | 抓 → 存附件 → 交图 |
| `sidecar/capture.ps1` | DPI 感知的整屏抓取与缩放 |

## 测试

```
node ../../tools/dev-check.mjs
```

会跑 `node --test`，其中 `test/capture.test.mjs` 会真的抓一次屏（只在 Windows 上跑）。
