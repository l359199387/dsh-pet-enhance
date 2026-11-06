# dsh-glance

DSH 的桌面宠物插件「一瞥」。当前阶段：**Sprint 0（装得上、拔得掉）**。

```
GET /api/glance/status   →  { ok, name, version, stage, home, uptimeMs, tools }
```

开发流程与验收标准见仓库根目录的 `docs/10-dev-process.md`。

## 本地校验

```powershell
node ../../tools/dev-check.mjs
```

## 安装

GUI → 插件页 → 从目录安装 → 选择本目录（`packages/dsh-glance`）。
装完检查 `~/.dsh/profiles/desktop/cordis.patch.yml` 里有 `dsh-glance` 这条。
