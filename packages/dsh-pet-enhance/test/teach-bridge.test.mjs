import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildLearnedChatNotice,
  buildTeachDigestPrompt,
  createTeachBridge,
  isLikelyAddressBarNoise,
  isVagueReplayIntent,
  parseTeachDigestReply,
  shouldAttachTeachDigestImages,
} from '../src/teach-bridge.js'
import { AGENT_WAKE_PREFIX } from '../src/intent.js'
import { assertLearnedAutomationPair, listLearnedIndex } from '../src/learned-automation.js'
import { learnedFramesDir } from '../src/teach-frames.js'
import { saveSettings } from '../src/settings.js'

const home = mkdtempSync(join(tmpdir(), 'glance-teach-b-'))
after(() => rmSync(home, { recursive: true, force: true }))

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

test('buildLearnedChatNotice：含目标与理解', () => {
  const t = buildLearnedChatNotice({
    goal: '和豆包聊天',
    summary: '示范闲聊并看回复',
    fastPlan: '打开豆包会话直接说你好',
    id: 'sid-1',
  })
  assert.match(t, /我学会了「和豆包聊天」/)
  assert.match(t, /理解：/)
  assert.match(t, /更快做法：/)
  assert.match(t, /我学会的/)
})

test('shouldAttachTeachDigestImages：键入为主不附图', () => {
  assert.equal(shouldAttachTeachDigestImages([
    { action: 'click' },
    { action: 'type', text: 'a' },
  ]), true)
  assert.equal(shouldAttachTeachDigestImages([
    { action: 'click' },
    { action: 'type' }, { action: 'type' }, { action: 'type' },
    { action: 'key' }, { action: 'key' }, { action: 'type' },
  ]), false)
  assert.equal(shouldAttachTeachDigestImages([
    { action: 'type' }, { action: 'key' },
  ]), false)
})

test('地址栏脏输入与模糊回放口令', () => {
  assert.equal(isLikelyAddressBarNoise('bilibli1'), true)
  assert.equal(isLikelyAddressBarNoise('dafeiyu1'), true)
  assert.equal(isLikelyAddressBarNoise('https://www.bilibili.com'), false)
  assert.equal(isLikelyAddressBarNoise('今天心情不错'), false)
  assert.equal(isVagueReplayIntent('再做一次'), true)
  assert.equal(isVagueReplayIntent('ibli1'), false)
  assert.equal(isVagueReplayIntent('继续去看看B站'), false)
})

test('parseTeachDigestReply：OK / NEED_MORE / FAST', () => {
  assert.equal(parseTeachDigestReply('NEED_MORE').needMore, true)
  assert.equal(parseTeachDigestReply('OK: 在记事本写心情').summary.includes('心情'), true)
  assert.match(parseTeachDigestReply('OK: 进B站\nFAST: 打开 bilibili.com').fastPlan, /bilibili/)
  assert.ok(buildTeachDigestPrompt('g', 'n', 3).startsWith(AGENT_WAKE_PREFIX))
  assert.match(buildTeachDigestPrompt('g', 'n', 3), /FAST/)
  const withClick = buildTeachDigestPrompt('g', 'n', [{
    role: 'click',
    name: '00-click-step0.png',
    click: {
      eventI: 0, action: 'click', screenX: 800, screenY: 450,
      imageX: 200, imageY: 200, imageW: 400, imageH: 400, mapped: true,
      crop: { x: 600, y: 250, w: 400, h: 400 },
    },
  }])
  assert.match(withClick, /图内坐标 \(200,200\)/)
})

