import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createLiveWatch } from '../src/live-watch.js'
import { setDshPetBaseUrl } from '../src/dsh-pet.js'

const realFetch = globalThis.fetch
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

afterEach(() => {
  globalThis.fetch = realFetch
  setDshPetBaseUrl('')
})

test('live-watch：基线不冒泡，变化才 broadcast', async () => {
  setDshPetBaseUrl('http://127.0.0.1:9')
  const posts = []
  globalThis.fetch = async (url, init) => {
    posts.push(`${init?.method || 'GET'} ${url}`)
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }

  let n = 0
  const live = createLiveWatch({
    home: 'C:\\tmp\\glance-live',
    intervalMs: 60_000,
    log() {},
    capture: async () => {
      n += 1
      return {
        png: PNG,
        width: 100,
        height: 80,
        quality: 'low',
        engine: 'test',
        ms: 1,
        window: { title: n === 1 ? 'A' : 'B' },
        screen: { w: 1920, h: 1080 },
      }
    },
  })

  await live.tick()
  assert.ok(!posts.some((p) => p.includes('/broadcast')))

  await live.tick()
  assert.ok(posts.some((p) => p.includes('POST') && p.includes('/broadcast')))
})
