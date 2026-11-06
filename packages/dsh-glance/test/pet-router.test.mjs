import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createPetRouter } from '../src/pet-router.js'
import { setDshPetBaseUrl } from '../src/dsh-pet.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  setDshPetBaseUrl('')
})

test('pet-router：一次分流后分发 task', async () => {
  setDshPetBaseUrl('http://127.0.0.1:9')
  const calls = []
  let round = 0
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const method = init?.method || 'GET'
    if (u.includes('/chat') && method === 'GET') {
      round += 1
      const messages = round === 1
        ? [{ role: 'user', content: '旧消息', ts: 1 }]
        : [
          { role: 'user', content: '旧消息', ts: 1 },
          { role: 'user', content: '把记事本最小化', ts: 2 },
        ]
      return { ok: true, status: 200, async json() { return { ok: true, messages } } }
    }
    if (u.includes('/broadcast')) {
      return { ok: true, status: 200, async json() { return { ok: true } } }
    }
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }

  const router = createPetRouter({
    ctx: {},
    home: '',
    log() {},
    classify: async (_ctx, text) => {
      calls.push(['classify', text])
      return { label: 'task', via: 'inject' }
    },
    chatBridge: { handleIntent: async (t) => { calls.push(['glance', t]) } },
    agentBridge: { handleTask: async (t) => { calls.push(['task', t]) } },
    teachBridge: {
      isTeaching: () => false,
      startTeaching: async (t) => { calls.push(['teach', t]) },
      stopAndRun: async () => { calls.push(['teach_end']) },
    },
  })

  await router.tick() // baseline
  await router.tick() // route
  assert.deepEqual(calls, [
    ['classify', '把记事本最小化'],
    ['task', '把记事本最小化'],
  ])
  router.stop()
})

test('pet-router：教学中只关心 teach_end', async () => {
  const calls = []
  const router = createPetRouter({
    ctx: {},
    home: '',
    log() {},
    classify: async () => ({ label: 'teach_end', via: 'inject' }),
    chatBridge: { handleIntent: async () => { calls.push('glance') } },
    agentBridge: { handleTask: async () => { calls.push('task') } },
    teachBridge: {
      isTeaching: () => true,
      startTeaching: async () => { calls.push('teach') },
      stopAndRun: async () => { calls.push('stop') },
    },
  })
  await router.route('好了你可以去做了')
  assert.deepEqual(calls, ['stop'])
})
