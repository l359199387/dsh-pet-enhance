/**
 * dsh-pet-enhance —— 浏览器半身（B1：宠物出现）。
 *
 * 挂在 `shell.overlay`。
 *
 * 若本机已装 `dsh-pet`：隐藏自绘形象；
 * **双击宠物**打开 dsh-pet 自带对话弹窗（等同悬停按 L / 右键「对话」）；
 * 单击仍为 dsh-pet 原行为（Q 弹）。急停在右键「更多」。未装时用内置 SVG。
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-pet-enhance',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const {
      createElement: h,
      Fragment,
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
    } = React

    const API = '/api/pet-enhance'
    const DSH_PET = '/dsh-pet-7340'
    const STORAGE_POS = 'dsh-pet-enhance.pos'
    const STORAGE_SIZE = 'dsh-pet-enhance.size'
    const STORAGE_USE_PET = 'dsh-pet-enhance.useDshPet'
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
      // 裸 L：与菜单 hint「L 键」一致；要求指针仍停在宠物上（双击后通常满足）
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
     * 网页端双击落在 dsh-pet → 打开原生对话；单击不拦截（留给 dsh-pet Q 弹）。
     * 桌面独立窗由 Host 给 Helper 打 dblclick 补丁。
     */
    function bindDshPetClickToChat(onOpen) {
      const onDbl = (e) => {
        if (!eventOnDshPet(e)) return
        // 下一帧再发键：让 dsh-pet 先处理完 dblclick，hover 标记仍在
        window.setTimeout(() => onOpen?.(), 0)
      }
      document.addEventListener('dblclick', onDbl, true)
      return () => {
        document.removeEventListener('dblclick', onDbl, true)
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
.dg-confirm {
  position: fixed;
  z-index: 2147483001;
  width: min(280px, calc(100vw - 24px));
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--dg-panel);
  color: var(--dg-text);
  border: 1px solid var(--dg-border);
  box-shadow: 0 12px 32px rgba(0,0,0,0.35);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
  transform: translate(-50%, calc(-100% - 10px));
  pointer-events: auto;
}
.dg-confirm::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -7px;
  width: 12px;
  height: 12px;
  background: var(--dg-panel);
  border-right: 1px solid var(--dg-border);
  border-bottom: 1px solid var(--dg-border);
  transform: translateX(-50%) rotate(45deg);
}
.dg-confirm .dg-confirm-tier {
  font: 600 11px/1.2 ui-sans-serif, system-ui, sans-serif;
  color: var(--dg-accent);
  letter-spacing: 0.02em;
}
.dg-confirm .dg-confirm-tier[data-tier="L3"] { color: var(--dg-danger); }
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

