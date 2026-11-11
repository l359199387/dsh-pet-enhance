/**
 * 带教后按块沉淀 Python 脚本（一等能力）；执行时可按需跑。
 *
 * @module src/coach-scripts.js
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { AGENT_WAKE_PREFIX, TEACH_FOLLOWUP_PREFIX } from './intent.js'
import { skillSlugFromId } from './harness-schedule.js'
import { learnedPaths } from './learned-automation.js'
import { resolvePython } from './sidecar.js'
import { rewriteTeachSkillWithScripts } from './teach-skill.js'

const FORBIDDEN_RE =
  /SendInput|mouse_event|SetCursorPos|pyautogui|pynput|win32api\.SetCursor|ctypes\.windll\.user32\.(?:SendInput|mouse_event|SetCursorPos)/i

/**
 * @param {string} goal
 * @param {string} summary
 * @param {string} fastPlan
 * @param {string[]} constraints
 */
export function buildScriptProposePrompt(goal, summary, fastPlan, constraints = []) {
  const cons = (constraints || []).filter(Boolean).map((c) => String(c).slice(0, 80)).join('；')
  return (
    `${AGENT_WAKE_PREFIX}${TEACH_FOLLOWUP_PREFIX}`
    + '【带教·脚本拆分·禁止工具】把可流程化的子步骤拆成**多个**独立 Python 脚本块（一块一个文件）。\n'
    + `目标：「${String(goal || '').slice(0, 80)}」\n`
    + `理解：${String(summary || '').slice(0, 300)}\n`
    + `快捷路径：${String(fastPlan || '').slice(0, 300)}\n`
    + (cons ? `约束：${cons}\n` : '')
    + '规则：只写文件系统/命令行/网络等确定性能力；**禁止**鼠标键盘注入与绝对坐标点击；'
    + '每个脚本必须支持 `--dry-run`（只打印将做的事）。\n'
    + '若整件事只能靠看图点鼠标、无法拆脚本：只回复一行 NONE。\n'
    + '否则只回复一个 JSON 数组（不要 markdown 围栏），元素字段：'
    + 'id（kebab）、purpose（中文一句）、filename（*.py）、code（完整 py 源码字符串）。\n'
    + '至少拆成合理的多块（例如建目录与写文件分开），不要塞成一个巨脚本。'
  )
}

/**
 * @param {string} text
 * @returns {{ none: boolean, scripts: object[] }}
 */
export function parseScriptProposals(text) {
  const raw = String(text || '').trim()
  if (!raw || /^NONE\b/i.test(raw)) return { none: true, scripts: [] }
  let body = raw
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return { none: true, scripts: [] }
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return { none: true, scripts: [] }
  }
  if (!Array.isArray(parsed) || !parsed.length) return { none: true, scripts: [] }
  const scripts = []
  for (const item of parsed.slice(0, 8)) {
    const id = sanitizeScriptId(item?.id || item?.name)
    const filename = sanitizeFilename(item?.filename || `${id}.py`)
    const purpose = String(item?.purpose || item?.desc || id).trim().slice(0, 120)
    const code = String(item?.code || item?.source || '').trim()
    if (!id || !code || !filename.endsWith('.py')) continue
    if (FORBIDDEN_RE.test(code)) continue
    if (!/--dry-run|dry_run|dry-run/i.test(code)) continue
    scripts.push({ id, filename, purpose, code: ensureUtf8Header(code) })
  }
  return { none: scripts.length === 0, scripts }
}

export function sanitizeScriptId(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || ''
}

export function sanitizeFilename(raw) {
  let s = String(raw || '').replace(/[^a-zA-Z0-9_.-]/g, '_')
  if (!s.toLowerCase().endsWith('.py')) s = `${s || 'block'}.py`
  return s.slice(0, 64)
}

function ensureUtf8Header(code) {
  if (/coding[:=]\s*utf-8/i.test(code) || code.startsWith('#!')) return code
  return `# -*- coding: utf-8 -*-\n${code}`
}

export function skillsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills')
}

/**
 * @param {string} skillName
 * @param {object[]} scripts
 */
export async function writeCoachScripts(skillName, scripts) {
  const name = String(skillName || '').trim() || 'pe-learn-x'
  const dir = join(skillsRoot(), name, 'scripts')
  await mkdir(dir, { recursive: true })
  /** @type {{ id: string, path: string, purpose: string, status: string }[]} */
  const written = []
  for (const s of scripts) {
    const path = join(dir, s.filename)
    await writeFile(path, `${s.code.replace(/\s+$/, '')}\n`, 'utf8')
    written.push({
      id: s.id,
      path: `scripts/${s.filename}`,
      purpose: s.purpose,
      status: 'ready',
    })
  }
  return { skillName: name, dir, scripts: written }
}

