import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createLearnedAutomationPair, listLearnedIndex } from '../src/learned-automation.js'
import { buildPlaybook } from '../src/teach-store.js'
import {
  deleteLearnedPair,
  getLearnedDetail,
  listLearnedDetails,
  patchLearnedScheduleMeta,
  updateLearnedPair,
} from '../src/learned-manage.js'
import { skillSlugFromId } from '../src/harness-schedule.js'

const home = mkdtempSync(join(tmpdir(), 'glance-lm-'))
const prevDsh = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (prevDsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDsh
  rmSync(home, { recursive: true, force: true })
})

async function seed(id, goal = '记录心情') {
  const playbook = buildPlaybook(goal, [
    { action: 'type', text: 'ok', window: '记事本' },
  ], id)
  return createLearnedAutomationPair(home, {
    id,
    goal,
    teachSessionId: id,
    understanding: { summary: 'demo', stats: playbook.stats, clarified: [] },
    evidence: [],
    playbook,
  })
}

test('list / update：改 goal 与主人想法；有想法时归纳理解', async () => {
  const id = 'learn-upd-1'
  await seed(id, '旧目标')
  let list = await listLearnedDetails(home)
  assert.ok(list.some((x) => x.id === id))

  const wakes = []
  const r = await updateLearnedPair(home, id, {
    goal: '新目标',
    ownerNotes: '希望简短，写到桌面日记',
  }, {
    ctx: { get() { return null } },
    async wake(_ctx, opts) {
      wakes.push(opts.text)
      return { ok: true, sessionId: 's1' }
    },
    async waitReply() {
      return { ok: true, text: 'SUMMARY: 记录心情时写到桌面日记，表述简短。' }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.merged, true)
  assert.equal(r.detail.goal, '新目标')
  assert.equal(r.detail.ownerNotes, '', '归纳完成后补充应清空')
  assert.match(r.detail.understanding, /桌面日记/)
  assert.equal(wakes.length, 1)
  assert.match(wakes[0], /主人补充/)

  const detail = await getLearnedDetail(home, id)
  assert.equal(detail.goal, '新目标')
  assert.equal(detail.ownerNotes, '')
  assert.match(detail.understanding, /桌面日记/)
  const idx = await listLearnedIndex(home)
  assert.equal(idx.find((x) => x.id === id)?.goal, '新目标')
})

test('delete：清本地目录；无 scheduleId 不调 schedule.delete', async () => {
  const id = 'learn-del-1'
  await seed(id)
  await patchLearnedScheduleMeta(home, id, {
    scheduleId: null,
    scheduled: false,
    skillName: skillSlugFromId(id),
  })
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'schedule') {
        return {
          async delete(...args) { calls.push(args) },
        }
      }
      return null
    },
  }
  const r = await deleteLearnedPair(home, id, { ctx })
  assert.equal(r.ok, true)
  assert.equal(r.scheduleDeleted, false)
  assert.equal(calls.length, 0)
  assert.equal(existsSync(join(home, 'learned', id)), false)
  assert.equal(existsSync(join(home, 'automations', id)), false)
  assert.equal((await listLearnedIndex(home)).some((x) => x.id === id), false)
})

test('delete：有 scheduleId 会调 schedule.delete', async () => {
  const id = 'learn-del-2'
  await seed(id)
  await patchLearnedScheduleMeta(home, id, {
    scheduleId: 'sched-99',
    scheduleSessionId: 'sess-9',
    scheduled: true,
    timingLabel: '每天 21:00',
    skillName: skillSlugFromId(id),
  })
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'schedule') {
        return {
          async delete(arg) { calls.push(arg); return { ok: true } },
        }
      }
      return null
    },
  }
  const r = await deleteLearnedPair(home, id, { ctx })
  assert.equal(r.ok, true)
  assert.equal(r.scheduleDeleted, true)
  assert.equal(calls[0]?.id, 'sched-99')
  assert.equal(calls[0]?.sessionId, 'sess-9')
})
