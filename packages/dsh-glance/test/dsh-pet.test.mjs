import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DSH_PET_PREFIX, probeDshPet, callDshPet } from '../src/dsh-pet.js'

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
