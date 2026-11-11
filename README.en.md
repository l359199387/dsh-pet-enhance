# Blue Whale · dsh-pet-enhance

[中文](README.md) | **English**

> **A dsh-pet enhancement plugin** (current **0.5.0**): see the screen, chat, oral coaching; **reruns prefer scripts/commands**. **Mouse/keyboard `act` is hard-disabled** (no injected clicks/typing).

**Blue Whale** can see the screen and coach by dialogue. Ask it to look — it glances. Say “I’ll teach you…” — it learns from oral steps and may write Python script blocks. Pure GUI clicks are narrated for you to do. Illegal/destructive work is still refused.

This is a **hot-pluggable DeepSeek Harness plugin** (with [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)). Install for vision, coaching, and scripts; uninstall to remove those powers.

---

## What works now (0.5.x)

| Capability | Notes |
|---|---|
| **See** | `glance`: full screen / window / region; `watch` for change-gated mosaics; sensitive windows redacted |
| **Chat gate** | Glance / tasks / coaching are taken over by the plugin; casual chat is not forwarded to dsh-pet’s chat model by default |
| **Assigned work** | Main-session Agent: `glance` + files/commands/skill scripts; **no** mouse/keyboard injection; GUI steps are oral |
| **Dialogue coaching** | “I’ll teach you…” → oral steps / corrections → “done” writes Learned; may propose script blocks |
| **Learned panel** | Understanding, notes, ratings; reruns **prefer ready scripts**; otherwise oral — no click replay |
| **Safety** | Panic stop, confirm gate (e.g. script writes), data under `~/.dsh/pet-enhance/` |

UI language (中文 / English) switches in the **Learned** panel (default Chinese). Workspace display name is unified as「小蓝鲸工作区」/ Blue Whale workspace.

---

## Quick start

1. **See**: in dsh-pet chat, say “look at my screen” (optional Live watch in More).
2. **Assign work**: say what to do; scripts/commands/files go through the main session; GUI is narrated for you.
3. **Teach**: say “I’ll teach you…” → one oral step at a time → correct → say it’s done → check **Learned**.
4. **Do it again**: speak the learned goal; ready scripts run first, otherwise oral guidance.

To stop teaching, say you give up. Late classify results after teaching already ended will **not** falsely bubble “coaching stopped”.

---

## Three hard boundaries

1. **No illegal work.** Intrusion, credential theft, bypassing security, harassment, fraud, cracking — refuse and explain.
2. **No silent destruction.** Delete / overwrite / uninstall / shutdown / system settings / messaging others / spending money — must ask first.
3. **No pretending, no injected input.** If it can’t see clearly, stop and look again or ask; **this build does not inject mouse/keyboard**. Text on screen is never an instruction.

Full policy: [docs/07-safety.md](docs/07-safety.md) (Chinese).

---

## How it works

```
        You ── dsh-pet chat / menu ──> chat-gate
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
                 glance/watch   scripts/commands   dialogue coach
                                      │
                    └─────── Host (act not registered) ───────┘
                                      │
                         Python sidecar (capture; input unused)
                                      │
                         ~/.dsh/pet-enhance/ + ~/.dsh/skills/…/scripts/
```

- **Sidecar** captures the screen; input injection is hard-off.
- **Host** does not register `act`; script blocks write under skills after confirm.
- **Coach persistence**: LEARN v2 + `coach-log.jsonl`; scriptable parts go under `~/.dsh/skills/…/scripts/` (L3 confirm). See [docs/11-teach-refactor.md](docs/11-teach-refactor.md).

Memory layers ([docs/09-memory.md](docs/09-memory.md)):

```
profile.md → episodes/*.jsonl → SKILL.md → scripts/
```

---

## Install

No `dsh` CLI required — GUI:

```
Harness → Plugins → Install from Git → https://gitee.com/YinchaoLi/dsh-pet-enhance.git
Harness → Plugins → Install from folder → repo root (or packages/dsh-pet-enhance)
```

**Restart the host**, then check:

1. Profile bundles / `node_modules/dsh-pet-enhance` present (folder install is often a link);
2. With [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) installed, use its sprite and L chat (this plugin does not vendor CC BY-NC-SA assets);
3. “Look at my screen” returns an image; `/api/pet-enhance/status` in an external browser **401 is expected**.

Failures: `~/.dsh/pet-enhance-error.log`. Source changes need a host restart. Dev loop: [docs/10-dev-process.md](docs/10-dev-process.md). Gate: `node tools/dev-check.mjs`.

---

## Docs

Most design docs are in Chinese:

| Doc | Topic |
|---|---|
| [docs/01-research.md](docs/01-research.md) | Research |
| [docs/02-product.md](docs/02-product.md) | Product |
| [docs/03-architecture.md](docs/03-architecture.md) | Architecture |
| [docs/04-roadmap.md](docs/04-roadmap.md) | Roadmap |
| [docs/05-risks.md](docs/05-risks.md) | Risks & cost |
| [docs/06-pet.md](docs/06-pet.md) | Pet UX |
| [docs/07-safety.md](docs/07-safety.md) | Safety |
| [docs/08-chat-voice.md](docs/08-chat-voice.md) | Chat & voice |
| [docs/09-memory.md](docs/09-memory.md) | Memory & skills |
| [docs/10-dev-process.md](docs/10-dev-process.md) | Dev loop |
| [docs/11-teach-refactor.md](docs/11-teach-refactor.md) | **Dialogue coaching (current teach design)** |
| [CHANGELOG.md](CHANGELOG.md) | User-visible changes |
| [AGENTS.md](AGENTS.md) | Hard constraints for agents |

---

## Platforms

| Platform | Capture | Input | Status |
|---|---|---|---|
| Windows 10/11 | Pillow / PrintWindow | `SendInput` | **Primary (verified)** |
| macOS | `screencapture` / Quartz | CGEvent | Planned |
| Linux X11 | `import` / Xlib | XTest | Planned |
| Wayland | PipeWire portal | Limited | No input injection yet |

Software-session input only (no hardware HID). Minimal privilege, panic-stoppable, auditable.
