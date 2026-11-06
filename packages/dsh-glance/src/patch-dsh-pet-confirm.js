/**
 * 桌面 Helper：头顶弹出「好 / 不要」确认气泡（轮询 /api/glance/state）。
 *
 * @module src/patch-dsh-pet-confirm.js
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listDshPetRoots } from './patch-dsh-pet-click.js'

export const CONFIRM_PATCH_MARK = 'dsh-glance:confirm-bubble-v2'
export const CONFIRM_SCRIPT_NAME = 'glance-confirm.js'

const HTML_NEEDLE = '    <script src="./sprite/menu.js"></script>\n    <script src="./events.js"></script>'
const HTML_REPLACEMENT = [
  '    <script src="./sprite/menu.js"></script>',
  `    <!-- ${CONFIRM_PATCH_MARK} -->`,
  `    <script src="./sprite/${CONFIRM_SCRIPT_NAME}"></script>`,
  '    <script src="./events.js"></script>',
].join('\n')

const INPUT_BUSY_NEEDLE = [
  '  inputBusy() {',
  '    // 可点的气泡（余额翻页、工作气泡跳会话）同样是来源：它们长在窗口里、靠窗口级 click 触发，',
  '    // 却悬在平时穿透的余量区，正需要借 busy + 控件矩形把它们圈出来。',
  '    return (',
  '      this.dragState.active ||',
  '      this.menuOpen ||',
  '      this.chatOpen ||',
  '      this.todoOpen ||',
  '      this.balanceClickable() ||',
  '      this.workClickable()',
  '    );',
  '  },',
].join('\n')

const INPUT_BUSY_REPLACEMENT = [
  '  inputBusy() {',
  '    // 可点的气泡（余额翻页、工作气泡跳会话）同样是来源：它们长在窗口里、靠窗口级 click 触发，',
  '    // 却悬在平时穿透的余量区，正需要借 busy + 控件矩形把它们圈出来。',
  '    return (',
  '      this.dragState.active ||',
  '      this.menuOpen ||',
  '      this.chatOpen ||',
  '      this.todoOpen ||',
  '      this.balanceClickable() ||',
  '      this.workClickable() ||',
  `      Boolean(this._glanceConfirmOn) /* ${CONFIRM_PATCH_MARK} */`,
  '    );',
  '  },',
].join('\n')

const INPUT_REGIONS_NEEDLE =
  "      ...document.querySelectorAll('.dsh-pet-menu-column, .dsh-pet-chat, .dsh-pet-todo, .pet-bubble.is-clickable'),"

const INPUT_REGIONS_REPLACEMENT =
  "      ...document.querySelectorAll('.dsh-pet-menu-column, .dsh-pet-chat, .dsh-pet-todo, .pet-bubble.is-clickable, .dsh-glance-confirm, .dsh-glance-teach-end'),"

const RENDERER_NEEDLE = '    sprites = [new PetSprite(pet)];\n    window.__dshPetDebug.configOk = true;'
const RENDERER_REPLACEMENT = [
  '    sprites = [new PetSprite(pet)];',
  `    window.__dshGlanceSprites = sprites; /* ${CONFIRM_PATCH_MARK} */`,
  '    if (typeof window.__dshGlanceConfirmBoot === \'function\') window.__dshGlanceConfirmBoot();',
  '    window.__dshPetDebug.configOk = true;',
].join('\n')

/**
 * @param {string} token
 */
export function buildGlanceConfirmScript(token) {
  const safe = String(token || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `/**
 * ${CONFIRM_PATCH_MARK} — 小蓝鲸确认气泡（桌面独立窗）
 * 由 dsh-glance 安装时写入；勿手改。
 */
'use strict';

