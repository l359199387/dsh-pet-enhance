import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  DSH_PET_PREFIX,
  probeDshPet,
  callDshPet,
  resolveDshOrigin,
  setDshPetBaseUrl,
  getDshPetBaseUrl,
} from '../src/dsh-pet.js'

afterEach(() => {
  setDshPetBaseUrl('')
  delete process.env.DSH_WEB_URL
})

test('前缀固定，避免和别的插件撞车', () => {
  assert.equal(DSH_PET_PREFIX, '/dsh-pet-7340')
})

test('probeDshPet：200 且有 pets 视为可用', async () => {
  const fakeFetch = async () => ({
    ok: true,
    async json() { return { counter: 1, pets: { main: {} } } },
  })
  const r = await probeDshPet({ fetchImpl: fakeFetch, timeoutMs: 500 })
  assert.equal(r.available, true)
  assert.deepEqual(r.pets, ['main'])
})

test('probeDshPet：网络失败 → unavailable', async () => {
  const fakeFetch = async () => { throw new Error('boom') }
  const r = await probeDshPet({ fetchImpl: fakeFetch, timeoutMs: 500 })
  assert.equal(r.available, false)
  assert.match(r.error || '', /boom/)
})

test('callDshPet 组相对路径并带 JSON', async () => {
  let seen
  const fakeFetch = async (url, init) => {
    seen = { url, init }
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }
  const r = await callDshPet('/work-status', {
    method: 'POST',
    body: { state: 'working' },
    fetchImpl: fakeFetch,
  })
  assert.equal(r.ok, true)
  assert.equal(seen.url, '/dsh-pet-7340/work-status')
  assert.equal(seen.init.method, 'POST')
  assert.equal(JSON.parse(seen.init.body).state, 'working')
})

test('callDshPet 在 Host 侧拼绝对 origin', async () => {
  setDshPetBaseUrl('http://127.0.0.1:3080')
  let seen
  const fakeFetch = async (url) => {
    seen = url
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }
  await callDshPet('/state', { fetchImpl: fakeFetch })
  assert.equal(seen, 'http://127.0.0.1:3080/dsh-pet-7340/state')
  assert.equal(getDshPetBaseUrl(), 'http://127.0.0.1:3080')
})

test('resolveDshOrigin：优先 DSH_WEB_URL，其次 getOrigin / port', () => {
  process.env.DSH_WEB_URL = 'http://127.0.0.1:1/'
  assert.equal(resolveDshOrigin({ port: 9 }), 'http://127.0.0.1:1')
  delete process.env.DSH_WEB_URL
  assert.equal(resolveDshOrigin({ getOrigin: () => 'http://192.168.1.2:3080/' }), 'http://192.168.1.2:3080')
  assert.equal(resolveDshOrigin({ port: 3080 }), 'http://127.0.0.1:3080')
  assert.equal(resolveDshOrigin(null), '')
})
