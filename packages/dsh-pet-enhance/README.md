# dsh-pet-enhance

**1.0.0** · 小蓝鲸：给 **dsh-pet** 的增强插件。

- 闲聊放行 dsh-pet；看屏/干活委托 **dsh-computer-use-win**
- 带教写入 `~/.dsh/skills`；管理/进化用 **dsh-mnemon**
- 不注册 `glance` / `act`；无「我学会的」侧栏

完整说明见仓库根 [README.md](../../README.md) / [README.en.md](../../README.en.md)。

```
Harness「插件」→ 从目录安装 → 选这个目录 → 重启宿主
```

建议同装 `dsh-pet`、`dsh-computer-use-win`、`dsh-mnemon`。

1. 「我教你…」做成了 → `~/.dsh/skills/<name>/SKILL.md`
2. 「执行一下…」或带额外要求的口令 → 匹配技能（脚本优先；原话进变通请求）
3. 「你叫什么名字呀」→ 闲聊模型作答

| 路径 | 用途 |
|---|---|
| `~/.dsh/skills/` | 技能权威 |
| `~/.dsh/pet-enhance/` | 旁证 / 会话 |
| `~/.dsh/pet-enhance-error.log` | 失败日志 |

```
node ../../tools/dev-check.mjs
```
