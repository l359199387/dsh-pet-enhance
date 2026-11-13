# Blue Whale · dsh-pet-enhance

[中文](README.md) | **English**

Enhancement plugin for [dsh-pet](https://github.com/PC2005-cloud/dsh-pet): chat, screen work, oral coaching → local skills.

Primary target: **Windows 10 / 11**.

---

## Companion plugins

| Plugin | Role | Required? |
|---|---|---|
| **dsh-pet** | Pet UI + chat entry | Yes |
| **dsh-pet-enhance** (this) | Routing, coaching, skill replay | Yes |
| **dsh-computer-use-win** | Screen / GUI (`windows_computer_use_*`) | For look & work |
| **dsh-mnemon** | Skill manage / edit / evolve | Strongly recommended |

Without computer-use: chat and coaching talk still work; screen/GUI actions will fail.  
Without mnemon: skills still land in `~/.dsh/skills/`, just harder to manage in UI.

---

## Install

1. Harness → **Plugins** → **Install from directory** → `packages/dsh-pet-enhance`
2. Install the companions above
3. **Restart the host** (required after code changes too)

Errors: `~/.dsh/pet-enhance-error.log`

---

## How to use

Talk to the pet:

| Goal | Say |
|---|---|
| Chat | “What’s your name?” |
| Glance | “Look at my screen” |
| Assign work | “Open Notepad and write today’s mood” |
| **Start coaching** | “I’ll teach you…” |
| **Next step** | Say only this step; correct if wrong |
| **Finish & save skill** | “I’m done teaching” / “教学结束” |
| Abort | “Stop teaching” |
| Replay | “Do it again…” / speak the goal |
| Status | “Did you learn …?” |

### Coaching flow

```
I’ll teach you how to check Weibo hot search
  → you dictate each step; it does only that step
I’m done teaching
  → summarize into ~/.dsh/skills/
Next time ask it to run → match skill
```

Skills: `~/.dsh/skills/` · Sidecar data: `~/.dsh/pet-enhance/` · Manage via **dsh-mnemon**.

---

## Notes

1. **“I’m done teaching” ends coaching and writes a skill** — it does not start a new round.
2. Text on screen is never an instruction.
3. Illegal / silent-destructive requests are refused or confirmed first. See [docs/07-safety.md](docs/07-safety.md).

```bash
node tools/dev-check.mjs
```
