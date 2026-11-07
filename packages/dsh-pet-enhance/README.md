# dsh-pet-enhance

**中文** · UI language: 中文 / English（侧栏「我学会的」可切换；默认中文）

给 **dsh-pet** 的增强插件（小蓝鲸）：看得见、会说话、能动手。

English project README: [../../README.en.md](../../README.en.md)

当前是 **C2 + C3 纪律 + 教学建自动化**：任意鼠标键点击 / 滑轮起止截鼠标附近 400×400 并标注图内坐标喂模型学会（执行不用图），学完关实时看屏幕；写入学习文件↔自动化并登记 Harness（暂停）；教完不自动动手。C3 交办走 glance→act→验证、单步失败最多再试一次、动作预算/急停有明确气泡。启用动手：右键「更多」→ **允许动手 · 开**。验收剧本见仓库 `docs/04-roadmap.md` §C3。

```
Harness「插件」页 → 从目录安装 → 选这个目录
```

装完重启宿主后：

1. 新会话让模型调一次 `glance()`（外部浏览器打开 `/api/pet-enhance/status` 会 401，属正常）；
2. 再试 `glance({window:"…"})`，应只看到该窗口；找不到时会给出最多三个标题候选。

- 失败日志：`~/.dsh/pet-enhance-error.log`
- 数据目录：`~/.dsh/pet-enhance/`（可用 `DSH_PET_ENHANCE_HOME` 覆盖）
- 开发流程与阶段闸门：仓库根的 `docs/10-dev-process.md`

## 结构

| 文件 | 职责 |
|---|---|
| `src/index.js` | 入口：建目录、挂路由、挂工具、挂 sidecar（只装配） |
| `src/state.js` | 宠物叶子状态（counter） |
| `src/trust.js` | `/api/pet-enhance/*` 的信任栅栏 |
| `src/log.js` | 失败留痕（`~/.dsh/pet-enhance-error.log`） |
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
