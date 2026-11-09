import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createTeachBridge } from '../src/teach-bridge.js'
import { assertLearnedAutomationPair, listLearnedIndex } from '../src/learned-automation.js'
import { saveSettings } from '../src/settings.js'
import { coachLogPath } from '../src/coach-log.js'

const home = mkdtempSync(join(tmpdir(), 'glance-coach-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('对话带教：做成了 → LEARN v2 + coach-log，不录宏不喂图', async () => {
  await saveSettings(home, { liveWatch: false, actEnabled: true })
  const wakes = []
  const memoryPath = join(home, 'pet-memory.json')
  const prevDsh = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const bridge = createTeachBridge({
    home,
    petMemoryPath: memoryPath,
    ctx: { get: () => null },
    log() {},
    pollChat: false,
    getPreferredSessionId: () => 'sess-coach',
    prepareSession: async () => ({ sessionId: 'fresh-coach', fresh: true }),
    wake: async (_ctx, opts) => {
      wakes.push(String(opts.text || ''))
      return { ok: true, sessionId: opts.sessionId || 's1' }
    },
    waitReply: async (_ctx, _sid, _opts) => {
      const last = wakes[wakes.length - 1] || ''
      if (last.includes('带教抽目标')) {
        return { ok: true, text: 'GOAL: 把今天心情写到桌面' }
      }
      if (last.includes('带教分流')) {
        if (/可以了|记下来|做成了/.test(last)) return { ok: true, text: 'done' }
        if (/算了|不教了/.test(last)) return { ok: true, text: 'abort' }
        if (/先在桌面|创建/.test(last)) return { ok: true, text: 'step' }
        return { ok: true, text: 'open' }
      }
      if (last.includes('带教归纳')) {
        return { ok: true, text: 'OK: 写今日桌面笔记\nFAST: 用写文件创建今日笔记' }
      }
      if (last.includes('脚本拆分')) {
        return { ok: true, text: 'NONE' }
      }
      if (last.includes('对话带教')) {
        return { ok: true, text: '本步做好了，等你下一步。' }
      }
      return { ok: true, text: 'ok' }
    },
  })

  try {
    await bridge.startTeaching('我教你一下把今天心情写到桌面')
    assert.equal(bridge.isTeaching(), true)
    assert.ok(wakes.some((t) => t.includes('带教抽目标')), '开场应抽目标')
    assert.ok(!wakes.some((t) => t.includes('可执行的本步指示')), '开场不应叫醒动手')

    wakes.length = 0
    await bridge.handleCoachUtterance('先在桌面创建一个心情记录文件')
    assert.ok(wakes.some((t) => t.includes('可执行的本步指示')), 'step 应叫醒动手')
    assert.ok(!wakes.some((t) => /图内坐标|2×2|拼图/.test(t)), '不应喂教学拼图')

    await bridge.handleCoachUtterance('可以了，记下来吧')
    assert.equal(bridge.isTeaching(), false)

    const idx = await listLearnedIndex(home)
    assert.equal(idx.length, 1)
    const pair = await assertLearnedAutomationPair(home, idx[0].id)
    assert.equal(pair.ok, true)
    assert.equal(pair.learn.v, 2)
    assert.equal(pair.learn.coach?.status, 'verified')
    assert.match(pair.learn.understanding?.summary || '', /笔记|心情|桌面/)
    assert.equal(Array.isArray(pair.playbook.steps) ? pair.playbook.steps.length : 0, 0)
    assert.ok(existsSync(coachLogPath(home, idx[0].id, { learned: true })))
    const mem = JSON.parse(readFileSync(memoryPath, 'utf8'))
    const last = mem.main.main.messages.at(-1)
    assert.match(last.content, /我学会了/)
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    bridge.stop()
  }
})

