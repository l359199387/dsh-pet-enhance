/**
 * 浏览器半 chat-panel / client：sendMessage 先问 enhance 闸门（同源，不依赖 Host origin 探测）。
 *
 * @module src/patch-dsh-pet-chat-client.js
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listDshPetRoots } from './patch-dsh-pet-click.js'

export const CHAT_CLIENT_GATE_MARK = 'dsh-pet-enhance:chat-client-gate-v1'

const NEEDLE = [
  'async function sendMessage(petId, text, attachment) {',
  '\tconst url = ROUTE_PATH + "/chat?pet=" + encodeURIComponent(petId) + "&surface=any";',
  '\tconst result = await sendChat(url, text, attachment);',
  '\treturn result.ok ? { ok: true } : {',
  '\t\tok: false,',
  '\t\tmessage: result.message ?? result.reason',
  '\t};',
  '}',
].join('\n')

const REPLACEMENT = [
  'async function sendMessage(petId, text, attachment) {',
  `\t/* ${CHAT_CLIENT_GATE_MARK} */`,
  '\tif (attachment === void 0) {',
  '\t\ttry {',
  '\t\t\tconst gateRes = await fetch("/api/pet-enhance/chat-gate", {',
  '\t\t\t\tmethod: "POST",',
  '\t\t\t\tcredentials: "same-origin",',
  '\t\t\t\theaders: { "content-type": "application/json" },',
  '\t\t\t\tbody: JSON.stringify({ text: String(text || ""), pet: petId }),',
  '\t\t\t});',
  '\t\t\tif (gateRes.ok) {',
  '\t\t\t\tconst gate = await gateRes.json();',
  '\t\t\t\tif (gate && gate.takeover) {',
  '\t\t\t\t\treturn { ok: true, enhanceTakeover: true, text: gate.ack || "" };',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t} catch (_e) { /* enhance 未装则走原聊天 */ }',
  '\t}',
  '\tconst url = ROUTE_PATH + "/chat?pet=" + encodeURIComponent(petId) + "&surface=any";',
  '\tconst result = await sendChat(url, text, attachment);',
  '\treturn result.ok ? { ok: true } : {',
  '\t\tok: false,',
  '\t\tmessage: result.message ?? result.reason',
  '\t};',
  '}',
].join('\n')

/**
 * @param {string} source
 */
export function patchChatClientSource(source) {
  const text = String(source ?? '')
  if (text.includes(CHAT_CLIENT_GATE_MARK)) {
    return { text, changed: false, reason: 'already-patched' }
  }
  if (!text.includes(NEEDLE)) {
    return { text, changed: false, reason: 'needle-not-found' }
  }
  return { text: text.replace(NEEDLE, REPLACEMENT), changed: true, reason: 'patched' }
}

/**
 * @param {{ roots?: string[], env?: NodeJS.ProcessEnv }} [options]
 */
export function applyDshPetChatClientPatches(options = {}) {
  const roots = options.roots ?? listDshPetRoots(options.env)
  const results = []
  const targets = ['lib/chat-panel.js', 'lib/client.js']

  for (const root of roots) {
    for (const rel of targets) {
      const file = join(root, rel)
      if (!existsSync(file)) {
        results.push({ path: file, reason: 'missing', changed: false })
        continue
      }
      const raw = readFileSync(file, 'utf8')
      const patched = patchChatClientSource(raw)
      if (patched.changed) writeFileSync(file, patched.text, 'utf8')
      results.push({ path: file, reason: patched.reason, changed: patched.changed })
    }
  }

  return {
    ok: results.some((r) => r.changed || r.reason === 'already-patched'),
    results,
  }
}
