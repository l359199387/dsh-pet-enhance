# 11 · 教与学会重构：从「录宏」到「带教落盘」

> 本文是**开发文档**，不是愿景散文。回答三件事：现状为什么错、目标长什么样、按哪几刀改、每刀怎么验收。  
> 关联：[02 产品](02-product.md) · [06 宠物](06-pet.md) · [09 记忆](09-memory.md) · [04 路线](04-roadmap.md) · 实现：`src/teach-*.js` / `learned-*.js` / `sidecar/observe_win.py`

---

## 0. 一句话结论

在这个插件架构里**不存在技能习得（改权重）**，只存在**知识持久化 + 可复现能力落盘 + 工具授权下的重新规划**。  
当前「教」采的是像素轨迹，「用」却禁止盲打坐标——采集与消费错位。重构要把「教 / 学会」改成：

**语言说清 → 它逐步做成 → 成功后落盘「事项说明 + 最快路径」→ 能流程化的拆成多块 Python 脚本（一等能力）→ 下次按需执行对应脚本 / 系统能力，而不是点鼠标。**

**拍板（2026-11-09）**：鼠标点击录制 + 关键帧拼图的旧教学模式**整段删除**；唯一教学方式是对话指引带教。  
**拍板（2026-11-09）**：流程化知识沉淀为 **Python 脚本**（对齐 [09](09-memory.md) L4）；**按块拆分、可多个**，用到哪块执行哪个——不是塞进一个巨型 `run.py`。

---

## 1. 问题诊断（已用实现与实测对齐）

### 1.1 结构错位

| 层 | 现状 | 实际消费方需要的 |
|---|---|---|
| 采集 `observe` → `evidence.json` | `click x,y` + 窗口标题 | 目标、约束、语义步骤、成功判据 |
| `buildPublicPlan` | 对人友好的坐标摘要 | 对模型可迁移的说明 |
| `digestWithFrames` | ≤1 张 2×2 拼图 + 文字 → `OK:/FAST:` | 可验证的理解，而非一次 LLM 自称 |
| `LEARN.json` / skill | summary + fastPlan + 坐标 playbook | **事项说明**；坐标不应充当能力 |
| 执行 `shouldUseSmartRun` | 恒走变通，**禁止**复刻教学像素 | 与落盘形态一致的「说明驱动」 |

证据：`teach-store.js` 的 `buildPublicPlan` 只推坐标步骤；`teach-bridge.js` 的 digest 默认最多 1 张拼图；`teach-smart.js` 执行提示明确禁止绝对像素盲点。画图实测中 `fastPlan` 退回 `Win+R → mspaint`——示范未贡献增量，教学退化成复述先验。

### 1.2 附带故障（执行层，不解决零增量）

- `glance(window=…)` 与 `act focus` 共用 `resolve_window`（阈值 0.45、近乎同分歧义），但失败面不同 → 「看过 ≠ 能动」。
- `runs.json` 有 `rating` / `refined`；评价路径可改 summary，**无自测、不改证据、不保证下次成功**——反馈薄。

### 1.3 根因一句话

**用录宏传感器去喂「意图型执行引擎」**，再把 LLM 回的两行字叫做「学会了」。

---

## 2. 产品定调（先钉死，再写代码）

### 2.1 接受的事实

1. LEARN / skill / playbook 都是**提示词与结构化备忘**，不是模型能力。
2. 「学会」的唯一诚实含义：**曾经在可验证条件下做成过，并把做法用语言写下来。**
3. 大模型缺的是**接触系统的通道**（shell / 文件 / API / 快捷键 / glance+act），不是「怎么点鼠标」的示范像素。

### 2.2 选型：只做对话带教（A）；录宏删除

| 方案 | 含义 | 本重构 |
|---|---|---|
| **A. 教学 = 对话指引 + 带教成功** | 全程对话澄清/纠正/确认 → 它 glance/act → 说「做成了」才落盘 | **唯一路径** |
| ~~演示录制~~ | 人点鼠标 + observe 坐标/关键帧 + digest 拼图 | **删除**，无兼容开关 |
| B. GUI 语义宏（UIA） | name+role 可迁移步骤 | **刀 3 以后再说**；不是本阶段教学入口 |

