import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  appendTeachEvent,
  buildPublicPlan,
  createTeachSession,
  narratePlan,
  newTeachSessionId,
  readTeachEvents,
  readTeachSecrets,
} from '../src/teach-store.js'

const home = mkdtempSync(join(tmpdir(), 'glance-teach-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('敏感 type 进 secrets，公开计划无原文', async () => {
  const id = newTeachSessionId()
  await createTeachSession(home, id, { goal: '登录' })
  await appendTeachEvent(home, id, {
    kind: 'click',
    x: 10,
    y: 20,
    button: 'left',
    window: { title: '记事本' },
  }, 0)
  await appendTeachEvent(home, id, {
    kind: 'type',
    text: 'super-secret',
    sensitive: true,
    window: { title: '密码本.txt - 记事本' },
  }, 1)

  const events = await readTeachEvents(home, id)
  assert.equal(events.length, 2)
  assert.equal(events[1].text, undefined)
  assert.equal(events[1].secretRef, 'step:1')

  const secrets = await readTeachSecrets(home, id)
  assert.equal(secrets['step:1'], 'super-secret')

  const plan = buildPublicPlan(events)
  assert.equal(plan[1].secretRef, 'step:1')
  assert.equal(plan[1].text, undefined)
  assert.match(narratePlan(plan), /敏感/)
})
