/**
 * 给已装 dsh-pet 的 chatWithPet 打闸门：任务类消息先问 enhance，接管则跳过闲聊模型。
 *
 * @module src/patch-dsh-pet-chat-gate.js
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listDshPetRoots } from './patch-dsh-pet-click.js'

export const CHAT_GATE_PATCH_MARK = 'dsh-pet-enhance:chat-gate-v1'

const NEEDLE = [
  '\t\tif (image !== void 0) log.info(`[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）`);',
  '\t\tconst generated = await generateChat({',
].join('\n')

const NEEDLE_SPACES = [
  '		if (image !== void 0) log.info(`[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）`);',
  '		const generated = await generateChat({',
].join('\n')

function gateBlock(indent) {
  const i = indent
  return [
    `${i}if (image !== void 0) log.info(\`[dsh-pet] 对话附带图片 pet=\${petId}，\${image.width}x\${image.height}，\${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）\`);`,
    `${i}/* ${CHAT_GATE_PATCH_MARK} */`,
    `${i}if (image === void 0) {`,
    `${i}  try {`,
    `${i}    const _pePath = await import('node:path');`,
    `${i}    const _peFs = await import('node:fs');`,
    `${i}    const _peOs = await import('node:os');`,
    `${i}    const _peOrigin = String(process.env.DSH_WEB_URL || process.env.DSH_ORIGIN || '').replace(/\\/$/, '')`,
    `${i}      || ('http://127.0.0.1:' + String(process.env.DSH_PORT || '3080'));`,
    `${i}    const _peHome = process.env.DSH_PET_ENHANCE_HOME || process.env.DSH_GLANCE_HOME`,
    `${i}      || _pePath.join(_peOs.homedir(), '.dsh', 'pet-enhance');`,
    `${i}    let _peTok = '';`,
    `${i}    try { _peTok = _peFs.readFileSync(_pePath.join(_peHome, 'desktop.token'), 'utf8').trim(); } catch {}`,
    `${i}    const _peAc = new AbortController();`,
    `${i}    const _peTimer = setTimeout(() => _peAc.abort(), 2800);`,
    `${i}    const _peRes = await fetch(_peOrigin + '/api/pet-enhance/chat-gate', {`,
    `${i}      method: 'POST',`,
    `${i}      headers: { 'content-type': 'application/json', ...(_peTok ? { 'x-pet-enhance-token': _peTok } : {}) },`,
    `${i}      body: JSON.stringify({ text, pet: petId }),`,
    `${i}      signal: _peAc.signal,`,
    `${i}    }).finally(() => clearTimeout(_peTimer));`,
    `${i}    if (_peRes.ok) {`,
    `${i}      const _peBody = await _peRes.json();`,
    `${i}      if (_peBody && _peBody.takeover) {`,
    `${i}        const now = Date.now();`,
    `${i}        const ack = String(_peBody.ack || '这事我来办…').slice(0, 200);`,
    `${i}        entry.messages.push({ role: 'user', content: text, ts: now });`,
    `${i}        entry.messages.push({ role: 'assistant', content: ack, ts: now + 1 });`,
    `${i}        await writeMemory(mem);`,
    `${i}        return { ok: true, text: ack };`,
    `${i}      }`,
    `${i}    }`,
    `${i}  } catch (_peErr) { /* enhance 未就绪则走原聊天 */ }`,
    `${i}}`,
    `${i}const generated = await generateChat({`,
  ].join('\n')
}

/**
 * @param {string} source
 * @returns {{ text: string, changed: boolean, reason: string }}
 */
export function patchChatWithPetSource(source) {
  const text = String(source ?? '')
  if (text.includes(CHAT_GATE_PATCH_MARK)) {
    return { text, changed: false, reason: 'already-patched' }
  }
  if (text.includes(NEEDLE)) {
    return {
      text: text.replace(NEEDLE, gateBlock('\t\t')),
      changed: true,
      reason: 'patched-tabs',
    }
  }
  if (text.includes(NEEDLE_SPACES)) {
    return {
      text: text.replace(NEEDLE_SPACES, gateBlock('\t\t')),
      changed: true,
      reason: 'patched-spaces',
    }
  }
  return { text, changed: false, reason: 'needle-not-found' }
}

/**
 * @param {{ roots?: string[], env?: NodeJS.ProcessEnv }} [options]
 */
export function applyDshPetChatGatePatches(options = {}) {
  const roots = options.roots ?? listDshPetRoots(options.env)
  const results = []
  const targets = ['lib/index.js', 'lib/app.js', 'lib/standalone.js']

  for (const root of roots) {
    for (const rel of targets) {
      const file = join(root, rel)
      if (!existsSync(file)) {
        results.push({ path: file, reason: 'missing', changed: false })
        continue
      }
      const raw = readFileSync(file, 'utf8')
      const patched = patchChatWithPetSource(raw)
      if (patched.changed) {
        writeFileSync(file, patched.text, 'utf8')
      }
      results.push({ path: file, reason: patched.reason, changed: patched.changed })
    }
  }

  return {
    ok: results.some((r) => r.changed || r.reason === 'already-patched'),
    results,
  }
}
