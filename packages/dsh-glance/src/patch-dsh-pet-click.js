/**
 * 给已安装的 dsh-pet 桌面 Helper 打补丁：单击宠物 = 打开原生对话弹窗。
 *
 * 桌面独立窗不在 DSH 网页 document 里，网页侧监听无效；只能改 Helper 的 onClick。
 * 补丁幂等（带标记），dsh-pet 升级覆盖后下次启动会再打。
 *
 * @module src/patch-dsh-pet-click.js
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PATCH_MARK = 'dsh-glance:click-opens-chat'

const NEEDLE = [
  '    // 点击音效与浏览器同位置：放在「按下已触发积分」的早退之后、点击动画判断之前',
  '    playClickSound();',
  '    if (!this.animations.clicks.length) return;',
  '    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹（压新首帧，与浏览器一致）',
  '    this.playOnce(S.pick(this.animations.clicks));',
].join('\n')

const REPLACEMENT = [
  '    // 点击音效与浏览器同位置：放在「按下已触发积分」的早退之后、点击动画判断之前',
  '    playClickSound();',
  `    // ${PATCH_MARK} — 单击打开原生对话（同右键「对话」）`,
  '    if (typeof this.showChatFromMenu === \'function\') {',
  '      this.showChatFromMenu();',
  '      return;',
  '    }',
  '    if (!this.animations.clicks.length) return;',
  '    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹（压新首帧，与浏览器一致）',
  '    this.playOnce(S.pick(this.animations.clicks));',
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

/**
 * @returns {{ changed: boolean, reason: string, path?: string }}
 */
export function patchDesktopClickOpensChat(source) {
  const text = String(source ?? '')
  if (text.includes(PATCH_MARK)) {
    return { changed: false, reason: 'already-patched' }
  }
  if (!text.includes(NEEDLE)) {
    return { changed: false, reason: 'needle-not-found' }
  }
  return {
    changed: true,
    reason: 'patched',
    text: text.replace(NEEDLE, REPLACEMENT),
  }
}

/**
 * 扫描本机 dsh-pet 安装并写入补丁。
 * @returns {{ ok: boolean, results: Array<{ path: string, reason: string, changed: boolean }> }}
 */
export function applyDshPetClickPatches(options = {}) {
  const roots = options.roots ?? listDshPetRoots(options.env)
  const results = []
  for (const root of roots) {
    const file = inputJsPath(root)
    if (!existsSync(file)) {
      results.push({ path: file, reason: 'missing', changed: false })
      continue
    }
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (e) {
      results.push({ path: file, reason: `read-failed:${e?.message ?? e}`, changed: false })
      continue
    }
    const r = patchDesktopClickOpensChat(raw)
    if (!r.changed) {
      results.push({ path: file, reason: r.reason, changed: false })
      continue
    }
    try {
      writeFileSync(file, r.text, 'utf8')
      results.push({ path: file, reason: r.reason, changed: true })
    } catch (e) {
      results.push({ path: file, reason: `write-failed:${e?.message ?? e}`, changed: false })
    }
  }
  return {
    ok: results.some((x) => x.changed || x.reason === 'already-patched'),
    results,
  }
}
