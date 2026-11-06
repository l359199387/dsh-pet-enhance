/**
 * dsh-glance —— 浏览器半身（B1：宠物出现）。
 *
 * 挂在 `shell.overlay`：右下角一只可拖的小鲸鱼，呼吸/眨眼/随光标看；
 * 点击弹出输入框（聊天是 B2）；⏹ 急停先只改 UI / 打 Host `/stop`。
 *
 * 手写 ModuleLoader 包，无构建步骤；除 shell 已提供的 react 外无依赖。
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
    const STORAGE_POS = 'dsh-glance.pos'
    const STORAGE_SIZE = 'dsh-glance.size'
    const PET_SIZE = 96
    const inject = ['slots']

    const CSS = `
.dg-root {
  position: fixed;
  z-index: 2147483000;
  width: ${PET_SIZE}px;
  height: ${PET_SIZE}px;
  user-select: none;
  touch-action: none;
  --dg-body: var(--dsw-alias-brand-primary, #3b6fd9);
  --dg-eye: var(--dsw-alias-bg-layer-1, #fff);
  --dg-pupil: var(--dsw-alias-label-primary, #1a1a1a);
  --dg-panel: var(--dsw-alias-bg-overlay, rgba(20, 24, 32, 0.92));
  --dg-text: var(--dsw-alias-label-primary, #f2f4f8);
  --dg-muted: var(--dsw-alias-label-secondary, #9aa3b2);
  --dg-border: var(--dsw-alias-stroke-subtle, rgba(255,255,255,0.12));
  --dg-danger: var(--dsw-alias-status-danger, #e25555);
  --dg-blush: #ff8a9b;
}
.dg-root * { box-sizing: border-box; }
.dg-pet {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: grab;
  filter: drop-shadow(0 6px 12px rgba(0,0,0,0.28));
}
.dg-pet:active { cursor: grabbing; }
.dg-pet svg { display: block; width: 100%; height: 100%; overflow: visible; }
.dg-body {
  transform-origin: 48px 58px;
  animation: dg-breathe 3.2s ease-in-out infinite;
}
.dg-root[data-state="sleeping"] .dg-body { animation-duration: 4.8s; }
.dg-root[data-state="alarmed"] .dg-pet {
  animation: dg-startle 0.45s ease-in-out 0s 2;
}
.dg-root[data-state="alarmed"] .dg-outline {
  stroke: var(--dg-danger);
  stroke-width: 3;
}
.dg-eye-pair { transform-origin: 48px 44px; }
.dg-blink .dg-eye-pair { animation: dg-blink 120ms ease-in-out; }
.dg-pupil { transition: transform 80ms linear; }
.dg-arm-l, .dg-arm-r { transform-origin: center; }
.dg-root[data-state="acting"] .dg-arm-l,
.dg-root[data-state="acting"] .dg-arm-r {
  animation: dg-work 0.35s ease-in-out infinite alternate;
}
.dg-root[data-state="asking"] .dg-arm-l,
.dg-root[data-state="asking"] .dg-arm-r {
  transform: translateY(-6px);
}
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
.dg-status strong { font-weight: 600; }
.dg-status .dg-muted { color: var(--dg-muted); }
.dg-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 40px);
  width: 220px;
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
.dg-panel textarea:focus { outline: 2px solid color-mix(in srgb, var(--dg-body) 55%, transparent); outline-offset: 1px; }
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
  background: var(--dg-body);
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
@keyframes dg-zzz {
  0% { opacity: 0; transform: translate(0, 0); }
  30% { opacity: 1; }
  100% { opacity: 0; transform: translate(10px, -16px); }
}
.dg-zzz { animation: dg-zzz 2.4s ease-in-out infinite; fill: var(--dg-muted); font: 10px ui-sans-serif, system-ui, sans-serif; }
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

    function defaultPos() {
      const margin = 24
      return {
        x: Math.max(margin, window.innerWidth - PET_SIZE - margin),
        y: Math.max(margin, window.innerHeight - PET_SIZE - margin),
      }
    }

    function clampPos(pos) {
      const margin = 8
      return {
        x: Math.min(Math.max(margin, pos.x), Math.max(margin, window.innerWidth - PET_SIZE - margin)),
        y: Math.min(Math.max(margin, pos.y), Math.max(margin, window.innerHeight - PET_SIZE - margin)),
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

    function WhaleSvg({ state, pupil, blinking }) {
      const sleeping = state === 'sleeping'
      const mouth = state === 'alarmed'
        ? 'M38 62 Q48 56 58 62'
        : state === 'asking'
          ? 'M42 60 Q48 68 54 60'
          : 'M40 61 Q48 67 56 61'
      const eyeY = sleeping ? 44 : 42
      return h(
        'svg',
        { viewBox: '0 0 96 96', 'aria-hidden': true },
        h(
          'g',
          { className: `dg-body${blinking ? ' dg-blink' : ''}` },
          h('ellipse', {
            className: 'dg-outline',
            cx: 48,
            cy: 54,
            rx: 30,
            ry: 26,
            fill: 'var(--dg-body)',
            stroke: 'transparent',
          }),
          h('ellipse', { cx: 48, cy: 78, rx: 10, ry: 6, fill: 'var(--dg-body)', opacity: 0.85 }),
          h('ellipse', { cx: 36, cy: 58, rx: 5, ry: 3.5, fill: 'var(--dg-blush)', opacity: 0.55 }),
          h('ellipse', { cx: 60, cy: 58, rx: 5, ry: 3.5, fill: 'var(--dg-blush)', opacity: 0.55 }),
          h(
            'g',
            { className: 'dg-arm-l' },
            h('ellipse', { cx: 22, cy: 58, rx: 7, ry: 4, fill: 'var(--dg-body)', transform: 'rotate(-25 22 58)' }),
          ),
          h(
            'g',
            { className: 'dg-arm-r' },
            h('ellipse', { cx: 74, cy: 58, rx: 7, ry: 4, fill: 'var(--dg-body)', transform: 'rotate(25 74 58)' }),
          ),
          h(
            'g',
            { className: 'dg-eye-pair' },
            sleeping
              ? [
                h('path', { key: 'l', d: 'M30 44 H42', stroke: 'var(--dg-pupil)', strokeWidth: 2, strokeLinecap: 'round', fill: 'none' }),
                h('path', { key: 'r', d: 'M54 44 H66', stroke: 'var(--dg-pupil)', strokeWidth: 2, strokeLinecap: 'round', fill: 'none' }),
              ]
              : [
                h('circle', { key: 'lw', cx: 36, cy: eyeY, r: 7, fill: 'var(--dg-eye)' }),
                h('circle', { key: 'rw', cx: 60, cy: eyeY, r: 7, fill: 'var(--dg-eye)' }),
                h('circle', {
                  key: 'lp',
                  className: 'dg-pupil',
                  cx: 36,
                  cy: eyeY,
                  r: 3.2,
                  fill: 'var(--dg-pupil)',
                  style: { transform: `translate(${pupil.x}px, ${pupil.y}px)` },
                }),
                h('circle', {
                  key: 'rp',
                  className: 'dg-pupil',
                  cx: 60,
                  cy: eyeY,
                  r: 3.2,
                  fill: 'var(--dg-pupil)',
                  style: { transform: `translate(${pupil.x}px, ${pupil.y}px)` },
                }),
              ],
          ),
          h('path', { d: mouth, stroke: 'var(--dg-pupil)', strokeWidth: 2, strokeLinecap: 'round', fill: 'none', opacity: 0.75 }),
          state === 'thinking'
            ? h(
              'g',
              { className: 'dg-fx' },
              h('circle', { cx: 72, cy: 22, r: 2.2, fill: 'var(--dg-muted)' }),
              h('circle', { cx: 78, cy: 16, r: 2.8, fill: 'var(--dg-muted)' }),
              h('circle', { cx: 85, cy: 12, r: 3.2, fill: 'var(--dg-muted)' }),
            )
            : null,
          state === 'alarmed'
            ? h(
              'g',
              { className: 'dg-fx', stroke: 'var(--dg-danger)', strokeWidth: 2, strokeLinecap: 'round' },
              h('path', { d: 'M20 18 L16 10' }),
              h('path', { d: 'M28 14 L28 6' }),
              h('path', { d: 'M36 18 L40 10' }),
            )
            : null,
          sleeping
            ? h('text', { className: 'dg-zzz', x: 70, y: 24 }, 'z')
            : null,
        ),
      )
    }

    function PetOverlay() {
      const rootRef = useRef(null)
      const dragRef = useRef(null)
      const [pos, setPos] = useState(() => clampPos(readPos() || defaultPos()))
      const [open, setOpen] = useState(false)
      const [draft, setDraft] = useState('')
      const [petState, setPetState] = useState('idle')
      const [windowTitle, setWindowTitle] = useState('')
      const [pupil, setPupil] = useState({ x: 0, y: 0 })
      const [blinking, setBlinking] = useState(false)
      const [hint, setHint] = useState('聊天是下一步（B2），现在只能看着你。')

      useEffect(() => {
        const onResize = () => setPos((p) => clampPos(p))
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
          } catch {
            // Host 暂时不可达就保持本地状态
          } finally {
            if (!cancelled) timer = window.setTimeout(poll, 2000)
          }
        }

        poll()
        return () => {
          cancelled = true
          window.clearTimeout(timer)
        }
      }, [])

      useEffect(() => {
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
      }, [petState])

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
        const onMove = (e) => {
          const el = rootRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          const cx = rect.left + rect.width / 2
          const cy = rect.top + rect.height * 0.45
          const dx = e.clientX - cx
          const dy = e.clientY - cy
          const len = Math.hypot(dx, dy) || 1
          const max = 2.4
          setPupil({
            x: (dx / len) * Math.min(max, len / 80),
            y: (dy / len) * Math.min(max, len / 80),
          })
        }
        window.addEventListener('pointermove', onMove, { passive: true })
        return () => window.removeEventListener('pointermove', onMove)
      }, [])

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
        const next = clampPos({ x: drag.orig.x + dx, y: drag.orig.y + dy })
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

      const submit = useCallback(() => {
        const text = draft.trim()
        if (!text) return
        setDraft('')
        setHint('收到了。真聊天是 B2，现在先记在心里。')
      }, [draft])

      const statusText = windowTitle
        ? `看着 · ${windowTitle}`
        : `小瞥 · ${stateLabel(petState)}`

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dg-root',
          'data-state': petState,
          'data-open': open ? '1' : '0',
          style: { left: `${pos.x}px`, top: `${pos.y}px` },
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
        },
        h('div', { className: 'dg-status', title: statusText },
          h('strong', null, '小瞥'),
          h('span', { className: 'dg-muted' }, ` · ${stateLabel(petState)}`),
          windowTitle ? h('div', { className: 'dg-muted' }, windowTitle) : null,
        ),
        open
          ? h('div', { className: 'dg-panel', onPointerDown: (e) => e.stopPropagation() },
            h('textarea', {
              value: draft,
              placeholder: '跟小瞥说点什么…',
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              },
            }),
            h('div', { className: 'dg-row' },
              h('button', { type: 'button', className: 'dg-btn primary', onClick: submit }, '发送'),
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
            h('div', { className: 'dg-hint' }, hint),
          )
          : null,
        h('div', { className: 'dg-pet', role: 'img', 'aria-label': `小瞥，${stateLabel(petState)}` },
          h(WhaleSvg, { state: petState, pupil, blinking }),
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
      STORAGE_POS,
      PET_SIZE,
    }
    return module.exports
  },
})
