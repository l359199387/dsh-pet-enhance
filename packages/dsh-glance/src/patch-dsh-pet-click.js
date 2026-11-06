/**
 * 给已安装的 dsh-pet 桌面 Helper 打补丁：双击宠物 = 打开原生对话弹窗；单击保持原 Q 弹。
 *
 * 桌面独立窗不在 DSH 网页 document 里，网页侧监听无效；只能改 Helper。
 * 补丁幂等（带标记），dsh-pet 升级覆盖后下次启动会再打。
 * 若曾打过「单击开对话」旧补丁，会先还原 onClick 再写双击。
 *
 * @module src/patch-dsh-pet-click.js
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** @deprecated 旧版单击开对话标记；遇到则剥掉 */
export const OLD_CLICK_PATCH_MARK = 'dsh-glance:click-opens-chat'

export const PATCH_MARK = 'dsh-glance:dblclick-opens-chat'

const OLD_CLICK_BLOCK = [
  `    // ${OLD_CLICK_PATCH_MARK} — 单击打开原生对话（同右键「对话」）`,
  '    if (typeof this.showChatFromMenu === \'function\') {',
  '      this.showChatFromMenu();',
  '      return;',
  '    }',
  '',
].join('\n')

const INIT_NEEDLE = [
  '    this.hit.addEventListener(\'click\', (e) => this.onClick(e), { signal: ac.signal });',
  '    this.hit.addEventListener(\'contextmenu\', (e) => this.onContextMenu(e), { signal: ac.signal });',
].join('\n')

const INIT_REPLACEMENT = [
  '    this.hit.addEventListener(\'click\', (e) => this.onClick(e), { signal: ac.signal });',
  `    // ${PATCH_MARK} — 双击打开原生对话（同右键「对话」）；单击仍为原 Q 弹`,
  '    this.hit.addEventListener(\'dblclick\', () => {',
  '      if (typeof this.showChatFromMenu === \'function\') this.showChatFromMenu();',
  '    }, { signal: ac.signal });',
  '    this.hit.addEventListener(\'contextmenu\', (e) => this.onContextMenu(e), { signal: ac.signal });',
].join('\n')

/** 可能的 dsh-pet 安装根目录。 */
export function listDshPetRoots(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const roots = []
  for (const profile of ['desktop', 'web', 'default']) {
    roots.push(join(home, 'profiles', profile, 'node_modules', 'dsh-pet'))
  }
  if (env.DSH_PET_ROOT) roots.unshift(String(env.DSH_PET_ROOT))
  return roots
}

export function inputJsPath(petRoot) {
  return join(petRoot, 'runtime', 'electron-helper', 'sprite', 'input.js')
}

export function initJsPath(petRoot) {
  return join(petRoot, 'runtime', 'electron-helper', 'sprite', 'init.js')
}

/**
 * 剥掉旧版「单击开对话」插入块，恢复原 onClick 后续逻辑。
 * @returns {{ changed: boolean, reason: string, text?: string }}
 */
export function stripOldClickOpensChat(source) {
  const text = String(source ?? '')
  if (!text.includes(OLD_CLICK_PATCH_MARK)) {
    return { changed: false, reason: 'no-old-patch' }
  }
  if (!text.includes(OLD_CLICK_BLOCK)) {
    return { changed: false, reason: 'old-mark-unknown-shape' }
  }
  return {
    changed: true,
    reason: 'stripped-old-click',
    text: text.replace(OLD_CLICK_BLOCK, ''),
  }
}

/**
 * 在 init.js 的 bindEvents 里挂 dblclick → showChatFromMenu。
 * @returns {{ changed: boolean, reason: string, text?: string }}
 */
export function patchDesktopDblClickOpensChat(source) {
  const text = String(source ?? '')
  if (text.includes(PATCH_MARK)) {
    return { changed: false, reason: 'already-patched' }
  }
  if (!text.includes(INIT_NEEDLE)) {
    return { changed: false, reason: 'needle-not-found' }
  }
  return {
    changed: true,
    reason: 'patched',
    text: text.replace(INIT_NEEDLE, INIT_REPLACEMENT),
  }
}

/** @deprecated 兼容旧测试名；等价于 strip + 无操作（单击不再劫持） */
export function patchDesktopClickOpensChat(source) {
  return stripOldClickOpensChat(source)
}

/**
 * 扫描本机 dsh-pet 安装：还原旧单击补丁 + 写入双击补丁。
 * @returns {{ ok: boolean, results: Array<{ path: string, reason: string, changed: boolean }> }}
 */
export function applyDshPetClickPatches(options = {}) {
  const roots = options.roots ?? listDshPetRoots(options.env)
  const results = []
  for (const root of roots) {
    const inputFile = inputJsPath(root)
    const initFile = initJsPath(root)

    if (existsSync(inputFile)) {
      try {
        const raw = readFileSync(inputFile, 'utf8')
        const r = stripOldClickOpensChat(raw)
        if (r.changed) {
          writeFileSync(inputFile, r.text, 'utf8')
          results.push({ path: inputFile, reason: r.reason, changed: true })
        } else if (r.reason !== 'no-old-patch') {
          results.push({ path: inputFile, reason: r.reason, changed: false })
        }
      } catch (e) {
        results.push({ path: inputFile, reason: `read-failed:${e?.message ?? e}`, changed: false })
      }
    } else {
      results.push({ path: inputFile, reason: 'missing', changed: false })
    }

    if (!existsSync(initFile)) {
      results.push({ path: initFile, reason: 'missing', changed: false })
      continue
    }
    let raw
    try {
      raw = readFileSync(initFile, 'utf8')
    } catch (e) {
      results.push({ path: initFile, reason: `read-failed:${e?.message ?? e}`, changed: false })
      continue
    }
    const r = patchDesktopDblClickOpensChat(raw)
    if (!r.changed) {
      results.push({ path: initFile, reason: r.reason, changed: false })
      continue
    }
    try {
      writeFileSync(initFile, r.text, 'utf8')
      results.push({ path: initFile, reason: r.reason, changed: true })
    } catch (e) {
      results.push({ path: initFile, reason: `write-failed:${e?.message ?? e}`, changed: false })
    }
  }
  return {
    ok: results.some((x) => x.changed || x.reason === 'already-patched'),
    results,
  }
}
