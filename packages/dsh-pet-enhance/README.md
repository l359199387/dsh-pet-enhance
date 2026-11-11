# dsh-pet-enhance

**中文** · UI language: 中文 / English（`settings.locale`；默认中文）

给 **dsh-pet** 的增强插件（小蓝鲸）：带教落盘到 `~/.dsh/skills`；看屏/GUI 委托 **dsh-computer-use-win**；技能管理/进化用 **dsh-mnemon**。

English project README: [../../README.en.md](../../README.en.md)

当前是 **0.6.0**：不注册 `glance` / `act`；无「我学会的」侧栏。对宠物说「看一眼」或交办 → 主会话 computer-use；教完写入本机技能，在记忆系统 · 技能管理里查看。

```
Harness「插件」页 → 从目录安装 → 选这个目录
```

装完重启宿主后：

1. 确认已装 `dsh-computer-use-win` 与（推荐）`dsh-mnemon`；
2. 「我教你…」做成了 → 检查 `~/.dsh/skills/<name>/SKILL.md`；
3. 「执行一下&lt;目标&gt;」应命中该技能（脚本优先）。

- 失败日志：`~/.dsh/pet-enhance-error.log`
- 数据目录：`~/.dsh/pet-enhance/`（会话/旁证；权威技能在 `~/.dsh/skills/`）
- 开发流程：仓库根 `docs/10-dev-process.md`

## 结构

| 文件 | 职责 |
|---|---|
| `src/index.js` | 入口：路由、桥接（不注册 glance/act，无 learned 面板 API） |
| `src/teach-skill.js` | 带教写 skill |
| `src/skill-match.js` | 「再做一次」扫盘匹配 |
| `src/computer-use-delegate.js` | 看屏/GUI 叫醒提示 |
| `client.js` | `shell.overlay` 小鲸鱼 |

## 测试

```
node ../../tools/dev-check.mjs
```
