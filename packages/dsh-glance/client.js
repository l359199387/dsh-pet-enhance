/**
 * dsh-glance —— 浏览器半身（B1：宠物出现）。
 *
 * 挂在 `shell.overlay`。
 *
 * 若本机已装 `dsh-pet`：隐藏自绘形象；
 * **单击宠物**打开 dsh-pet 自带对话弹窗（等同悬停按 L / 右键「对话」）；
 * 急停在右键「更多」。未装时用内置 SVG。
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-glance',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const {
      createElement: h,
      useCallback,
      useEffect,
      useRef,
      useState,
    } = React

    const API = '/api/glance'
    const DSH_PET = '/dsh-pet-7340'
    const STORAGE_POS = 'dsh-glance.pos'
    const STORAGE_SIZE = 'dsh-glance.size'
    const STORAGE_USE_PET = 'dsh-glance.useDshPet'
    const PET_SIZE = 128
    const DOCK_W = 168
    const DOCK_H = 44
    const inject = ['slots']

    const PET_HIT_SEL = '.dsh-pet-hit, .dsh-pet-stage, .dsh-pet-root'

    /** 事件是否点在 dsh-pet 上（含 shadow / 合成路径）。 */
    function eventOnDshPet(e) {
      const nodes = typeof e.composedPath === 'function' ? e.composedPath() : []
      for (const n of nodes) {
        if (!n || !n.classList) continue
        if (n.classList.contains('dsh-pet-hit')) return true
        if (n.classList.contains('dsh-pet-stage')) return true
        if (n.classList.contains('dsh-pet-root')) return true
      }
      const t = e.target
      if (t && typeof t.closest === 'function' && t.closest(PET_HIT_SEL)) return true
      return false
    }

    function dispatchKey(partial) {
      const doc = (typeof document !== 'undefined' && document)
        || globalThis.document
        || globalThis.window?.document
      if (!doc?.dispatchEvent) return null
      const init = { bubbles: true, cancelable: true, ...partial }
      let ev
      if (typeof KeyboardEvent === 'function') {
        try { ev = new KeyboardEvent('keydown', init) } catch { ev = { type: 'keydown', ...init } }
      } else {
        ev = { type: 'keydown', ...init }
      }
      doc.dispatchEvent(ev)
      return ev
    }

    /**
     * 打开 dsh-pet 自带对话弹窗（右键「对话」/ 悬停 L 那一套）。
     * - hover：刚点在宠物上，hover 仍为 true → 发裸 L（dsh-pet bindOpenChat）
     * - global：无悬停（如右下角按钮）→ Ctrl/Cmd+Shift+L（pet-chat.float）
     */
    function openDshPetNativeChat(mode = 'hover') {
      if (mode === 'global') {
        const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '')
        dispatchKey({
          key: 'l',
          code: 'KeyL',
          keyCode: 76,
          which: 76,
          ctrlKey: !isMac,
          metaKey: isMac,
          shiftKey: true,
          altKey: false,
        })
        return
      }
      // 裸 L：与菜单 hint「L 键」一致；要求指针仍停在宠物上（单击抬起时通常满足）
      dispatchKey({
        key: 'l',
        code: 'KeyL',
        keyCode: 76,
        which: 76,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      })
    }

    /**
     * 网页端单击（非拖拽）落在 dsh-pet → 打开原生对话。
     * 桌面独立窗的点击进不了本页；桌面请继续右键「对话」，或把显示位置设成含网页。
     */
    function bindDshPetClickToChat(onOpen) {
      let start = null
      const onDown = (e) => {
        if (e.button !== 0) return
        if (!eventOnDshPet(e)) return
        start = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
      }
      const onUp = (e) => {
        if (!start) return
        if (start.pointerId != null && e.pointerId !== start.pointerId) return
        const dx = e.clientX - start.x
        const dy = e.clientY - start.y
        start = null
        if (Math.hypot(dx, dy) > 6) return
        // 下一帧再发键：让 dsh-pet 先处理完 pointerup / click，hover 标记仍在
        window.setTimeout(() => onOpen?.(), 0)
      }
      const onCancel = (e) => {
        if (start && start.pointerId != null && e.pointerId !== start.pointerId) return
        start = null
      }
      document.addEventListener('pointerdown', onDown, true)
      document.addEventListener('pointerup', onUp, true)
      document.addEventListener('pointercancel', onCancel, true)
      return () => {
        document.removeEventListener('pointerdown', onDown, true)
        document.removeEventListener('pointerup', onUp, true)
        document.removeEventListener('pointercancel', onCancel, true)
      }
    }

    function clampDockPos() {
      const w = 148
      const h = 36
      const margin = 12
      return {
        x: Math.max(margin, window.innerWidth - w - margin),
        y: Math.max(margin, window.innerHeight - h - margin),
      }
    }

    const CSS = `
.dg-root {
  position: fixed;
  z-index: 2147483000;
  width: ${PET_SIZE}px;
  height: ${PET_SIZE}px;
  user-select: none;
  touch-action: none;
  --dg-panel: var(--dsw-alias-bg-overlay, rgba(20, 24, 32, 0.92));
  --dg-text: var(--dsw-alias-label-primary, #f2f4f8);
  --dg-muted: var(--dsw-alias-label-secondary, #9aa3b2);
  --dg-border: var(--dsw-alias-stroke-subtle, rgba(255,255,255,0.12));
  --dg-danger: var(--dsw-alias-status-danger, #e25555);
  --dg-accent: var(--dsw-alias-brand-primary, #3b82f6);
}
.dg-root * { box-sizing: border-box; }
.dg-pet {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: grab;
  filter: drop-shadow(0 10px 18px rgba(15, 40, 90, 0.35));
}
.dg-pet:active { cursor: grabbing; }
.dg-pet svg { display: block; width: 100%; height: 100%; overflow: visible; }
.dg-body {
  transform-origin: 64px 96px;
  animation: dg-breathe 3.2s ease-in-out infinite;
}
.dg-root[data-state="sleeping"] .dg-body { animation-duration: 4.8s; }
.dg-root[data-state="alarmed"] .dg-pet {
  animation: dg-startle 0.45s ease-in-out 0s 2;
}
.dg-root[data-state="alarmed"] .dg-ring {
  stroke: var(--dg-danger);
  stroke-opacity: 0.9;
}
.dg-eye-pair { transform-origin: 64px 52px; }
.dg-blink .dg-eye-pair { animation: dg-blink 120ms ease-in-out; }
.dg-gaze { transition: transform 80ms linear; }
.dg-arm-l, .dg-arm-r { transform-box: fill-box; transform-origin: center; }
.dg-root[data-state="acting"] .dg-arm-l,
.dg-root[data-state="acting"] .dg-arm-r {
  animation: dg-work 0.35s ease-in-out infinite alternate;
}
.dg-root[data-state="asking"] .dg-arm-l,
.dg-root[data-state="asking"] .dg-arm-r {
  transform: translateY(-7px);
}
.dg-tail { transform-origin: 92px 112px; animation: dg-tail 2.8s ease-in-out infinite; }
.dg-root[data-state="alarmed"] .dg-tail { animation-duration: 0.35s; }
.dg-fx { pointer-events: none; }
.dg-status {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  min-width: 140px;
  max-width: 220px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dg-panel);
  color: var(--dg-text);
  border: 1px solid var(--dg-border);
  font: 12px/1.35 ui-sans-serif, system-ui, sans-serif;
  opacity: 0;
  transform: translateY(4px);
  pointer-events: none;
  transition: opacity 120ms ease, transform 120ms ease;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dg-root:hover .dg-status,
.dg-root[data-open="1"] .dg-status { opacity: 1; transform: none; }
.dg-root[data-mode="chat"] {
  width: 280px;
  height: auto;
  min-height: 0;
}
.dg-root[data-mode="chat"] .dg-panel {
  position: relative;
  left: 0;
  right: auto;
  bottom: auto;
  width: 100%;
  margin: 0;
}
.dg-root[data-mode="dock"] {
  width: auto;
  height: auto;
  min-height: 0;
}
.dg-dock {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--dg-panel);
  color: var(--dg-text);
  border: 1px solid var(--dg-border);
  box-shadow: 0 8px 20px rgba(0,0,0,0.28);
  cursor: pointer;
  font: 600 12px/1.2 ui-sans-serif, system-ui, sans-serif;
}
.dg-dock:hover { filter: brightness(1.08); }
.dg-dock:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dg-accent) 70%, transparent);
  outline-offset: 2px;
}
.dg-status strong { font-weight: 600; }
.dg-status .dg-muted { color: var(--dg-muted); }
.dg-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 40px);
  width: 240px;
  padding: 8px;
  border-radius: 10px;
  background: var(--dg-panel);
  color: var(--dg-text);
  border: 1px solid var(--dg-border);
  box-shadow: 0 10px 28px rgba(0,0,0,0.28);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dg-panel textarea {
  width: 100%;
  min-height: 56px;
  resize: vertical;
  border: 1px solid var(--dg-border);
  border-radius: 8px;
  background: transparent;
  color: var(--dg-text);
  padding: 6px 8px;
  font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
}
.dg-panel textarea:focus { outline: 2px solid color-mix(in srgb, var(--dg-accent) 55%, transparent); outline-offset: 1px; }
.dg-row { display: flex; gap: 6px; align-items: center; }
.dg-btn {
  flex: 1;
  border: 1px solid var(--dg-border);
  background: transparent;
  color: var(--dg-text);
  border-radius: 8px;
  padding: 6px 8px;
  font: 12px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.dg-btn:hover { filter: brightness(1.08); }
.dg-btn.primary {
  background: var(--dg-accent);
  color: var(--dsw-alias-label-on-brand, #fff);
  border-color: transparent;
}
.dg-btn.danger {
  color: var(--dg-danger);
  border-color: color-mix(in srgb, var(--dg-danger) 45%, var(--dg-border));
  flex: 0 0 auto;
  min-width: 40px;
}
.dg-hint { font: 11px/1.35 ui-sans-serif, system-ui, sans-serif; color: var(--dg-muted); }
@keyframes dg-breathe {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.97); }
}
@keyframes dg-blink {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.1); }
}
@keyframes dg-startle {
  0%, 100% { transform: scale(1) translate(0,0); }
  25% { transform: scale(1.08) translate(-2px, 1px); }
  75% { transform: scale(1.08) translate(2px, -1px); }
}
@keyframes dg-work {
  from { transform: rotate(-12deg) translateY(0); }
  to { transform: rotate(12deg) translateY(-3px); }
}
@keyframes dg-tail {
  0%, 100% { transform: rotate(-4deg); }
  50% { transform: rotate(6deg); }
}
@keyframes dg-zzz {
  0% { opacity: 0; transform: translate(0, 0); }
  30% { opacity: 1; }
  100% { opacity: 0; transform: translate(10px, -16px); }
}
.dg-zzz { animation: dg-zzz 2.4s ease-in-out infinite; fill: #93C5FD; font: 12px ui-sans-serif, system-ui, sans-serif; }
`

    function readPos() {
      try {
        const raw = localStorage.getItem(STORAGE_POS)
        if (!raw) return null
        const pos = JSON.parse(raw)
        if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return null
        return { x: pos.x, y: pos.y }
      } catch {
        return null
      }
    }

    function writePos(pos) {
      try { localStorage.setItem(STORAGE_POS, JSON.stringify(pos)) } catch { /* 隐私模式等 */ }
    }

    function readUseDshPet() {
      try {
        const raw = localStorage.getItem(STORAGE_USE_PET)
        if (raw === null) return true
        return raw === '1' || raw === 'true'
      } catch {
        return true
      }
    }

    function writeUseDshPet(on) {
      try { localStorage.setItem(STORAGE_USE_PET, on ? '1' : '0') } catch { /* ignore */ }
    }

    function defaultPos(proxy) {
      const margin = 24
      const w = proxy ? DOCK_W : PET_SIZE
      const h = proxy ? DOCK_H : PET_SIZE
      // 有 dsh-pet 时控制条放左下，避免和右上角桌宠抢位（docs/06 §7）。
      if (proxy) {
        return { x: margin, y: Math.max(margin, window.innerHeight - h - margin) }
      }
      return {
        x: Math.max(margin, window.innerWidth - w - margin),
        y: Math.max(margin, window.innerHeight - h - margin),
      }
    }

    function clampPos(pos, proxy) {
      const margin = 8
      const w = proxy ? DOCK_W : PET_SIZE
      const h = proxy ? DOCK_H : PET_SIZE
      return {
        x: Math.min(Math.max(margin, pos.x), Math.max(margin, window.innerWidth - w - margin)),
        y: Math.min(Math.max(margin, pos.y), Math.max(margin, window.innerHeight - h - margin)),
      }
    }

    function workStatusFor(petState) {
      switch (petState) {
        case 'looking':
        case 'acting':
          return { state: 'working', task: 'glance' }
        case 'thinking':
          return { state: 'thinking', task: 'glance' }
        case 'asking':
          return { state: 'waiting', task: 'glance' }
        case 'alarmed':
          return { state: 'error', task: 'stop' }
        default:
          return null
      }
    }

    function stateLabel(state) {
      switch (state) {
        case 'looking': return '在看'
        case 'thinking': return '在想'
        case 'acting': return '在动手'
        case 'asking': return '在问你'
        case 'sleeping': return '睡着了'
        case 'alarmed': return '急停'
        default: return '发呆'
      }
    }

    function PetSvg({ state, pupil, blinking }) {
      const sleeping = state === 'sleeping'
      const mouth = state === 'alarmed'
        ? 'M58 66 Q64 62 70 66'
        : state === 'asking'
          ? 'M60 65 Q64 72 68 65'
          : 'M60 66 Q64 70 68 66'
      const gaze = { transform: `translate(${pupil.x}px, ${pupil.y}px)` }
      return h(
        'svg',
        { viewBox: '0 0 128 128', 'aria-hidden': true },
        h('defs', null,
          h('linearGradient', { id: 'dgHair', x1: '28', y1: '8', x2: '100', y2: '72', gradientUnits: 'userSpaceOnUse' },
            h('stop', { stopColor: '#7EC8FF' }),
            h('stop', { offset: '0.45', stopColor: '#3B82F6' }),
            h('stop', { offset: '1', stopColor: '#1D4ED8' }),
          ),
          h('linearGradient', { id: 'dgHoodie', x1: '40', y1: '72', x2: '88', y2: '118', gradientUnits: 'userSpaceOnUse' },
            h('stop', { stopColor: '#1E3A8A' }),
            h('stop', { offset: '1', stopColor: '#172554' }),
          ),
          h('linearGradient', { id: 'dgSkin', x1: '48', y1: '36', x2: '80', y2: '70', gradientUnits: 'userSpaceOnUse' },
            h('stop', { stopColor: '#FFE8D6' }),
            h('stop', { offset: '1', stopColor: '#FFD0B5' }),
          ),
          h('radialGradient', { id: 'dgIris', cx: '50%', cy: '40%', r: '60%' },
            h('stop', { stopColor: '#93C5FD' }),
            h('stop', { offset: '1', stopColor: '#1D4ED8' }),
          ),
        ),
        h(
          'g',
          { className: `dg-body${blinking ? ' dg-blink' : ''}` },
          h('circle', { className: 'dg-ring', cx: 64, cy: 64, r: 60, fill: 'none', stroke: 'transparent', strokeWidth: 3 }),
          h('g', { className: 'dg-tail' },
            h('path', { d: 'M86 96 C104 88 118 98 120 112 C108 108 98 112 92 118 C94 108 90 100 86 96Z', fill: 'url(#dgHair)' }),
            h('path', { d: 'M92 118 C96 122 102 124 108 122 C100 118 96 114 92 118Z', fill: '#60A5FA' }),
          ),
          h('path', { d: 'M46 78 C42 92 40 108 44 118 L84 118 C88 108 86 92 82 78 C72 74 56 74 46 78Z', fill: 'url(#dgHoodie)' }),
          h('path', { d: 'M48 78 C58 84 70 84 80 78 L78 88 C68 92 58 92 50 88Z', fill: '#312E81', opacity: 0.55 }),
          h('circle', { cx: 64, cy: 96, r: 7, fill: '#EFF6FF', opacity: 0.92 }),
          h('path', { d: 'M58 96 C60 93 68 93 70 96', stroke: '#93C5FD', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }),
          h('g', { className: 'dg-arm-l' },
            h('ellipse', { cx: 42, cy: 98, rx: 8, ry: 5.5, fill: 'url(#dgHoodie)', transform: 'rotate(-28 42 98)' }),
            h('ellipse', { cx: 36, cy: 100, rx: 4.2, ry: 3.4, fill: 'url(#dgSkin)', transform: 'rotate(-20 36 100)' }),
          ),
          h('g', { className: 'dg-arm-r' },
            h('ellipse', { cx: 86, cy: 98, rx: 8, ry: 5.5, fill: 'url(#dgHoodie)', transform: 'rotate(28 86 98)' }),
            h('ellipse', { cx: 92, cy: 100, rx: 4.2, ry: 3.4, fill: 'url(#dgSkin)', transform: 'rotate(20 92 100)' }),
          ),
          h('ellipse', { cx: 64, cy: 52, rx: 28, ry: 30, fill: 'url(#dgSkin)' }),
          h('path', { d: 'M36 48 C34 22 52 10 64 10 C76 10 94 22 92 48 C90 34 78 26 64 26 C50 26 38 34 36 48Z', fill: 'url(#dgHair)' }),
          h('path', { d: 'M36 46 C28 58 30 78 38 86 C34 68 34 56 38 48Z', fill: 'url(#dgHair)' }),
          h('path', { d: 'M92 46 C100 58 98 78 90 86 C94 68 94 56 90 48Z', fill: 'url(#dgHair)' }),
          h('path', { d: 'M40 42 C46 28 58 24 64 24 C70 24 82 28 88 42 C80 34 72 32 64 32 C56 32 48 34 40 42Z', fill: 'url(#dgHair)' }),
          h('path', { d: 'M34 34 C22 28 18 14 28 10 C32 18 34 26 38 32Z', fill: 'url(#dgHair)' }),
          h('path', { d: 'M94 34 C106 28 110 14 100 10 C96 18 94 26 90 32Z', fill: 'url(#dgHair)' }),
          h('path', { d: 'M64 12 C66 2 76 0 78 8 C72 6 68 10 66 16', stroke: 'url(#dgHair)', strokeWidth: 4, strokeLinecap: 'round', fill: 'none' }),
          h('ellipse', { cx: 48, cy: 62, rx: 6, ry: 3.2, fill: '#FF8FAB', opacity: 0.45 }),
          h('ellipse', { cx: 80, cy: 62, rx: 6, ry: 3.2, fill: '#FF8FAB', opacity: 0.45 }),
          h(
            'g',
            { className: 'dg-eye-pair' },
            sleeping
              ? [
                h('path', { key: 'l', d: 'M44 52 H60', stroke: '#1E3A8A', strokeWidth: 2.4, strokeLinecap: 'round', fill: 'none' }),
                h('path', { key: 'r', d: 'M68 52 H84', stroke: '#1E3A8A', strokeWidth: 2.4, strokeLinecap: 'round', fill: 'none' }),
              ]
              : [
                h('ellipse', { key: 'lw', cx: 52, cy: 52, rx: 8.5, ry: 9.5, fill: '#fff' }),
                h('ellipse', { key: 'rw', cx: 76, cy: 52, rx: 8.5, ry: 9.5, fill: '#fff' }),
                h('g', { key: 'lg', className: 'dg-gaze', style: gaze },
                  h('ellipse', { cx: 52.5, cy: 53, rx: 5.2, ry: 6, fill: 'url(#dgIris)' }),
                  h('circle', { cx: 52.5, cy: 53.5, r: 2.6, fill: '#0F172A' }),
                  h('circle', { cx: 50.2, cy: 50.2, r: 1.7, fill: '#fff' }),
                  h('circle', { cx: 54.8, cy: 55.5, r: 0.9, fill: '#fff', opacity: 0.85 }),
                ),
                h('g', { key: 'rg', className: 'dg-gaze', style: gaze },
                  h('ellipse', { cx: 76.5, cy: 53, rx: 5.2, ry: 6, fill: 'url(#dgIris)' }),
                  h('circle', { cx: 76.5, cy: 53.5, r: 2.6, fill: '#0F172A' }),
                  h('circle', { cx: 74.2, cy: 50.2, r: 1.7, fill: '#fff' }),
                  h('circle', { cx: 78.8, cy: 55.5, r: 0.9, fill: '#fff', opacity: 0.85 }),
                ),
              ],
          ),
          h('path', { d: 'M44 42 C48 40 52 40 56 42', stroke: '#1E3A8A', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none', opacity: 0.55 }),
          h('path', { d: 'M72 42 C76 40 80 40 84 42', stroke: '#1E3A8A', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none', opacity: 0.55 }),
          h('path', { d: mouth, stroke: '#E11D48', strokeWidth: 2, strokeLinecap: 'round', fill: 'none' }),
          state === 'thinking'
            ? h('g', { className: 'dg-fx' },
              h('circle', { cx: 100, cy: 28, r: 2.4, fill: '#93C5FD' }),
              h('circle', { cx: 108, cy: 20, r: 3.1, fill: '#60A5FA' }),
              h('circle', { cx: 118, cy: 14, r: 3.6, fill: '#3B82F6' }),
            )
            : null,
          state === 'alarmed'
            ? h('g', { className: 'dg-fx', stroke: '#E25555', strokeWidth: 2.2, strokeLinecap: 'round' },
              h('path', { d: 'M30 22 L24 12' }),
              h('path', { d: 'M40 16 L40 6' }),
              h('path', { d: 'M50 22 L56 12' }),
            )
            : null,
          sleeping ? h('text', { className: 'dg-zzz', x: 96, y: 28 }, 'z') : null,
        ),
      )
    }

    function PetOverlay() {
      const rootRef = useRef(null)
      const dragRef = useRef(null)
      const [useDshPet, setUseDshPet] = useState(() => readUseDshPet())
      const [dshPetOk, setDshPetOk] = useState(false)
      const proxy = Boolean(useDshPet && dshPetOk)
      const [pos, setPos] = useState(() => clampPos(readPos() || defaultPos(false), false))
      const [open, setOpen] = useState(false)
      const [draft, setDraft] = useState('')
      const [petState, setPetState] = useState('idle')
      const [windowTitle, setWindowTitle] = useState('')
      const [pupil, setPupil] = useState({ x: 0, y: 0 })
      const [blinking, setBlinking] = useState(false)
      const [busy, setBusy] = useState(false)
      const [hint, setHint] = useState(
        '点宠物打开对话（同右键「对话」/ L）。桌面独立窗同样单击即可（需重载过 Helper）。',
      )

      useEffect(() => {
        setPos((p) => clampPos(p, false))
      }, [])

      useEffect(() => {
        const onResize = () => setPos((p) => clampPos(p, false))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      useEffect(() => {
        let cancelled = false
        let timer = 0

        async function poll() {
          try {
            const res = await fetch(`${API}/state`, { credentials: 'same-origin' })
            if (!res.ok) return
            const body = await res.json()
            if (cancelled || !body?.ok) return
            const next = body.pet?.state?.data
            if (typeof next === 'string') setPetState(next)
            const win = body.side?.window?.data
            setWindowTitle(win?.title ? String(win.title) : '')
            if (body.dshPet) setDshPetOk(Boolean(body.dshPet.available))
          } catch {
            // Host 暂时不可达就保持本地状态
          }

          try {
            const petRes = await fetch(`${DSH_PET}/state`, { credentials: 'same-origin' })
            if (!cancelled) setDshPetOk(petRes.ok)
          } catch {
            if (!cancelled) setDshPetOk(false)
          } finally {
            if (!cancelled) timer = window.setTimeout(poll, 2500)
          }
        }

        poll()
        return () => {
          cancelled = true
          window.clearTimeout(timer)
        }
      }, [])

      useEffect(() => {
        if (!proxy) return undefined
        return bindDshPetClickToChat(() => openDshPetNativeChat('hover'))
      }, [proxy])

      useEffect(() => {
        if (proxy) return undefined
        let alive = true
        let timer = 0
        const schedule = () => {
          const wait = 3000 + Math.random() * 5000
          timer = window.setTimeout(() => {
            if (!alive || petState === 'sleeping') {
              schedule()
              return
            }
            setBlinking(true)
            window.setTimeout(() => {
              if (alive) setBlinking(false)
              schedule()
            }, 120)
          }, wait)
        }
        schedule()
        return () => {
          alive = false
          window.clearTimeout(timer)
        }
      }, [petState, proxy])

      useEffect(() => {
        if (petState !== 'alarmed') return undefined
        const t = window.setTimeout(() => {
          setPetState('idle')
          fetch(`${API}/pet`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state: 'idle' }),
          }).catch(() => {})
        }, 3000)
        return () => window.clearTimeout(t)
      }, [petState])

      useEffect(() => {
        if (proxy) return undefined
        const onMove = (e) => {
          const el = rootRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          const cx = rect.left + rect.width / 2
          const cy = rect.top + rect.height * 0.45
          const dx = e.clientX - cx
          const dy = e.clientY - cy
          const len = Math.hypot(dx, dy) || 1
          const max = 2.8
          setPupil({
            x: (dx / len) * Math.min(max, len / 70),
            y: (dy / len) * Math.min(max, len / 70),
          })
        }
        window.addEventListener('pointermove', onMove, { passive: true })
        return () => window.removeEventListener('pointermove', onMove)
      }, [proxy])

      const onPointerDown = useCallback((e) => {
        if (e.button !== 0) return
        const target = e.target
        if (target?.closest?.('.dg-panel') || target?.closest?.('.dg-btn')) return
        e.currentTarget.setPointerCapture?.(e.pointerId)
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          orig: pos,
          moved: false,
        }
      }, [pos])

      const onPointerMove = useCallback((e) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== e.pointerId) return
        const dx = e.clientX - drag.startX
        const dy = e.clientY - drag.startY
        if (Math.hypot(dx, dy) > 4) drag.moved = true
        if (!drag.moved) return
        const next = clampPos({ x: drag.orig.x + dx, y: drag.orig.y + dy }, false)
        setPos(next)
      }, [])

      const onPointerUp = useCallback((e) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== e.pointerId) return
        dragRef.current = null
        try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* ignore */ }
        if (drag.moved) {
          writePos(pos)
          return
        }
        setOpen((v) => !v)
      }, [pos])

      const stop = useCallback(async () => {
        setPetState('alarmed')
        setHint('已急停。')
        try {
          await fetch(`${API}/stop`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        } catch {
          setHint('急停信号没送到 Host，本地已进入炸毛。')
        }
      }, [])

      const sleepToggle = useCallback(async () => {
        const next = petState === 'sleeping' ? 'idle' : 'sleeping'
        setPetState(next)
        try {
          await fetch(`${API}/pet`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state: next }),
          })
        } catch { /* 本地状态已改 */ }
      }, [petState])

      const toggleAvatar = useCallback(() => {
        const next = !useDshPet
        setUseDshPet(next)
        writeUseDshPet(next)
        setHint(next
          ? (dshPetOk
            ? '已让位给 dsh-pet：点一下打开右键「对话」同款弹窗。'
            : '勾选了，但还没探测到 dsh-pet；请先安装并启用。')
          : '改用内置 SVG 小蓝鲸。')
      }, [useDshPet, dshPetOk])

      const submit = useCallback(async () => {
        const text = draft.trim()
        if (!text || busy) return
        setDraft('')
        setBusy(true)
        setHint('小蓝鲸在想…')
        try {
          if (dshPetOk) {
            const res = await fetch(`${DSH_PET}/chat?pet=main&surface=any`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ message: text }),
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok || body?.ok === false) {
              const why = body?.reason || body?.message || `http-${res.status}`
              setHint(`对话失败：${why}`)
              return
            }
            const reply = typeof body?.text === 'string' ? body.text.trim() : ''
            setHint(reply || '已送出（回复会在宠物气泡里出现）。')
            return
          }
          setHint('还没装 dsh-pet，这句话只留在本地。装上后点宠物就能真聊，并触发看屏/动手。')
        } catch (e) {
          setHint(`对话异常：${e?.message ?? e}`)
        } finally {
          setBusy(false)
        }
      }, [draft, busy, dshPetOk])

      const statusText = windowTitle
        ? `看着 · ${windowTitle}`
        : `小蓝鲸 · ${stateLabel(petState)}`

      const chatPanel = open
        ? h('div', { className: 'dg-panel', onPointerDown: (e) => e.stopPropagation() },
          h('textarea', {
            value: draft,
            placeholder: '跟小蓝鲸说点什么…',
            disabled: busy,
            autoFocus: true,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Escape') setOpen(false)
            },
          }),
          h('div', { className: 'dg-row' },
            h('button', {
              type: 'button',
              className: 'dg-btn primary',
              disabled: busy,
              onClick: submit,
            }, busy ? '…' : '发送'),
            h('button', { type: 'button', className: 'dg-btn', onClick: sleepToggle },
              petState === 'sleeping' ? '叫醒' : '睡觉'),
            h('button', {
              type: 'button',
              className: 'dg-btn danger',
              title: '急停',
              'aria-label': '急停',
              onClick: stop,
            }, '⏹'),
          ),
          h('div', { className: 'dg-row' },
            h('button', {
              type: 'button',
              className: 'dg-btn',
              onClick: toggleAvatar,
              title: dshPetOk ? '让位给 dsh-pet（点宠物 = 右键对话）' : '未探测到 dsh-pet',
            }, useDshPet ? (dshPetOk ? '形象：dsh-pet' : '形象：等 dsh-pet') : '形象：内置'),
          ),
          h('div', { className: 'dg-hint' }, hint),
        )
        : null

      // 已装 dsh-pet：不抢形象；单击 → 原生「对话」弹窗；备援钮发 Ctrl+Shift+L。
      if (proxy) {
        const dock = clampDockPos()
        return h(
          'div',
          {
            ref: rootRef,
            className: 'dg-root',
            'data-mode': 'dock',
            style: { left: `${dock.x}px`, top: `${dock.y}px` },
          },
          h('button', {
            type: 'button',
            className: 'dg-dock',
            title: '打开 dsh-pet 对话（同 Ctrl+Shift+L / 右键「对话」）',
            'aria-label': '打开桌宠对话',
            onClick: () => openDshPetNativeChat('global'),
          }, '对话'),
        )
      }

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dg-root',
          'data-state': petState,
          'data-mode': 'self',
          'data-open': open ? '1' : '0',
          style: { left: `${pos.x}px`, top: `${pos.y}px` },
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
        },
        h('div', { className: 'dg-status', title: statusText },
          h('strong', null, '小蓝鲸'),
          h('span', { className: 'dg-muted' }, ` · ${stateLabel(petState)}`),
          windowTitle ? h('div', { className: 'dg-muted' }, windowTitle) : null,
        ),
        chatPanel,
        h('div', { className: 'dg-pet', role: 'img', 'aria-label': `小蓝鲸，${stateLabel(petState)}` },
          h(PetSvg, { state: petState, pupil, blinking }),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-glance')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-glance: styles')

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-glance-pet',
      }, () => h(PetOverlay)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-glance'
    exports.__test = {
      clampPos,
      defaultPos,
      stateLabel,
      workStatusFor,
      bindDshPetClickToChat,
      openDshPetNativeChat,
      eventOnDshPet,
      STORAGE_POS,
      STORAGE_USE_PET,
      PET_SIZE,
      DOCK_W,
    }
    return module.exports
  },
})