/* —— 我学会的（侧栏主面板） —— */
.dg-learn-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 20px 24px 28px;
  color: var(--dsw-alias-label-primary, #e8eaed);
  background:
    radial-gradient(1200px 400px at 10% -10%, rgba(59,130,246,.12), transparent 55%),
    var(--dsw-alias-bg-layer-1, transparent);
  box-sizing: border-box;
}
.dg-learn-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.dg-learn-page h1 {
  margin: 0 0 6px;
  font: 650 22px/1.25 var(--dsw-alias-font-sans, ui-sans-serif, system-ui, sans-serif);
  letter-spacing: .02em;
}
.dg-learn-page .dg-learn-sub {
  margin: 0;
  max-width: 42em;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
}
.dg-learn-count {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06));
}
.dg-learn-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.dg-learn-search {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--dsw-alias-stroke-subtle, rgba(255,255,255,.12));
  border-radius: 10px;
  padding: 9px 12px;
  font: 13px/1.4 var(--dsw-alias-font-sans, ui-sans-serif, system-ui, sans-serif);
  color: var(--dsw-alias-label-primary, #e8eaed);
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04));
  outline: none;
}
.dg-learn-search:focus {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 55%, transparent);
}
.dg-learn-list {
  flex: 1;
  overflow: auto;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
  padding-right: 2px;
  align-content: start;
}
.dg-learn-empty {
  padding: 36px 12px;
  text-align: center;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
  font-size: 13px;
  line-height: 1.6;
  grid-column: 1 / -1;
}
.dg-learn-card {
  border: 1px solid var(--dsw-alias-stroke-subtle, rgba(255,255,255,.10));
  border-radius: 14px;
  padding: 14px 16px 12px;
  background:
    linear-gradient(180deg, rgba(255,255,255,.03), transparent 40%),
    color-mix(in srgb, var(--dsw-alias-bg-layer-2, #1a1f2a) 92%, transparent);
  box-shadow: 0 1px 0 rgba(255,255,255,.04) inset;
  display: flex;
  flex-direction: column;
  min-height: 180px;
}
.dg-learn-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.dg-learn-index {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--dsw-alias-brand-primary, #60a5fa);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 16%, transparent);
  margin-right: 8px;
}
.dg-learn-row-title {
  font-weight: 650;
  font-size: 15px;
  line-height: 1.35;
  display: flex;
  align-items: flex-start;
  gap: 0;
  flex-wrap: wrap;
}
.dg-learn-title-text { flex: 1; min-width: 0; }
.dg-learn-badge {
  display: inline-block;
  margin-left: 8px;
  vertical-align: middle;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.2));
  color: var(--dsw-alias-label-secondary, #9aa3b2);
}
.dg-learn-badge.is-on {
  color: var(--dsw-alias-brand-primary, #60a5fa);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 18%, transparent);
}
.dg-learn-block {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.18));
}
.dg-learn-block-label {
  font-size: 11px;
  letter-spacing: .04em;
  text-transform: none;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
  margin-bottom: 6px;
}
.dg-learn-block-body {
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  color: var(--dsw-alias-label-primary, #e8eaed);
}
.dg-learn-block.is-muted .dg-learn-block-body {
  color: var(--dsw-alias-label-secondary, #9aa3b2);
}
.dg-learn-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.dg-learn-actions button,
.dg-learn-editor button {
  cursor: pointer;
  border: 0;
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 12px;
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.08));
  color: var(--dsw-alias-label-primary, #e8eaed);
}
.dg-learn-actions button:hover { filter: brightness(1.08); }
.dg-learn-actions button.danger { color: #f87171; }
.dg-learn-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 10, 16, .55);
  backdrop-filter: blur(4px);
  box-sizing: border-box;
}
.dg-learn-modal {
  width: min(520px, 100%);
  max-height: min(86vh, 720px);
  overflow: auto;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-stroke-subtle, rgba(255,255,255,.12));
  background: var(--dsw-alias-bg-layer-1, #141820);
  box-shadow: 0 18px 48px rgba(0,0,0,.45);
  padding: 18px 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--dsw-alias-label-primary, #e8eaed);
}
.dg-learn-modal h2 {
  margin: 0;
  font: 650 17px/1.3 var(--dsw-alias-font-sans, ui-sans-serif, system-ui, sans-serif);
}
.dg-learn-modal .dg-learn-modal-sub {
  margin: -4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
}
.dg-learn-modal label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
}
.dg-learn-modal .hint {
  font-size: 11px;
  opacity: .9;
}
.dg-learn-modal input,
.dg-learn-modal textarea {
  border: 1px solid var(--dsw-alias-stroke-subtle, rgba(255,255,255,.12));
  border-radius: 8px;
  padding: 9px 11px;
  font: 13px/1.45 var(--dsw-alias-font-sans, ui-sans-serif, system-ui, sans-serif);
  color: var(--dsw-alias-label-primary, #e8eaed);
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04));
  resize: vertical;
}
.dg-learn-modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
  margin-top: 4px;
}
.dg-learn-modal-actions .status {
  margin-right: auto;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
}
.dg-learn-modal-actions button {
  cursor: pointer;
  border: 0;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 12px;
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.08));
  color: var(--dsw-alias-label-primary, #e8eaed);
}
.dg-learn-modal-actions button.primary {
  background: var(--dsw-alias-brand-primary, #3b82f6);
  color: #fff;
}
.dg-learn-modal-actions button.danger {
  background: color-mix(in srgb, #ef4444 85%, #000);
  color: #fff;
}
.dg-learn-err { color: #f87171; font-size: 13px; margin: 0 0 10px; }
.dg-learn-runs {
  margin-top: 12px;
  border-top: 1px solid var(--dsw-alias-stroke-subtle, rgba(255,255,255,.08));
  padding-top: 10px;
}
.dg-learn-runs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.dg-learn-runs-head button {
  cursor: pointer;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
  font-size: 12px;
  padding: 2px 4px;
}
.dg-learn-run {
  border: 1px solid var(--dsw-alias-stroke-subtle, rgba(255,255,255,.07));
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.16));
}
.dg-learn-run:last-child { margin-bottom: 0; }
.dg-learn-run-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
  margin-bottom: 4px;
}
.dg-learn-run-ok { color: #4ade80; }
.dg-learn-run-fail { color: #f87171; }
.dg-learn-run-body {
  font-size: 12px;
  line-height: 1.45;
  color: var(--dsw-alias-label-primary, #e8eaed);
  white-space: pre-wrap;
}
.dg-learn-rate {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  align-items: center;
}
.dg-learn-rate button {
  cursor: pointer;
  border: 1px solid var(--dsw-alias-stroke-subtle, rgba(255,255,255,.12));
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 11px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
}
.dg-learn-rate button.is-on,
.dg-learn-rate button:hover {
  color: var(--dsw-alias-label-primary, #e8eaed);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 50%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 14%, transparent);
}
.dg-learn-rate-done {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
  margin-top: 6px;
}
.dg-learn-rate textarea {
  width: 100%;
  margin-top: 6px;
  border: 1px solid var(--dsw-alias-stroke-subtle, rgba(255,255,255,.12));
  border-radius: 8px;
  padding: 7px 9px;
  font: 12px/1.4 var(--dsw-alias-font-sans, ui-sans-serif, system-ui, sans-serif);
  color: var(--dsw-alias-label-primary, #e8eaed);
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04));
  resize: vertical;
  box-sizing: border-box;
}
.dg-learn-rate .submit {
  margin-left: auto;
  border: 0 !important;
  background: var(--dsw-alias-brand-primary, #3b82f6) !important;
  color: #fff !important;
  border-radius: 8px !important;
  padding: 5px 12px !important;
}
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
      const [pendingConfirm, setPendingConfirm] = useState(null)
      const [teachEndOffer, setTeachEndOffer] = useState(false)
      const [confirmPos, setConfirmPos] = useState(null)
      const [hint, setHint] = useState(
        '双击宠物打开对话（同右键「对话」/ L）；单击仍是原来的互动。桌面独立窗同样（需重载过 Helper）。',
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
            const pending = body.guard?.pendingConfirm?.data
            setPendingConfirm(pending && pending.id ? pending : null)
            setTeachEndOffer(Boolean(body.guard?.teachEndOffer?.data))
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

      // 确认 /「我教完了」气泡锚在宠物头顶
      useEffect(() => {
        if (!pendingConfirm && !teachEndOffer) {
          setConfirmPos(null)
          return undefined
        }
        let alive = true
        const place = () => {
          if (!alive) return
          let rect = null
          if (!proxy && rootRef.current) {
            rect = rootRef.current.getBoundingClientRect()
          } else {
            const hit = document.querySelector('.dsh-pet-hit, .dsh-pet-stage, .dsh-pet-root')
            if (hit) rect = hit.getBoundingClientRect()
          }
          if (rect && rect.width > 0) {
            setConfirmPos({
              left: rect.left + rect.width / 2,
              top: Math.max(12, rect.top),
            })
          } else {
            const dock = clampDockPos()
            setConfirmPos({ left: dock.x + 40, top: Math.max(12, dock.y) })
          }
        }
        place()
        const timer = window.setInterval(place, 120)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [pendingConfirm, teachEndOffer, proxy, pos])

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
        setPendingConfirm(null)
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

      const answerConfirm = useCallback(async (allow) => {
        const id = pendingConfirm?.id
        if (!id) return
        try {
          const res = await fetch(`${API}/confirm`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, allow: Boolean(allow) }),
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            setHint(`确认失败：${body?.rejected?.[0] || res.status}`)
            return
          }
          setPendingConfirm(null)
          setHint(allow ? '已确认，继续做。' : '已拒绝，不再试。')
        } catch (e) {
          setHint(`确认异常：${e?.message ?? e}`)
        }
      }, [pendingConfirm])

      const clickTeachEnd = useCallback(async () => {
        try {
          const res = await fetch(`${API}/teach-end`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            setHint(`结束教学失败：${body?.rejected?.[0] || res.status}`)
            return
          }
          setTeachEndOffer(false)
          setHint('已点「我教完了」，正在总结…')
        } catch (e) {
          setHint(`结束教学异常：${e?.message ?? e}`)
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

      const confirmCard = pendingConfirm && confirmPos
        ? h('div', {
          className: 'dg-confirm',
          role: 'dialog',
          'aria-label': '动作确认',
          style: { left: `${confirmPos.left}px`, top: `${confirmPos.top}px` },
        },
          h('div', {
            className: 'dg-confirm-tier',
            'data-tier': pendingConfirm.tier || 'L2',
          }, pendingConfirm.tier === 'L3' ? '危险操作 · 逐次确认' : '需要你点一下'),
          h('div', null, pendingConfirm.summary || '确认执行该动作？'),
          h('div', { className: 'dg-row' },
            h('button', {
              type: 'button',
              className: 'dg-btn primary',
              onClick: () => answerConfirm(true),
            }, '好'),
            h('button', {
              type: 'button',
              className: 'dg-btn danger',
              onClick: () => answerConfirm(false),
            }, '不要'),
          ),
        )
        : (teachEndOffer && confirmPos && !pendingConfirm
          ? h('div', {
            className: 'dg-confirm',
            role: 'button',
            'aria-label': '我教完了',
            style: { left: `${confirmPos.left}px`, top: `${confirmPos.top}px` },
          },
            h('div', { className: 'dg-confirm-tier' }, '教学中'),
            h('div', { className: 'dg-row' },
              h('button', {
                type: 'button',
                className: 'dg-btn primary',
                onClick: clickTeachEnd,
              }, '我教完了'),
            ),
          )
          : null)

      // 已装 dsh-pet：不抢形象；双击 → 原生「对话」弹窗；备援钮发 Ctrl+Shift+L。
      if (proxy) {
        const dock = clampDockPos()
        return h(
          Fragment,
          null,
          h(
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
          ),
          confirmCard,
        )
      }

      return h(
        Fragment,
        null,
        h(
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
        ),
        confirmCard,
      )
    }

    const LEARNED_PANEL_ID = 'pet-enhance-learned'

    function LearnedIcon() {
      return h('svg', {
        width: 20,
        height: 20,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        'aria-hidden': true,
      },
        h('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
        h('path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }),
        h('path', { d: 'M8 7h8M8 11h6' }),
      )
    }

    function fuzzyMatchGoal(goal, query) {
      const g = String(goal || '').toLowerCase().replace(/\s+/g, '')
      const q = String(query || '').toLowerCase().replace(/\s+/g, '')
      if (!q) return true
      if (g.includes(q)) return true
      // 简单模糊：查询字符按序出现即可
      let i = 0
      for (const ch of g) {
        if (ch === q[i]) i += 1
        if (i >= q.length) return true
      }
      return false
    }

    function formatRunAt(iso) {
      try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return iso || ''
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      } catch {
        return iso || ''
      }
    }

    const RATING_UI = [
      { key: 'good', label: '好' },
      { key: 'ok', label: '一般' },
      { key: 'bad', label: '差' },
    ]

    function LearnedPage() {
      const [items, setItems] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [editItem, setEditItem] = useState(null)
      const [deleteItem, setDeleteItem] = useState(null)
      const [draft, setDraft] = useState({ goal: '', ownerNotes: '' })
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState('')
      const [query, setQuery] = useState('')
      const [runsOpen, setRunsOpen] = useState({})
      const [rateDraft, setRateDraft] = useState({})

      const reload = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const res = await fetch(`${API}/learned`, { credentials: 'same-origin' })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) throw new Error(body.rejected?.[0] || `http-${res.status}`)
          setItems(Array.isArray(body.items) ? body.items : [])
        } catch (e) {
          setError(String(e?.message || e))
          setItems([])
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { reload() }, [reload])

      const filtered = useMemo(() => {
        return items.filter((it) => fuzzyMatchGoal(it.goal || it.id, query))
      }, [items, query])

      const openEdit = (item) => {
        setDeleteItem(null)
        setEditItem(item)
        setStatus('')
        setDraft({
          goal: item.goal || '',
          ownerNotes: '',
        })
      }

      const closeEdit = () => {
        if (busy) return
        setEditItem(null)
        setStatus('')
      }

      const saveEdit = async () => {
        if (!editItem || busy) return
        setBusy(true)
        setError('')
        setStatus('保存中…有补充时会归纳进学习理解')
        try {
          const res = await fetch(`${API}/learned/${encodeURIComponent(editItem.id)}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              goal: draft.goal,
              ownerNotes: draft.ownerNotes,
              mergeNotes: true,
            }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) throw new Error(body.rejected?.[0] || '保存失败')
          setStatus(body.merged
            ? '已保存：补充已并入学习理解，并已清空'
            : (body.mergeReason ? `已保存（未更新理解：${body.mergeReason}）` : '已保存'))
          setEditItem(null)
          await reload()
        } catch (e) {
          setError(String(e?.message || e))
          setStatus('')
        } finally {
          setBusy(false)
        }
      }

      const confirmDelete = async () => {
        if (!deleteItem || busy) return
        setBusy(true)
        try {
          const res = await fetch(`${API}/learned/${encodeURIComponent(deleteItem.id)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) throw new Error(body.rejected?.[0] || '删除失败')
          if (editItem?.id === deleteItem.id) setEditItem(null)
          setDeleteItem(null)
          await reload()
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setBusy(false)
        }
      }

      const submitRate = async (item, run) => {
        if (!item || !run || busy) return
        const draftRate = rateDraft[run.id] || {}
        const rating = draftRate.rating
        if (!rating) {
          setError('请先选好 / 一般 / 差')
          return
        }
        setBusy(true)
        setError('')
        setStatus('正在根据评价改正学习理解…')
        try {
          const res = await fetch(
            `${API}/learned/${encodeURIComponent(item.id)}/runs/${encodeURIComponent(run.id)}/rate`,
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                rating,
                comment: draftRate.comment || '',
              }),
            },
          )
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) throw new Error(body.rejected?.[0] || '评价失败')
          setStatus(body.merged
            ? '已根据评价改正学习理解'
            : (body.mergeReason ? `评价已记（未改理解：${body.mergeReason}）` : '评价已记'))
          setRateDraft((d) => {
            const next = { ...d }
            delete next[run.id]
            return next
          })
          await reload()
        } catch (e) {
          setError(String(e?.message || e))
          setStatus('')
        } finally {
          setBusy(false)
        }
      }

      const understandingOf = (item) => item.understanding || item.summary || ''
      const editUnderstanding = editItem ? understandingOf(editItem) : ''
      const ratingLabel = { good: '好', ok: '一般', bad: '差' }

      return h('div', { className: 'dg-learn-page' },
        h('div', { className: 'dg-learn-head' },
          h('div', null,
            h('h1', null, '我学会的'),
            h('p', { className: 'dg-learn-sub' },
              '卡片查看学习理解与执行记录；可搜索标题，对执行评价后会改正理解。编辑里的「补充」保存后也会并入理解并清空。',
            ),
          ),
          !loading ? h('div', { className: 'dg-learn-count' },
            query.trim() ? `${filtered.length}/${items.length} 条` : `${items.length} 条`,
          ) : null,
        ),
        h('div', { className: 'dg-learn-toolbar' },
          h('input', {
            className: 'dg-learn-search',
            type: 'search',
            placeholder: '模糊搜索标题，例如：B站、心情…',
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
        ),
        error ? h('p', { className: 'dg-learn-err' }, error) : null,
        status && !editItem ? h('p', { className: 'dg-learn-sub' }, status) : null,
        loading ? h('p', { className: 'dg-learn-empty' }, '加载中…') : null,
        !loading && !items.length
          ? h('p', { className: 'dg-learn-empty' },
            '还没有学会的条目。',
            h('br'),
            '打开「实时看屏幕」教一遍，点「我教完了」就会出现在这里。')
          : null,
        !loading && items.length && !filtered.length
          ? h('p', { className: 'dg-learn-empty' }, '没有匹配的标题，换个关键词试试。')
          : null,
        h('div', { className: 'dg-learn-list' },
          filtered.map((item, idx) => {
            const understanding = understandingOf(item)
            const runs = Array.isArray(item.runs) ? item.runs : []
            const open = runsOpen[item.id] !== false
            return h('article', { key: item.id, className: 'dg-learn-card' },
              h('div', { className: 'dg-learn-card-top' },
                h('div', { className: 'dg-learn-row-title' },
                  h('span', { className: 'dg-learn-index' }, String(idx + 1)),
                  h('span', { className: 'dg-learn-title-text' },
                    item.goal || item.id,
                    ' ',
                    h('span', {
                      className: `dg-learn-badge${item.scheduled ? ' is-on' : ''}`,
                    }, item.scheduled ? (item.timingLabel || '已定时') : '不定时'),
                  ),
                ),
                h('div', { className: 'dg-learn-actions' },
                  h('button', {
                    type: 'button',
                    disabled: busy,
                    onClick: () => openEdit(item),
                  }, '编辑'),
                  h('button', {
                    type: 'button',
                    className: 'danger',
                    disabled: busy,
                    onClick: () => { setEditItem(null); setDeleteItem(item) },
                  }, '删除'),
                ),
              ),
              h('div', { className: `dg-learn-block${understanding ? '' : ' is-muted'}` },
                h('div', { className: 'dg-learn-block-label' }, '小蓝鲸的学习理解'),
                h('div', { className: 'dg-learn-block-body' },
                  understanding || '（教完后会写在这里；点编辑用「补充」帮它完善）',
                ),
              ),
              h('div', { className: 'dg-learn-runs' },
                h('div', { className: 'dg-learn-runs-head' },
                  h('div', { className: 'dg-learn-block-label', style: { margin: 0 } },
                    `执行记录（${runs.length}）`,
                  ),
                  h('button', {
                    type: 'button',
                    onClick: () => setRunsOpen((s) => ({ ...s, [item.id]: !open })),
                  }, open ? '收起' : '展开'),
                ),
                open
                  ? (runs.length
                    ? runs.map((run) => {
                      const draftRate = rateDraft[run.id] || { rating: '', comment: '' }
                      return h('div', { key: run.id, className: 'dg-learn-run' },
                        h('div', { className: 'dg-learn-run-meta' },
                          h('span', null, formatRunAt(run.at)),
                          h('span', null, run.via || 'unknown'),
                          h('span', {
                            className: run.ok ? 'dg-learn-run-ok' : 'dg-learn-run-fail',
                          }, run.ok ? '成功' : '失败'),
                        ),
                        h('div', { className: 'dg-learn-run-body' },
                          run.summary || '（无摘要）',
                        ),
                        run.rating
                          ? h('div', { className: 'dg-learn-rate-done' },
                            `已评：${ratingLabel[run.rating] || run.rating}`,
                            run.comment ? ` · ${run.comment}` : '',
                            run.refined ? ' · 已改正理解' : '',
                          )
                          : h('div', { className: 'dg-learn-rate' },
                            ...RATING_UI.map((r) => h('button', {
                              key: r.key,
                              type: 'button',
                              className: draftRate.rating === r.key ? 'is-on' : '',
                              disabled: busy,
                              onClick: () => setRateDraft((d) => ({
                                ...d,
                                [run.id]: { ...draftRate, rating: r.key },
                              })),
                            }, r.label)),
                            h('textarea', {
                              rows: 2,
                              placeholder: '可选：写下哪里不对，例如应直接打开 bilibili.com…',
                              value: draftRate.comment || '',
                              disabled: busy,
                              onChange: (e) => setRateDraft((d) => ({
                                ...d,
                                [run.id]: { ...draftRate, comment: e.target.value },
                              })),
                            }),
                            h('button', {
                              type: 'button',
                              className: 'submit',
                              disabled: busy || !draftRate.rating,
                              onClick: () => submitRate(item, run),
                            }, busy ? '改正中…' : '提交评价并改正'),
                          ),
                      )
                    })
                    : h('div', { className: 'dg-learn-block-body', style: { opacity: 0.7 } },
                      '还没有执行记录。对小蓝鲸说「去看看… / 执行一下…」跑过后会出现在这里。',
                    ))
                  : null,
              ),
            )
          }),
        ),

        editItem
          ? h('div', {
            className: 'dg-learn-modal-mask',
            onClick: (e) => { if (e.target === e.currentTarget) closeEdit() },
          },
            h('div', {
              className: 'dg-learn-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '编辑学会条目',
            },
              h('h2', null, '编辑学会条目'),
              h('p', { className: 'dg-learn-modal-sub' },
                '「补充」只用来帮助小蓝鲸更新学习理解；理解完成后补充会自动清空。',
              ),
              h('label', null, '目标标题',
                h('input', {
                  value: draft.goal,
                  onChange: (e) => setDraft((d) => ({ ...d, goal: e.target.value })),
                }),
              ),
              h('div', { className: `dg-learn-block${editUnderstanding ? '' : ' is-muted'}` },
                h('div', { className: 'dg-learn-block-label' }, '小蓝鲸的学习理解（只读）'),
                h('div', { className: 'dg-learn-block-body' },
                  editUnderstanding || '尚无理解，填写补充并保存后会生成/更新。',
                ),
              ),
              h('label', null,
                '补充',
                h('span', { className: 'hint' },
                  '写下你的偏好、约束或纠正；保存后会并入上方理解，并清空本栏。',
                ),
                h('textarea', {
                  rows: 5,
                  placeholder: '例如：心情笔记写到桌面「每日心情」；语气轻松一点…',
                  value: draft.ownerNotes,
                  onChange: (e) => setDraft((d) => ({ ...d, ownerNotes: e.target.value })),
                }),
              ),
              h('div', { className: 'dg-learn-modal-actions' },
                status ? h('span', { className: 'status' }, status) : h('span', { className: 'status' }, ''),
                h('button', { type: 'button', disabled: busy, onClick: closeEdit }, '取消'),
                h('button', {
                  type: 'button',
                  className: 'primary',
                  disabled: busy || !String(draft.goal || '').trim(),
                  onClick: saveEdit,
                }, busy ? '归纳中…' : '保存'),
              ),
            ),
          )
          : null,

        deleteItem
          ? h('div', {
            className: 'dg-learn-modal-mask',
            onClick: (e) => { if (e.target === e.currentTarget && !busy) setDeleteItem(null) },
          },
            h('div', {
              className: 'dg-learn-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '确认删除',
            },
              h('h2', null, '确认删除？'),
              h('p', { className: 'dg-learn-modal-sub' },
                `将删除「${deleteItem.goal || deleteItem.id}」。`,
                h('br'),
                '本地学习文件、自动化记录会一并清除；若有对应定时任务也会删除。此操作不可撤销。',
              ),
              h('div', { className: 'dg-learn-modal-actions' },
                h('button', {
                  type: 'button',
                  disabled: busy,
                  onClick: () => setDeleteItem(null),
                }, '取消'),
                h('button', {
                  type: 'button',
                  className: 'danger',
                  disabled: busy,
                  onClick: confirmDelete,
                }, busy ? '删除中…' : '确认删除'),
              ),
            ),
          )
          : null,
      )
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-pet-enhance')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-pet-enhance: styles')

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-pet-enhance-pet',
      }, () => h(PetOverlay)))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: LEARNED_PANEL_ID,
      }, () => h(LearnedPage)))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: LEARNED_PANEL_ID,
        order: 11,
        label: () => '我学会的',
      }, () => h(LearnedIcon)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-pet-enhance'
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