test('教完：点击截图+坐标喂模型、建对、关实时看屏幕、不自动动手', async () => {
  await saveSettings(home, { liveWatch: true, actEnabled: true })
  const acts = []
  const liveOps = []
  const wakes = []
  const queued = [
    { kind: 'click', x: 800, y: 450, button: 'left', window: { title: '桌面' } },
    { kind: 'click', x: 900, y: 500, button: 'right', window: { title: '桌面' } },
    { kind: 'scroll_start', x: 820, y: 460, delta: 1, window: { title: '桌面' } },
    { kind: 'scroll_end', x: 820, y: 460, delta: 5, window: { title: '桌面' } },
    { kind: 'key', keys: 'ctrl+s', window: { title: '记事本' } },
    { kind: 'type', text: 'hello', window: { title: '记事本' } },
  ]
  const schedules = []
  const prevDsh = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const memoryPath = join(home, 'pet-memory.json')
  const denyCodes = []
  const bridge = createTeachBridge({
    home,
    petMemoryPath: memoryPath,
    confirmGate: {
      async ask({ action }) {
        // 第一问点「不要」也不应取消学会
        if (action?.clarify === 'purpose') {
          denyCodes.push(action.clarify)
          return { allow: false }
        }
        return { allow: true }
      },
    },
    ctx: {
      get(name) {
        if (name === 'schedule') {
          return {
            async create(sessionId, request) {
              schedules.push({ sessionId, request })
              return { id: 'sched-1', title: request.title }
            },
          }
        }
        return null
      },
    },
    log() {},
    pollChat: false,
    getPreferredSessionId: () => 'sess-teach',
    capture: async (opts) => {
      if (opts?.region) {
        return {
          png: tinyPng,
          width: opts.region.w,
          height: opts.region.h,
          screen: { w: 1600, h: 900, virtual: { x: 0, y: 0, w: 1600, h: 900 } },
          window: { title: '桌面' },
        }
      }
      return {
        png: tinyPng,
        width: 798,
        height: 449,
        screen: { w: 1600, h: 900 },
        window: { title: '记事本' },
      }
    },
    ensureLiveWatch: async (on) => { liveOps.push(on) },
    attachments: {
      async saveImage() { return { id: 'att-1' } },
    },
    prepareSession: async () => ({ sessionId: 'fresh-teach', fresh: true }),
    wake: async (_ctx, opts) => {
      wakes.push({
        images: opts.images?.length || 0,
        text: opts.text,
        sessionId: opts.sessionId,
      })
      return { ok: true, sessionId: opts.sessionId || 's1' }
    },
    waitReply: async () => ({ ok: true, text: 'OK: 保存记事本里的内容' }),
    sidecar: {
      isAlive: () => true,
      getHello: () => ({ screen: { w: 1600, h: 900, virtual: { x: 0, y: 0, w: 1600, h: 900 } } }),
      async call(op, fields) {
        if (op !== 'observe') return { ok: false }
        if (fields.action === 'start') return { ok: true, running: true, events: [] }
        if (fields.action === 'poll') {
          const batch = queued.splice(0, queued.length)
          return { ok: true, running: true, events: batch }
        }
        if (fields.action === 'stop') return { ok: true, running: false, events: [] }
        return { ok: true, events: [] }
      },
    },
    runAct: async (args) => {
      acts.push(args)
      return { text: 'ok', meta: { ok: true } }
    },
  })

  try {
    await bridge.startTeaching('我教你一下保存文件')
    await bridge.stopAndRun()
    assert.equal(acts.length, 0)
    assert.ok(wakes.some((w) => w.images >= 1), '理解时应喂点击截图')
    assert.ok(wakes.some((w) => /图内坐标|屏幕\(/.test(w.text)), '提示应含点击坐标')
    assert.ok(liveOps.includes(false), '学完应关实时看屏幕')
    const idx = await listLearnedIndex(home)
    assert.equal(idx.length, 1)
    const pair = await assertLearnedAutomationPair(home, idx[0].id)
    assert.equal(pair.ok, true)
    assert.ok(existsSync(join(learnedFramesDir(home, idx[0].id), 'manifest.json')))
    assert.ok(pair.learn.frames?.forLearningOnly)
    assert.ok(
      pair.playbook.steps.some((s) => s.kind === 'typed-text' && s.text === 'hello'),
      '用户键入应记成 typed-text',
    )
    const clickStep = pair.playbook.steps.find((s) => s.action === 'click' && s.button === 'left')
    assert.ok(clickStep?.hint?.frameFile, '点击步应绑定截图文件')
    assert.equal(clickStep.hint.imageX, 200)
    assert.equal(clickStep.hint.imageY, 200)
    assert.ok(pair.playbook.steps.some((s) => s.action === 'click' && s.button === 'right'), '右键也应记录')
    const scrolls = pair.playbook.steps.filter((s) => s.action === 'scroll')
    assert.equal(scrolls.length, 2)
    assert.ok(scrolls.every((s) => s.hint?.frameFile), '滑轮起止都应有截图')
    assert.ok(wakes.some((w) => /滚动开始|滚动结束/.test(w.text)), '理解提示应含滑轮起止')
    assert.equal(schedules.length, 0, '未说明几点/每周几时不应登记 Harness 定时')
    assert.deepEqual(denyCodes, ['purpose'])
    assert.deepEqual(pair.learn.understanding?.denied, ['purpose'])
    const mem = JSON.parse(readFileSync(memoryPath, 'utf8'))
    const last = mem.main.main.messages.at(-1)
    assert.equal(last.role, 'assistant')
    assert.match(last.content, /我学会了/)
    assert.match(last.content, /我学会的/)
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    bridge.stop()
  }
})