消歧也用**对话**（「是画图不是画板」）或带教中它自己 `glance`，不再用人点击坐标当教材。

### 2.3 明确不做（本重构范围内）

| 不做 | 原因 |
|---|---|
| 微调 / 本地权重更新 | 超出插件边界 |
| 保留「我演示你录」或 `legacy-record` | 产品已拍板删除；半留半走只会继续误导验收 |
| 教学关键帧 / 2×2 digest 拼图 | 随录宏一并删除 |
| 未成功确认就写 verified learned | 违反 09 §「不能用模型自称学会」 |
| 无确认自动落 skill | 违反 02 / 硬约束 15 |
| 先上完整 UIA 再改 UX | 成本高；本阶段先把对话带教跑通 |

---

## 3. 目标流程（用户可感知）

**交互定调：全程对话，不靠头顶「做成了 / 还没有 / 放弃」按钮。**  
（L2/L3 动作确认仍走现有 Helper「好/不要」，那是安全确认，不是教学成功门。）

```
用户：「教你画一条线」
  ↓
对话澄清：目标 / 约束 / 成功标准（可多轮）
  ↓
【带教跑】它 glance / 系统能力 / 必要时 act
  ↓
用户用话纠正（「不对」「先用快捷键」「重来」）→ 同会话继续，log 追加
  ↓
用户说「做成了 / 学会了 / 可以记下来」→ 对话意图判定为 verified
  （说「算了 / 不教了」→ 放弃，不 verified）
  ↓
文字归纳 A + 明细写入 B
  ↓
【能力沉淀】各流程块可确定 → 拆成多个 `scripts/*.py`（每块 L3 确认 + --dry-run）
  → learned ↔ automation ↔ skill ↔ scripts/{块A,块B,…}.py
  ↓
下次：按目标选用需要的脚本组合 / 系统能力；缺块再读 A；细节翻 B
```

### 3.1 对话意图（代替按钮；**模型理解，不写死口令**）

带教中每句经 `classifyCoachUtterance`（短提示、禁工具）判标签，**禁止**用用户话正则写死「做成了/不对/算了」。

| 标签 | 语义（给模型） | 系统行为 |
|---|---|---|
| `done` | 主人认为已做成、可记成学会 | 归纳 A，写 B，`coach.status=verified` |
| `correct` | 纠正做法、要求改步骤、同会话继续 | 不落 verified；写入 log/constraints；再带教一轮 |
| `abort` | 放弃本轮带教 | 结束；不 verified |
| `guide` | 继续说明目标/补充细节 | 追加 log，继续动手 |

示例说法仅作文档说明，**不是**匹配表。无教学专用按钮。

与现状对比：

| | 旧（删除） | 新（唯一） |
|---|---|---|
| 教的主体 | 人演示鼠标 + 截关键帧 | 人说话，它动手 |
| 结束方式 | 头顶「我教完了」→ 停录制 → digest | **对话**说做成了 / 纠正 / 放弃 → 文字归纳 |
| 实时看屏幕 / observe | 教学强依赖开录 | **教学不再调用**；带教用普通 `glance` |
| 学会判据 | LLM 回 OK | **做成过** + 用户对话确认 |
| 落盘核心 | 坐标 playbook + FAST | 事项说明 + FAST + **可沉淀的 py 脚本** |
| 再执行 | 变通点鼠标 | **脚本 / 系统能力优先**；鼠标兜底 |

---

## 4. 带教要记录什么（已拍板）

原则：

1. **只做真实带教**：须实际走过 glance/act（或等价系统能力），用户**用对话**确认「做成了」后才 `verified`。  
2. **全程对话**：教学成功/纠正/放弃不靠专用按钮；靠分流识别用户话（见 §3.1）。  
3. **少点鼠标**：优先 shell / 文件 / URL / 快捷键 / 应用名启动等系统自带能力；坐标易变、易算错，**不当技能、不当默认手段**。  
4. **三层落盘**：A = 事项说明；B = 长期明细；**S = 一组可拆分的 Python 脚本（按块能力，一等公民）**。  
5. **同会话累加**：一次带教一条学会、一份 `coach-log`；中间多次纠正只追加 log、`attemptCount++`，不新开 id。  
6. **能流程化就按块脚本化**：验证成功后，把可确定的子流程**拆开**写入多个 `scripts/*.py`（见 §4.6）；不是一个脚本包打天下。纯开放式 GUI 探索可只留 A+B。

### 4.0 路径

| 文件 | 角色 |
|---|---|
| `learned/<id>/LEARN.json` | **A** 权威摘要（v2）+ 脚本目录索引 |
| `learned/<id>/coach-log.jsonl` | **B** 带教过程明细，**长期保留** |
| `~/.dsh/skills/<name>/SKILL.md` | 说明何时调用哪块脚本 |
| `~/.dsh/skills/<name>/scripts/*.py` | **S** 多块流程能力（一文件一块） |
| `automations/<id>/…` | 与 learned 1:1；可引用 skill/脚本目录 |
| ~~教学 frames / 坐标 evidence~~ | **不写**；旧盘残留只读展示 |

能力优先级（下次执行）：

```
按需选用 S 中相关脚本（可先 --dry-run）> 系统命令/文件/URL（fastPlan）> 读 A 变通 > 必要时 glance+act
翻 B 仅作参考，不当坐标剧本
```

### 4.1 A · LEARN 最小集（执行只看这些）

```json
{
  "v": 2,
  "id": "…",
  "kind": "learned",
  "goal": "用画图画一条线",
  "understanding": {
    "summary": "打开画图，选铅笔工具，在画布上拖出一条线。",
    "fastPlan": "Win+R → mspaint → …（优先非鼠标路径）",
    "constraints": ["用铅笔不是刷子", "尽量快捷键/命令，少盲点"],
    "success": "画布上可见笔画；或用户确认做成了",
    "approach": "smart"
  },
  "coach": {
    "status": "verified",
    "verifiedAt": "ISO",
    "attemptCount": 1,
    "lastFailure": null
  },
  "coachLog": "coach-log.jsonl",
  "capability": {
    "skillName": "daily-note",
    "scripts": [
      {
        "id": "ensure-dir",
        "path": "scripts/ensure_desktop_dir.py",
        "purpose": "确保桌面笔记目录存在",
        "status": "ready"
      },
      {
        "id": "write-note",
        "path": "scripts/write_today_note.py",
        "purpose": "写入今日笔记正文",
        "status": "ready"
      }
    ]
  },
  "automationId": "…",
  "createdAt": "…",
  "updatedAt": "…"
}
```

| 字段 | 记什么 |
|---|---|
| `goal` | 开场对齐后的一句话目标 |
| `understanding.summary` | 带教结束后的事项说明 |
| `understanding.fastPlan` | 更快路径；可写「先 ensure-dir 再 write-note」这类**编排提示** |
| `understanding.constraints` | 纠正与禁区 |
| `understanding.success` | 成功标准 |
| `coach.*` | 是否验证、时间、尝试轮次、最近失败摘要 |
| `capability.scripts[]` | **多块**脚本目录：`id` / `path` / `purpose` / `status` |

**A 中禁止**：可执行 click 坐标列表、关键帧路径、把像素当步骤。

### 4.2 B · coach-log 长期明细（执行可参考）

追加写 `coach-log.jsonl`，**不随归纳删除**。侧栏 / 执行遇到疑问时可展开看「当时到底怎么做成的」，地位接近 skill 附录。

每行一类事件（示意）：

| `kind` | 内容 |
|---|---|
| `utterance` | 用户/助手对话原文（敏感输入脱敏） |
| `clarify` | 已对齐的目的 / 成功标准 / 是否同意快捷方式 |
| `tool` | 文字化工具轨迹：`glance` / `act` / 其它；含结果 ok/失败原因 |
| `correct` | 用户纠正（「不对，先……」） |
| `gate` | 对话判定的做成了 / 继续纠正 / 放弃 + 原话摘要 + 时间 |
| `induce` | 归纳出的 summary/fastPlan 快照（便于对照 A） |
| `script` | 某块脚本的草稿路径、dry-run、确认/拒绝（可多条） |

工具轨迹纪律：

- **可以**记下当次操作痕迹（含若不得不 click 时的坐标），供人翻明细。  
- **不可**把这些坐标提升为 A 的可执行步骤，也**不可**写进 Python 脚本当「标准点击坐标」。  
- 归纳与下次执行：**按 purpose 选用需要的脚本块**；否则优先 fastPlan；禁止按日志坐标盲点。

### 4.3 C · 明确不记

| 不记 | 原因 |
|---|---|
| 教学专用关键帧 / 2×2 digest | 已删录宏 |
| 坐标可执行 playbook | 易变、易错；与「少鼠标」冲突 |
| 密码等敏感正文 | 只记占位 |
| glance 原图进 LEARN | 仅当轮给模型看 |
| 未真实带教就 verified | 已拍板 |

### 4.4 字段纪律与兼容

| 字段 | 纪律 |
|---|---|
| `understanding.*` | 编排与语义；说明「何时用哪块脚本」 |
| `capability.scripts[]` + `skills/.../scripts/*.py` | **分块能力权威**；`ready` 的块可按需执行 |
| `coach-log.jsonl` | 长期参考；需要时可读，默认不整份塞进模型 |
| `coach.status` | 仅 `verified` 可被「再做一次」默认命中 |

- 读盘：`v:1` 旧录制条目可展示，按 understanding 执行；标「旧版录制」。  
- 写盘：只写 v2 + coach-log（+ 可选脚本）；不再 observe / teach-frames / digest 拼图。

### 4.5 同会话累加（已拍板）

一次「教你做 X」从开场到「做成了」或「算了」= **一个 coach 会话**、**一个将来的 learned id**、**一份** `coach-log.jsonl`。

- 用户说「不对 / 重来 / 还没好」→ 同一会话继续；log 追加；`attemptCount` 增加。  
- 用户说「做成了」→ 封板 verified；若可流程化则进入脚本提炼（§4.6）。  
- 用户说「算了」→ 结束且不 verified。  
- **不**因纠正失败就新开 learned id（避免明细拆散、对照困难）。

### 4.6 S · 多块 Python 脚本作为一等能力（已拍板）

流程化的东西**不能只停在提示词**，也**不要合成一个万能脚本**。  
带教里每块可确定、可复用的子流程 → **各自一个** `scripts/<块>.py`；执行时按目标**选用需要的那几个**。

| 项 | 约定 |
|---|---|
| 拆分原则 | **一块流程一个脚本**（单一职责）；共享工具可再抽 `scripts/lib_*.py`，但对外能力仍按块暴露 |
| 何时提炼 | `verified` 之后；某子步骤确定、可参数化、不依赖易变像素 → **按块**提炼，不必等「整件事一个脚本」 |
| 放哪 | `~/.dsh/skills/<name>/scripts/*.py`；LEARN.`capability.scripts[]` 做目录（id/path/purpose/status） |
| 必须 | 每个可执行脚本支持 `--dry-run`；人可读；写入前旧版进 `.history/` |
| 确认 | **每个**新脚本 / 改脚本 = **L3**；模型不能自证 |
| 禁止 | 绝对坐标当标准答案；旁路 `act` 另开输入通道；把无关步骤塞进同一文件「图省事」 |
| 运行时 | DSH 自带 `python.exe`（见 AGENTS / 10） |
| 与 A/B 关系 | S = 分块能力；A = 编排（用哪几块、顺序/条件）；B = 当初试错明细 |
| 下次执行 | 根据 goal/A 选出 `ready` 脚本子集 → 按需执行（可先 dry-run）；缺块或失败再回退 A 变通 |

**示例：教「每日桌面笔记」可拆成**

| 脚本 id | 文件 | 何时用 |
|---|---|---|
| `ensure-dir` | `ensure_desktop_dir.py` | 只要保证目录在 |
| `write-note` | `write_today_note.py` | 只要写今日内容 |
| （可选）`open-note` | `open_in_editor.py` | 用户说「打开看看」时才跑 |

再执行「写笔记」→ 只跑前两个；「打开昨天的」→ 可能只跑 `open-note`。**用到哪个执行哪个。**

**适合拆脚本 vs 暂不脚本**

| 适合按块脚本化 | 暂不脚本、只留 A+B |
|---|---|
| 写文件、改 CSV、调 API、建目录、启动并传参、固定快捷键段 | 强依赖看图辨位、一次性探索向导 |
| 整条任务里的**稳定子段**（即使前后还要 glance） | 整段都无法参数化的纯 GUI |

刀 2e（已落地雏形）：verified 后模型提议多块脚本 → L3 确认 → 写入 `skills/<slug>/scripts/*.py` + `capability.scripts[]`；执行时 `runReadyCoachScripts` 优先按块跑（先 dry-run）。无确认闸或不适合脚本则只留 A+B。

---

## 5. 开发切片（按刀推进，每刀可独立验收）

原则同 [10 开发流程](10-dev-process.md)：一次一切片；`dev-check` 绿；改完重启宿主再测；**不自动开定时任务**。

### 刀 1 · 拆掉录宏教学（删除旧路径）

**目标**：代码与 UX 上不再能进入「人点鼠标 + 截关键帧 + digest」；教学入口改为占位/指向带教（若刀 2 尚未合入，可先拒绝并提示「对话带教开发中」——**优先与刀 2a 同对话交付，避免空窗**）。

| 删除 / 停用 | 说明 |
|---|---|
| `observe` 教学轮询、`teach-frames`、点击附近截图 | 教学不再 `sidecar.observe` |
| `digestWithFrames` / 教学 2×2 拼图喂模型 | 整段删除或仅测残留清理 |
| 头顶「我教完了」录制结束 | **删除**；教学确认改对话意图（§3.1） |
| `buildPublicPlan` 作为学会主路径 | 可删或留纯函数仅服务旧数据只读迁移测试 |
| 相关单测里「录 16 步再 digest」场景 | 改写或删除 |

**预期动到的文件**

- `src/teach-bridge.js`（去 observe 主循环）
- `src/teach-frames.js`、`src/teach-digest.js`（删除或大幅掏空）
- `src/patch-dsh-pet-confirm.js`（教完了按钮）
- `sidecar/observe_win.py`：若**仅**服务教学，随教学删除；若另有用途先查引用再定
- `test/teach-*.mjs`、`docs/06-pet.md`、`CHANGELOG.md`

**验收**

1. 说「我教你…」**不会**再开 observe、不写 click evidence、不弹「我教完了」录制条。  
2. `dev-check` 全绿；无悬挂对已删模块的 import。  
3. 旧 `learned/*/evidence.json` 仍在磁盘，侧栏不把它当「已掌握步骤」展示。

---

### 刀 2 · 对话带教 UX（唯一教学实现）

**目标**：教 = **全程对话**澄清 + 它操作 + 对话确认做成了 + 文字归纳落盘。无教学专用成功门按钮。

| 子切片 | 做什么 | 验收要点 |
|---|---|---|
| **2a 状态机** | `teach` → 澄清 → `coaching` → 对话意图 `done/correct/abort` → verified 才 `createLearned` | meta 可读；同会话累加；急停可打断 |
| **2b 引导话术** | 最少问：目的、成功标准、能否快捷方式；纠正写入 constraints | 纯说话走完学会 |
| **2c 对话意图** | classify：做成了 / 继续纠正 / 放弃（§3.1）；**不**做头顶三按钮 | 未说做成了 → 不默认「再做一次」 |
| **2d 文字归纳** | 对话摘要 + 工具文字轨迹；**禁止**拼图 digest | summary 必有；fastPlan 可空 |
| **2e 脚本沉淀** | verified 后**按块**生成多个 `scripts/*.py`（各 dry-run + L3）；`capability.scripts[]` 目录 | 再执行按需选脚本；禁止单文件塞全流程；无坐标硬编码 |

**涉及模块（预期）**

- `teach-bridge.js`：coach 状态机。  
- `classify-utterance` / `chat-gate` / pet-router：做成了 / 纠正 / 放弃 / 纠正句留在 coach。  
- `agent-bridge`：coach 预算与确认（L2/L3 **安全**确认仍可走 Helper，与教学门禁分离）。  
- `learned-automation.js`：LEARN v2 + `coach-log.jsonl` + capability 指针。  
- 技能/脚本写入：对齐 09 promote / L2·L3 确认（可复用或接 F 阶段实现）。  
- 删除教学用「我教完了」气泡。

**验收剧本（必过）**

1. **纯语言带教**：记事本写日期存桌面 → 说「做成了」→ LEARN v2 → 「再做一次」成功。  
2. **纠正**：说「不对，先……」→ 同会话继续 → 再说做成了 → constraints 含要点。  
3. **放弃**：说「算了」→ 无 verified 默认命中。  
4. **安全**：F 级仍拒；急停 + `agent.cancel`。  
5. 旧 v1 只读可删可按 understanding 跑。  
6. **脚本（2e）**：可拆的子流程 → 多个 py + 目录；再执行只跑需要的块；每个支持 `--dry-run`。

---

### 刀 3 · 增强（可排后）

| 项 | 说明 | 依赖 |
|---|---|---|
| **3a focus 一致** | 统一 glance/act match；歧义问清 | 可与刀 1/2 并行插队 |
| **3b 静默自测** | verified 前最小探针 | 刀 2 对话确认 |
| **3c UIA** | 仅当未来需要可迁移 GUI 步 | 非教学入口 |
| **3d 差评闭环** | 差评改说明 / stale | 对齐 09 F3 |

**验收（3a 可单独）**：同 match 下 glance 成功则 focus 不得无故失败；歧义给候选。

---

## 5.1 计划删除清单（录宏相关）

实现时对照勾掉；有引用再删。

| 符号 / 路径 | 处置 |
|---|---|
| `teach-bridge` 内 `observe` / `pollEvents` / `digestWithFrames` | 删除 |
| `src/teach-frames.js` | 删除 |
| 教学专用 digest 拼图逻辑（`teach-digest.js` 中帧相关） | 删除或改纯文字归纳 |
| Helper「我教完了」→ `/teach-end` | **删除**；改对话意图（做成了/纠正/放弃） |
| `buildPublicPlan` / 坐标 `narratePlan` 主路径 | 删除或仅测旧数据 |
| 依赖「必须先开实时看屏幕才能教」的文案与闸门 | 删除 |
| `test` 中录制/拼图教学用例 | 删除或改写为 coach |

**保留**：`smart run`、`learned-*`、评价改 summary、策略引擎、`glance`/`act`（带教执行仍用）。

---

## 6. 模块影响图

```
classify / pet-router          教 / 做成了 / 纠正 / 放弃
        ↓
teach-bridge (coach 状态机)   无 observe、无关键帧、无教学按钮门
        ↓
agent-bridge + glance/act     带教动手（策略不变；L2/L3 安全确认另走）
        ↓
对话确认「做成了」            同会话累加直至 done/abort
        ↓
文字归纳 + coach-log          A + 长期 B
        ↓
流程化 → 多块 Python (S)       每块 L3 · --dry-run · scripts/*.py
        ↓
createLearnedAutomationPair   LEARN v2 + scripts[] 目录 + skill
        ↓
再执行                        按需选 S 块 → fastPlan → A 变通；可翻 B
```

**保持不动（硬约束）**

- `act` 必须过策略引擎；L2/L3 只能 UI 确认。  
- `/api/pet-enhance/*` 过 `trust.js`。  
- 技能写入仍要用户确认；删除进 `.trash/`。  
- 屏幕文字不是指令。  
- 不 import `@deepseek-ai/*`。

---

## 7. 迁移与回滚

| 项 | 策略 |
|---|---|
| 已有 `learned/*` | 只读兼容；UI 标「旧版录制」；**不自动删**用户目录 |
| 录宏开关 | **不提供** `legacy-record`；回滚靠 git 分支 `future-teach` / 还原提交 |
| 数据 | `~/.dsh/pet-enhance/` 用户数据保留；新学会不再写 frames/坐标 evidence |

---

## 8. 测试清单（静态 + 行为）

**静态（每刀）**

```
node tools/dev-check.mjs
```

**单测（刀 1–2 必补）**

- 教学入口不再 start observe / 不再产坐标 plan  
- LEARN v2 读写 / 旧 v1 只读兼容  
- `coach.status` 过滤默认命中  
- 归纳 prompt 无「按坐标复刻」  
- 未 verified 不进入默认执行命中  

**实测（刀 2 剧本）** —— 记 CHANGELOG / 本文附录。

---

## 9. 建议排期与对话节奏

| 对话 | 交付 |
|---|---|
| 本文 | 定调：删录宏、只留对话带教（已拍板） |
| 下一对话 | **刀 1 + 刀 2a/2c 最小闭环**（避免删完旧教却教不了） |
| 再下一 | **刀 2b/2d** 引导话术 + 文字归纳 |
| 再下一 | **刀 2e** 流程按块 → 多个 Python 脚本（对接 09 F4；按需执行） |
| 插队可选 | **刀 3a** focus（若挡带教实测） |

禁止：只删录宏却迟迟不交带教，导致「教」功能空窗过久。

---

## 10. 验收总标准（重构完成时）

1. 用户**只靠说话**带教成功，并「再做一次」成功。  
2. 仓库与运行时**不存在**教学录鼠标 / 教学关键帧 digest 路径。  
3. 侧栏展示理解与约束，不展示像素剧本当能力；有脚本时展示为**可执行能力**。  
4. 未 verified 不默认执行。  
5. 流程化任务能**按块**沉淀为多个带 `--dry-run` 的 Python 脚本；再执行按需选用，而不是一个巨脚本。  
6. 安全与急停不弱于现状；`dev-check` 全绿；06 / CHANGELOG 与行为一致。

---

## 11. 产品拍板记录

| # | 问题 | 结论 |
|---|---|---|
| 1 | 是否保留「我演示你录」/ `legacy-record`？ | **否，整段删除**（2026-11-09） |
| 2 | 能否跳过真实带教、口述直接学会？ | **否，只做真实带教**（2026-11-09） |
| 3 | LEARN 最小集 A？ | **通过**（goal/summary/fastPlan/constraints/success/coach 元数据） |
| 4 | 过程日志 B？ | **长期保留** `coach-log.jsonl`，作执行参考明细（2026-11-09） |
| 5 | 坐标？ | **不当技能**；尽量少鼠标，优先系统能力；坐标仅可出现在 B 痕迹里（2026-11-09） |
| 6 | 教学要不要「做成了/还没有/放弃」按钮？ | **不要**；全程对话；意图由**模型分流**（done/abort/correct/guide），禁止用户口令正则写死（2026-11-09） |
| 7 | 多次纠正如何记账？ | **同会话累加**（一份 log，`attemptCount++`）（2026-11-09） |
| 8 | 流程化知识形态？ | **按块多个 Python 脚本**，用到哪个执行哪个；非单文件包打天下（2026-11-09）；对齐 09 L4 |
| 9 | 刀 3a focus 是否并行？ | **待定** |

**文档状态**：全程对话、同会话累加、**脚本一等能力（§4.6）**已写入；下一步 `future-teach` 开刀 1+2（2e 可紧随或对接 F4）。
