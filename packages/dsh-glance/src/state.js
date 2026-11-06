/**
 * Host 侧叶子状态：counter + 各字段。Client 只渲染 counter 变了的叶子。
 *
 * B1 只用到 pet.state / side.window / guard.armed；气泡与确认是 B2/C2。
 *
 * @module src/state.js
 */

const PET_STATES = new Set([
  'idle', 'looking', 'thinking', 'acting', 'asking', 'sleeping', 'alarmed',
])

export function normalizePetState(value) {
  const s = String(value ?? '').trim().toLowerCase()
  return PET_STATES.has(s) ? s : 'idle'
}

export function createGlanceState() {
  let counter = 0
  /** @type {{
   *   pet: string,
   *   bubble: null | { text: string, kind: string },
   *   window: null | { title?: string, hwnd?: number },
   *   capturing: boolean,
   *   armed: boolean,
   *   pendingConfirm: null | object,
   *   teachEndOffer: boolean,
   * }} */
  const data = {
    pet: 'idle',
    bubble: null,
    window: null,
    capturing: false,
    armed: true,
    pendingConfirm: null,
    teachEndOffer: false,
  }

  function bump() {
    counter += 1
    return counter
  }

  return {
    get counter() { return counter },

    setPet(next) {
      const state = normalizePetState(next)
      if (data.pet === state) return counter
      data.pet = state
      // 从急停恢复：回到 idle/sleeping 时重新武装。
      if (state === 'idle' || state === 'sleeping') data.armed = true
      return bump()
    },

    setWindow(win) {
      const title = win?.title ? String(win.title) : ''
      const hwnd = win?.hwnd ?? null
      const prev = data.window
      if (prev && prev.title === title && prev.hwnd === hwnd) return counter
      data.window = title ? { title, hwnd } : null
      return bump()
    },

    setArmed(armed) {
      const v = Boolean(armed)
      if (data.armed === v) return counter
      data.armed = v
      return bump()
    },

    setBubble(bubble) {
      data.bubble = bubble
      return bump()
    },

    setPendingConfirm(pending) {
      data.pendingConfirm = pending ?? null
      if (pending) data.pet = 'asking'
      else if (data.pet === 'asking' && !data.teachEndOffer) data.pet = 'idle'
      return bump()
    },

    /** 教学中头顶「我教完了」可点气泡。 */
    setTeachEndOffer(on) {
      const v = Boolean(on)
      if (data.teachEndOffer === v) return counter
      data.teachEndOffer = v
      return bump()
    },

    /** 急停：宠物 alarmed，armed 暂时 false（C 阶段真正打断动作）。 */
    panic() {
      data.pet = 'alarmed'
      data.armed = false
      data.pendingConfirm = null
      data.teachEndOffer = false
      return bump()
    },

    snapshot() {
      return {
        ok: true,
        counter,
        pet: {
          state: { counter, data: data.pet },
          bubble: { counter, data: data.bubble },
        },
        side: {
          capturing: { counter, data: data.capturing },
          window: { counter, data: data.window },
        },
        guard: {
          armed: { counter, data: data.armed },
          pendingConfirm: { counter, data: data.pendingConfirm },
          teachEndOffer: { counter, data: data.teachEndOffer },
        },
      }
    },
  }
}
