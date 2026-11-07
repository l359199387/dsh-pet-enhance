/**
 * 给已装 dsh-pet 的 chatWithPet 打闸门：任务类消息先问 enhance，接管则跳过闲聊模型。
 *
 * @module src/patch-dsh-pet-chat-gate.js
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listDshPetRoots } from './patch-dsh-pet-click.js'

export const CHAT_GATE_PATCH_MARK = 'dsh-pet-enhance:chat-gate-v2'
/** @deprecated */
export const CHAT_GATE_PATCH_MARK_V1 = 'dsh-pet-enhance:chat-gate-v1'

const NEEDLE = [
  '\t\tif (image !== void 0) log.info(`[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）`);',
  '\t\tconst generated = await generateChat({',
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
    `${i}    const _peHome = process.env.DSH_PET_ENHANCE_HOME || process.env.DSH_GLANCE_HOME`,
    `${i}      || _pePath.join(_peOs.homedir(), '.dsh', 'pet-enhance');`,
    `${i}    let _peOrigin = '';`,
    `${i}    try { _peOrigin = _peFs.readFileSync(_pePath.join(_peHome, 'host-origin.txt'), 'utf8').trim().replace(/\\/$/, ''); } catch {}`,
    `${i}    if (!_peOrigin) _peOrigin = String(process.env.DSH_WEB_URL || process.env.DSH_ORIGIN || '').replace(/\\/$/, '');`,
    `${i}    if (!_peOrigin) {`,
    `${i}      for (const _pePort of [3080, 5173, 8787, 3000, 8080]) {`,
    `${i}        try {`,
    `${i}          const _peProbe = await fetch('http://127.0.0.1:' + _pePort + '/api/pet-enhance/status', { signal: AbortSignal.timeout(400) });`,
    `${i}          if (_peProbe.ok || _peProbe.status === 401) { _peOrigin = 'http://127.0.0.1:' + _pePort; break; }`,
    `${i}        } catch {}`,
    `${i}      }`,
    `${i}    }`,
    `${i}    if (_peOrigin) {`,
    `${i}      let _peTok = '';`,
    `${i}      try { _peTok = _peFs.readFileSync(_pePath.join(_peHome, 'desktop.token'), 'utf8').trim(); } catch {}`,
    `${i}      const _peAc = new AbortController();`,
    `${i}      const _peTimer = setTimeout(() => _peAc.abort(), 4500);`,
    `${i}      const _peRes = await fetch(_peOrigin + '/api/pet-enhance/chat-gate', {`,
    `${i}        method: 'POST',`,
    `${i}        headers: { 'content-type': 'application/json', ...(_peTok ? { 'x-pet-enhance-token': _peTok } : {}) },`,
    `${i}        body: JSON.stringify({ text, pet: petId }),`,
    `${i}        signal: _peAc.signal,`,
    `${i}      }).finally(() => clearTimeout(_peTimer));`,
    `${i}      if (_peRes.ok) {`,
    `${i}        const _peBody = await _peRes.json();`,
    `${i}        if (_peBody && _peBody.takeover) {`,
    `${i}          const now = Date.now();`,
    `${i}          const ack = String(_peBody.ack || '这事我来办…').slice(0, 200);`,
    `${i}          entry.messages.push({ role: 'user', content: text, ts: now });`,
    `${i}          entry.messages.push({ role: 'assistant', content: ack, ts: now + 1 });`,
    `${i}          await writeMemory(mem);`,
    `${i}          return { ok: true, text: ack };`,
    `${i}        }`,
    `${i}      } else {`,
    `${i}        try { _peFs.appendFileSync(_pePath.join(_peHome, 'chat-gate.log'),`,
    `${i}          new Date().toISOString() + ' HTTP ' + _peRes.status + ' origin=' + _peOrigin + '\\n'); } catch {}`,
    `${i}      }`,
    `${i}    }`,
    `${i}  } catch (_peErr) {`,
    `${i}    try {`,
    `${i}      const _pePath2 = await import('node:path');`,
    `${i}      const _peFs2 = await import('node:fs');`,
    `${i}      const _peOs2 = await import('node:os');`,
    `${i}      const _peHome2 = process.env.DSH_PET_ENHANCE_HOME || _pePath2.join(_peOs2.homedir(), '.dsh', 'pet-enhance');`,
    `${i}      _peFs2.appendFileSync(_pePath2.join(_peHome2, 'chat-gate.log'),`,
    `${i}        new Date().toISOString() + ' ERR ' + String(_peErr && _peErr.message || _peErr) + '\\n');`,
    `${i}    } catch {}`,
    `${i}  }`,
    `${i}}`,
    `${i}const generated = await generateChat({`,
  ].join('\n')
}

/**
 * 去掉旧 v1 闸门块，恢复到可再打 v2 的针。
 * @param {string} source
 */
export function stripChatGateV1(source) {
  let text = String(source ?? '')
  if (!text.includes(CHAT_GATE_PATCH_MARK_V1)) return text
  const mark = CHAT_GATE_PATCH_MARK_V1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 连同标记到「const generated」整段替换回干净的 generateChat 行
  const re = new RegExp(
    String.raw`\n[ \t]*/\* ${mark} \*/[\s\S]*?\n([ \t]*)const generated = await generateChat\(\{`,
  )
  text = text.replace(re, '\n\t\tconst generated = await generateChat({')
  return text
}

/**
 * @param {string} source
 * @returns {{ text: string, changed: boolean, reason: string }}
 */
export function patchChatWithPetSource(source) {
  let text = String(source ?? '')
  if (text.includes(CHAT_GATE_PATCH_MARK)) {
    return { text, changed: false, reason: 'already-patched' }
  }
  if (text.includes(CHAT_GATE_PATCH_MARK_V1)) {
    text = stripChatGateV1(text)
  }
  if (text.includes(NEEDLE)) {
    return {
      text: text.replace(NEEDLE, gateBlock('\t\t')),
      changed: true,
      reason: 'patched-tabs',
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