(function () {
  var TOKEN = '${safe}';
  var POLL_MS = 700;
  var timer = null;
  var lastId = null;
  var teachEndOn = false;

  function api(path) {
    return String(ORIGIN || '') + '/api/glance' + path;
  }

  function headers() {
    return {
      'content-type': 'application/json',
      'x-glance-token': TOKEN,
    };
  }

  function ensureBubble(sprite) {
    if (!sprite || !sprite.el) return null;
    var el = sprite.el.querySelector('.dsh-glance-confirm');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'dsh-glance-confirm pet-bubble is-whisper is-clickable';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '动作确认');
    el.style.cssText = [
      'display:none',
      'flex-direction:column',
      'gap:8px',
      'pointer-events:auto',
      'z-index:40',
      'max-width:min(280px, 90%)',
      'padding:10px 12px',
    ].join(';');
    el.innerHTML =
      '<div class="dsh-glance-confirm-tier" style="font-weight:600;font-size:11px;opacity:.85"></div>' +
      '<div class="dsh-glance-confirm-text" style="white-space:pre-wrap;word-break:break-word"></div>' +
      '<div class="dsh-glance-confirm-row" style="display:flex;gap:8px">' +
      '<button type="button" data-allow="1" style="flex:1;cursor:pointer;padding:6px 8px;border-radius:8px;border:0;background:#3b82f6;color:#fff;font:12px/1 sans-serif">好</button>' +
      '<button type="button" data-allow="0" style="flex:0 0 auto;min-width:52px;cursor:pointer;padding:6px 8px;border-radius:8px;border:1px solid rgba(226,85,85,.45);background:transparent;color:#e25555;font:12px/1 sans-serif">不要</button>' +
      '</div>';
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      var btn = e.target && e.target.closest ? e.target.closest('button[data-allow]') : null;
      if (!btn) return;
      var id = el.getAttribute('data-id');
      if (!id) return;
      var allow = btn.getAttribute('data-allow') === '1';
      fetch(api('/confirm'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ id: id, allow: allow }),
        cache: 'no-store',
      }).catch(function () {});
      hideConfirm();
    });
    sprite.el.appendChild(el);
    return el;
  }

  function ensureTeachEnd(sprite) {
    if (!sprite || !sprite.el) return null;
    var el = sprite.el.querySelector('.dsh-glance-teach-end');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'dsh-glance-teach-end pet-bubble is-whisper is-clickable';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', '我教完了');
    el.style.cssText = [
      'display:none',
      'flex-direction:column',
      'gap:6px',
      'pointer-events:auto',
      'z-index:39',
      'max-width:min(240px, 90%)',
      'padding:10px 12px',
      'cursor:pointer',
    ].join(';');
    el.innerHTML =
      '<div style="font-weight:600;font-size:12px">教学中</div>' +
      '<button type="button" data-teach-end="1" style="cursor:pointer;padding:8px 10px;border-radius:8px;border:0;background:#16a34a;color:#fff;font:13px/1.2 sans-serif">我教完了</button>';
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      var btn = e.target && e.target.closest ? e.target.closest('[data-teach-end]') : null;
      if (!btn && e.currentTarget !== el) return;
      fetch(api('/teach-end'), {
        method: 'POST',
        headers: headers(),
        body: '{}',
        cache: 'no-store',
      }).catch(function () {});
      hideTeachEnd();
    });
    sprite.el.appendChild(el);
    return el;
  }

  function setBusy(sprite, on) {
    sprite._glanceConfirmOn = Boolean(on);
    try {
      if (typeof sprite.setInteractive === 'function') sprite.setInteractive(true);
      if (typeof sprite.syncInputBusy === 'function') sprite.syncInputBusy();
    } catch (e) { /* ignore */ }
  }

  function hideConfirm() {
    lastId = null;
    var sprites = window.__dshGlanceSprites || [];
    for (var i = 0; i < sprites.length; i++) {
      var s = sprites[i];
      var el = s.el && s.el.querySelector('.dsh-glance-confirm');
      if (el) {
        el.style.display = 'none';
        el.classList.remove('is-on');
      }
      setBusy(s, Boolean(s.el && s.el.querySelector('.dsh-glance-teach-end.is-on')));
    }
  }

  function hideTeachEnd() {
    teachEndOn = false;
    var sprites = window.__dshGlanceSprites || [];
    for (var i = 0; i < sprites.length; i++) {
      var s = sprites[i];
      var el = s.el && s.el.querySelector('.dsh-glance-teach-end');
      if (el) {
        el.style.display = 'none';
        el.classList.remove('is-on');
      }
      setBusy(s, Boolean(s.el && s.el.querySelector('.dsh-glance-confirm.is-on')));
    }
  }

  function show(pending) {
    var sprites = window.__dshGlanceSprites || [];
    if (!sprites.length) return;
    var sprite = sprites[0];
    var el = ensureBubble(sprite);
    if (!el) return;
    lastId = pending.id;
    el.setAttribute('data-id', pending.id);
    var tier = el.querySelector('.dsh-glance-confirm-tier');
    var text = el.querySelector('.dsh-glance-confirm-text');
    if (tier) {
      tier.textContent = pending.tier === 'L3' ? '危险操作 · 逐次确认' : '需要你点一下';
      tier.style.color = pending.tier === 'L3' ? '#e25555' : '';
    }
    if (text) text.textContent = pending.summary || '确认执行该动作？';
    el.style.display = 'flex';
    el.classList.add('is-on');
    setBusy(sprite, true);
  }

  function showTeachEnd() {
    var sprites = window.__dshGlanceSprites || [];
    if (!sprites.length) return;
    var sprite = sprites[0];
    var el = ensureTeachEnd(sprite);
    if (!el) return;
    teachEndOn = true;
    el.style.display = 'flex';
    el.classList.add('is-on');
    setBusy(sprite, true);
  }

  async function tick() {
    try {
      var res = await fetch(api('/state'), {
        headers: { 'x-glance-token': TOKEN },
        cache: 'no-store',
      });
      if (!res.ok) return;
      var body = await res.json();
      var pending = body && body.guard && body.guard.pendingConfirm && body.guard.pendingConfirm.data;
      var offer = body && body.guard && body.guard.teachEndOffer && body.guard.teachEndOffer.data;
      if (pending && pending.id) {
        if (pending.id !== lastId) show(pending);
      } else if (lastId) {
        hideConfirm();
      }
      if (offer) {
        if (!teachEndOn) showTeachEnd();
      } else if (teachEndOn) {
        hideTeachEnd();
      }
    } catch (e) {
      /* Host 未起或令牌未就绪：静默 */
    }
  }

  window.__dshGlanceConfirmBoot = function () {
    if (timer) return;
    timer = setInterval(tick, POLL_MS);
    tick();
  };

  if (window.__dshGlanceSprites && window.__dshGlanceSprites.length) {
    window.__dshGlanceConfirmBoot();
  }
})();
`
}

function writeIfChanged(file, next) {
  let prev = ''
  try {
    if (existsSync(file)) prev = readFileSync(file, 'utf8')
  } catch {
    prev = ''
  }
  if (prev === next) return { changed: false, reason: 'unchanged' }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, next, 'utf8')
  return { changed: true, reason: 'written' }
}

/**
 * @param {{ roots?: string[], token: string }} options
 */
export function applyDshPetConfirmPatches(options = {}) {
  const token = String(options.token || '')
  if (!token) {
    return { ok: false, results: [{ path: '(token)', reason: 'missing-token', changed: false }] }
  }
  const roots = options.roots ?? listDshPetRoots(options.env)
  const scriptBody = buildGlanceConfirmScript(token)
  const results = []

  for (const root of roots) {
    const helper = join(root, 'runtime', 'electron-helper')
    const html = join(helper, 'index.html')
    const inputJs = join(helper, 'sprite', 'input.js')
    const rendererJs = join(helper, 'renderer.js')
    const scriptFile = join(helper, 'sprite', CONFIRM_SCRIPT_NAME)

    if (!existsSync(helper)) {
      results.push({ path: helper, reason: 'missing', changed: false })
      continue
    }

    const scriptWrite = writeIfChanged(scriptFile, scriptBody)
    results.push({ path: scriptFile, reason: scriptWrite.reason, changed: scriptWrite.changed })

    if (existsSync(html)) {
      let raw = readFileSync(html, 'utf8')
      if (raw.includes(CONFIRM_PATCH_MARK) && raw.includes(CONFIRM_SCRIPT_NAME)) {
        results.push({ path: html, reason: 'already-patched', changed: false })
      } else if (raw.includes('dsh-glance:confirm-bubble') && raw.includes(CONFIRM_SCRIPT_NAME)) {
        writeFileSync(
          html,
          raw.replace(/dsh-glance:confirm-bubble(?!-v\d)/g, CONFIRM_PATCH_MARK),
          'utf8',
        )
        results.push({ path: html, reason: 'upgraded-v2', changed: true })
      } else if (raw.includes(HTML_NEEDLE)) {
        writeFileSync(html, raw.replace(HTML_NEEDLE, HTML_REPLACEMENT), 'utf8')
        results.push({ path: html, reason: 'patched', changed: true })
      } else {
        results.push({ path: html, reason: 'needle-not-found', changed: false })
      }
    } else {
      results.push({ path: html, reason: 'missing', changed: false })
    }

    if (existsSync(inputJs)) {
      let raw = readFileSync(inputJs, 'utf8')
      let changed = false
      if (!raw.includes('Boolean(this._glanceConfirmOn)')) {
        if (raw.includes(INPUT_BUSY_NEEDLE)) {
          raw = raw.replace(INPUT_BUSY_NEEDLE, INPUT_BUSY_REPLACEMENT)
          changed = true
        } else {
          results.push({ path: inputJs, reason: 'busy-needle-not-found', changed: false })
        }
      }
      if (!raw.includes('.dsh-glance-confirm')) {
        if (raw.includes(INPUT_REGIONS_NEEDLE)) {
          raw = raw.replace(INPUT_REGIONS_NEEDLE, INPUT_REGIONS_REPLACEMENT)
          changed = true
        } else {
          results.push({ path: inputJs, reason: 'regions-needle-not-found', changed: false })
        }
      }
      if (changed) {
        writeFileSync(inputJs, raw, 'utf8')
        results.push({ path: inputJs, reason: 'patched', changed: true })
      } else if (raw.includes('_glanceConfirmOn') && raw.includes('.dsh-glance-confirm')) {
        results.push({ path: inputJs, reason: 'already-patched', changed: false })
      }
    } else {
      results.push({ path: inputJs, reason: 'missing', changed: false })
    }

    if (existsSync(rendererJs)) {
      let raw = readFileSync(rendererJs, 'utf8')
      if (raw.includes('__dshGlanceSprites')) {
        results.push({ path: rendererJs, reason: 'already-patched', changed: false })
      } else if (raw.includes(RENDERER_NEEDLE)) {
        writeFileSync(rendererJs, raw.replace(RENDERER_NEEDLE, RENDERER_REPLACEMENT), 'utf8')
        results.push({ path: rendererJs, reason: 'patched', changed: true })
      } else {
        results.push({ path: rendererJs, reason: 'needle-not-found', changed: false })
      }
    } else {
      results.push({ path: rendererJs, reason: 'missing', changed: false })
    }
  }

  return {
    ok: results.some((r) => r.changed || r.reason === 'already-patched' || r.reason === 'unchanged'),
    results,
  }
}
