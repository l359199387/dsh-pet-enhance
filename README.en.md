# Blue Whale · dsh-pet-enhance

[中文](README.md) | **English**

> **A dsh-pet enhancement plugin**: on top of the desktop pet, it can see your screen, chat, and act on what you ask (mouse, keyboard, commands).

**Blue Whale** is not decoration. Point at something on screen and ask “what’s this?” — it can see. Say “change this setting to Chinese” — it can click for real. It also has boundaries: no illegal work, ask before destructive actions, and stop to ask when it can’t see clearly instead of guessing clicks.

This is a **hot-pluggable DeepSeek Harness plugin** (works with [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)). Install it to add screen vision and actuation to the pet; uninstall to remove those powers.

---

## What it can do

| Capability | Notes |
|---|---|
| **See** | Full screen / one window / a region; change-gated frames so a still screen costs almost nothing |
| **Speak** | Bubbles + expression + motion; quiet by default, speaks when it matters |
| **Chat** | Click to type; short-term chat memory in-session; longer memory via the layers below |
| **Act** | Move, click, drag, scroll, keys, type, focus windows (software `SendInput`) |
| **Reuse host tools** | Files/commands/scripts use DSH’s existing `read/write/edit/pwsh` tools |
| **Remember** | Teach once → local trajectory + `SKILL.md`; next time one sentence can recall it |
| **Judge** | Risk tiers, two-step confirm, panic stop, local verify before calling the model |

---

## Three hard boundaries

1. **No illegal work.** Breaking into others’ devices, stealing credentials, bypassing security, harassment, fraud, cracking — refuse and explain.
2. **No silent destruction.** Delete/overwrite/uninstall/shutdown/change system settings/message others/spend money — must ask first; no ask, no do.
3. **No pretending.** If it can’t see clearly (tiny text, dialogs, loading), stop and look again or ask you; **never guess-click**.

Full policy: [docs/07-safety.md](docs/07-safety.md) (Chinese).

---

## Docs index

Most design docs are currently in Chinese:

| Doc | Topic |
|---|---|
| [docs/01-research.md](docs/01-research.md) | Research notes (see-now / tts-bridge / dsh-pet) |
| [docs/02-product.md](docs/02-product.md) | Product shape & stories |
| [docs/03-architecture.md](docs/03-architecture.md) | Architecture |
| [docs/04-roadmap.md](docs/04-roadmap.md) | Roadmap |
| [docs/05-risks.md](docs/05-risks.md) | Risks & cost |
| [docs/06-pet.md](docs/06-pet.md) | Pet UX |
| [docs/07-safety.md](docs/07-safety.md) | Safety |
| [docs/08-chat-voice.md](docs/08-chat-voice.md) | Chat & voice |
| [docs/09-memory.md](docs/09-memory.md) | Memory & skills |
| [docs/10-dev-process.md](docs/10-dev-process.md) | Dev loop |
| [AGENTS.md](AGENTS.md) | Hard constraints for agents |

UI language (中文 / English) can be switched inside the **Learned** panel; default is Chinese.

---

## How it works

```
        You ── type / click / box ──> pet bubble
                                    │
                            ┌───────▼────────┐
                            │  Client half   │  shell.overlay: sprite / bubble / input
                            │  (browser)     │
                            └───────┬────────┘
                                    │ same-origin HTTP + one-time token
                            ┌───────▼────────┐
                            │  Host half     │  glance / act / pet / remember
                            │  (DSH process) │  policy + confirm + audit + memory
                            └───┬────────┬───┘
                    stdio JSON  │        │  ctx.attachments.saveImage
                    ┌───────────▼──┐  ┌──▼──────────────┐
                    │ Python sidecar│  │ Model (vision)  │
                    │ capture+input │  └─────────────────┘
                    └──────────────┘
```

- **Sidecar** only captures pixels and injects input. It does not know DSH or decide policy.
- **Host** decides: allowed? need confirm? succeeded? worth remembering?
- The **model** only sees/acts through tools; nothing unchecked by Host leaves the process.

---

## Install

GUI path (no `dsh` CLI required) — either:

```
Harness → Plugins → Install from Git → https://gitee.com/YinchaoLi/dsh-pet-enhance.git
Harness → Plugins → Install from folder → repo root (the folder that contains package.json)
```

The repo root declares `dsh.bundle`. Local development may also use `packages/dsh-pet-enhance`.

After install, restart the host and check:

1. Profile bundles list `dsh-pet-enhance`;
2. You see the pet (SVG fallback, or dsh-pet sprite if installed);
3. Saying “look at my screen” triggers `glance`. Opening `/api/pet-enhance/status` in an external browser returns 401 — expected.

On failure, see `~/.dsh/pet-enhance-error.log`. Dev loop: [docs/10-dev-process.md](docs/10-dev-process.md).

---

## Platforms

| Platform | Capture | Input | Status |
|---|---|---|---|
| Windows 10/11 | Pillow / PrintWindow | `SendInput` | Primary (verified) |
| macOS | `screencapture` / Quartz | CGEvent | Planned |
| Linux X11 | `import` / Xlib | XTest | Planned |
| Wayland | PipeWire portal | Limited | No input injection yet |

> Software-session input only (no Arduino/CH9329 hardware HID). Minimal privilege, panic-stoppable, auditable.