test('对话带教：模型判 open → 不动手', async () => {
  await saveSettings(home, { actEnabled: true })
  const wakes = []
  const bridge = createTeachBridge({
    home,
    ctx: { get: () => null },
    log() {},
    pollChat: false,
    getPreferredSessionId: () => 'sess-open',
    prepareSession: async () => ({ sessionId: 'so', fresh: true }),
    wake: async (_ctx, opts) => {
      wakes.push(String(opts.text || ''))
      return { ok: true, sessionId: 'so' }
    },
    waitReply: async () => {
      const last = wakes[wakes.length - 1] || ''
      if (last.includes('带教抽目标')) return { ok: true, text: 'GOAL: 记录今日心情' }
      if (last.includes('带教分流')) return { ok: true, text: 'open' }
      return { ok: true, text: 'ok' }
    },
  })

  await bridge.startTeaching('现在我开始教你记录今日心情')
  wakes.length = 0
  await bridge.handleCoachUtterance('好了开始吧')
  assert.ok(!wakes.some((t) => t.includes('可执行的本步指示')), 'open 不应叫醒动手')
  assert.equal(bridge.isTeaching(), true)
  bridge.stop()
})

test('对话带教：模型判 abort → 不落学会', async () => {
  await saveSettings(home, { actEnabled: true })
  const wakes = []
  const bridge = createTeachBridge({
    home,
    ctx: { get: () => null },
    log() {},
    pollChat: false,
    getPreferredSessionId: () => 'sess-2',
    prepareSession: async () => ({ sessionId: 's2', fresh: true }),
    wake: async (_ctx, opts) => {
      wakes.push(String(opts.text || ''))
      return { ok: true, sessionId: 's2' }
    },
    waitReply: async () => {
      const last = wakes[wakes.length - 1] || ''
      if (last.includes('带教抽目标')) return { ok: true, text: 'GOAL: 打开记事本' }
      if (last.includes('带教分流')) return { ok: true, text: 'abort' }
      return { ok: true, text: 'ok' }
    },
  })

  const before = (await listLearnedIndex(home)).length
  await bridge.startTeaching('我教你打开记事本')
  await bridge.handleCoachUtterance('算了不教了')
  assert.equal(bridge.isTeaching(), false)
  const after = await listLearnedIndex(home)
  assert.equal(after.length, before)
  bridge.stop()
})

test('对话带教：带教已结束后迟到的 abort 分流不再冒泡', async () => {
  await saveSettings(home, { actEnabled: true })
  const wakes = []
  /** @type {((v: { ok: boolean, text: string }) => void) | null} */
  let releaseClassify = null
  const memoryPath = join(home, 'pet-memory-stale-abort.json')
  const bridge = createTeachBridge({
    home,
    petMemoryPath: memoryPath,
    ctx: { get: () => null },
    log() {},
    pollChat: false,
    getPreferredSessionId: () => 'sess-stale',
    prepareSession: async () => ({ sessionId: 'sstale', fresh: true }),
    wake: async (_ctx, opts) => {
      wakes.push(String(opts.text || ''))
      return { ok: true, sessionId: 'sstale' }
    },
    waitReply: async () => {
      const last = wakes[wakes.length - 1] || ''
      if (last.includes('带教抽目标')) return { ok: true, text: 'GOAL: 记心情' }
      if (last.includes('带教分流')) {
        return new Promise((resolve) => {
          releaseClassify = resolve
        })
      }
      return { ok: true, text: 'ok' }
    },
  })

  await bridge.startTeaching('我教你记心情')
  assert.equal(bridge.isTeaching(), true)
  const pending = bridge.handleCoachUtterance('算了不教了')
  for (let i = 0; i < 40 && !releaseClassify; i += 1) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(releaseClassify, '分流应已挂起')
  // 分流还在 await 时带教已被外部结束（做成了 / stop / 重装）
  bridge.stop()
  assert.equal(bridge.isTeaching(), false)
  releaseClassify({ ok: true, text: 'abort' })
  await pending
  assert.equal(bridge.isTeaching(), false)
  if (existsSync(memoryPath)) {
    const mem = JSON.parse(readFileSync(memoryPath, 'utf8'))
    const msgs = mem?.main?.main?.messages || []
    assert.ok(
      !msgs.some((m) => String(m.content || '').includes('这轮带教先停下')),
      '过期 abort 不应再写入「先停下」',
    )
  }
})