/**
 * 把脚本目录写进 SKILL.md（技能权威）。
 */
export async function rewriteSkillWithScripts({
  skillName,
  goal,
  learnedId,
  summary,
  fastPlan,
  constraints,
  scripts = [],
  scheduleId = null,
}) {
  const name = skillName || skillSlugFromId(learnedId)
  return rewriteTeachSkillWithScripts({
    skillName: name,
    goal,
    summary,
    fastPlan,
    constraints,
    teachSessionId: learnedId || '',
    scripts,
    scheduleId,
  })
}

/**
 * @param {string} home
 * @param {string} learnedId
 * @param {{ skillName?: string, scripts?: object[] }} capability
 */
export async function patchLearnedCapability(home, learnedId, capability) {
  const paths = learnedPaths(home, learnedId)
  let learn
  try {
    learn = JSON.parse(await readFile(paths.learn, 'utf8'))
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  learn.capability = {
    skillName: capability.skillName || learn.capability?.skillName || null,
    scripts: Array.isArray(capability.scripts) ? capability.scripts : [],
  }
  learn.updatedAt = new Date().toISOString()
  await writeFile(paths.learn, `${JSON.stringify(learn, null, 2)}\n`, 'utf8')
  return { ok: true, learn }
}

/**
 * @param {{
 *   skillName: string,
 *   scriptPath: string,
 *   dryRun?: boolean,
 *   python?: string | null,
 *   timeoutMs?: number,
 * }} opts
 */
export function runCoachScript(opts) {
  const skillName = String(opts.skillName || '').trim()
  const rel = String(opts.scriptPath || '').replace(/^scripts[/\\]/, '')
  const file = join(skillsRoot(), skillName, 'scripts', rel)
  const python = opts.python || resolvePython()
  if (!python) {
    return Promise.resolve({ ok: false, code: 127, stdout: '', stderr: 'no-python' })
  }
  const args = [file]
  if (opts.dryRun !== false) args.push('--dry-run')
  return new Promise((resolve) => {
    const child = spawn(python, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ ok: false, code: -1, stdout, stderr: stderr || 'timeout', file })
    }, opts.timeoutMs || 30_000)
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: String(e?.message ?? e), file })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code: code ?? 1, stdout, stderr, file })
    })
  })
}

/**
 * 依次 dry-run（可选）再执行 ready 脚本。
 * @param {object} learnMeta
 * @param {{ dryRunFirst?: boolean, log?: Function }} [opts]
 */
export async function runReadyCoachScripts(learnMeta, opts = {}) {
  const log = opts.log ?? (() => {})
  const skillName = learnMeta?.capability?.skillName || learnMeta?.skillName
  const scripts = Array.isArray(learnMeta?.capability?.scripts)
    ? learnMeta.capability.scripts.filter((s) => s?.status === 'ready' && s?.path)
    : []
  if (!skillName || !scripts.length) {
    return { ok: false, reason: 'no-scripts', results: [] }
  }
  const results = []
  for (const s of scripts) {
    if (opts.dryRunFirst !== false) {
      const dry = await runCoachScript({
        skillName,
        scriptPath: s.path,
        dryRun: true,
      })
      log(`coach-script dry-run ${s.id}: ${dry.ok ? 'ok' : dry.stderr || dry.code}`)
      if (!dry.ok) {
        results.push({ id: s.id, phase: 'dry-run', ...dry })
        return { ok: false, reason: 'dry-run-failed', results }
      }
      results.push({ id: s.id, phase: 'dry-run', ...dry })
    }
    const real = await runCoachScript({
      skillName,
      scriptPath: s.path,
      dryRun: false,
    })
    log(`coach-script run ${s.id}: ${real.ok ? 'ok' : real.stderr || real.code}`)
    results.push({ id: s.id, phase: 'run', ...real })
    if (!real.ok) return { ok: false, reason: 'run-failed', results }
  }
  return { ok: true, reason: 'ok', results }
}

/**
 * 确认文案：列出将写入的脚本块。
 * @param {object[]} scripts
 * @param {string} skillName
 */
export function buildScriptsConfirmSummary(scripts, skillName) {
  const lines = (scripts || []).map(
    (s, i) => `${i + 1}. ${s.id}（${s.purpose}）→ skills/${skillName}/scripts/${s.filename}`,
  )
  return (
    `要把以下 ${lines.length} 个 Python 脚本写入本机技能包吗？\n`
    + `${lines.join('\n')}\n`
    + '脚本只做文件/命令类事，不能点鼠标；支持 --dry-run。'
  )
}
