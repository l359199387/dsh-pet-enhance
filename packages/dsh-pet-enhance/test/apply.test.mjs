/**
 * 「装得上、拔得掉」的最小证明：不启动 DSH，用假 ctx 跑一遍 apply。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apply, ROUTE_PREFIX, glanceHome } from '../src/index.js'
import { readDesktopToken } from '../src/desktop-token.js'

let home
let registered

before(() => {
  home = mkdtempSync(join(tmpdir(), 'glance-test-'))
  process.env.DSH_PET_ENHANCE_HOME = home
  process.env.DSH_PET_ENHANCE_NO_SIDECAR = '1'
})

after(() => {
  delete process.env.DSH_PET_ENHANCE_HOME
  delete process.env.DSH_PET_ENHANCE_NO_SIDECAR
  rmSync(home, { recursive: true, force: true })
})

async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise((done) => setTimeout(done, 0))
}

function fakeCtx() {
  const disposers = []
  const tools = []
  return {
    logger: { info() {}, error() {} },
    inject(services, cb) {
      const scoped = {
        effect(fn) { disposers.push(fn()) },
        get() { return undefined },
      }
      if (services.includes('webServer')) {
        scoped.webServer = {
          register(options) {
            registered = options
            return () => { registered = undefined }
          },
        }
      }
      if (services.includes('tools')) {
        scoped.tools = {
          register(tool) {
            tools.push(tool)
            return () => {
              const index = tools.indexOf(tool)
              if (index >= 0) tools.splice(index, 1)
            }
          },
        }
        scoped.attachments = { saveImage: async () => ({ id: 'fake-image' }) }
      }
      cb(scoped)
    },
    _disposers: disposers,
    _tools: tools,
  }
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.body = text },
  }
}

async function call(url, { method = 'GET', headers = { host: '127.0.0.1:50521' }, body } = {}) {
  const res = fakeRes()
  const req = new EventEmitter()
  req.url = url
  req.method = method
  req.headers = headers
  const pending = registered.handler(req, res)
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  } else if (method === 'POST') {
    queueMicrotask(() => req.emit('end'))
  }
  await pending
  return res
}

test('apply 注册路由与工具，status 到 C2', async () => {
  const ctx = fakeCtx()
  const dispose = await apply(ctx)
  await flush()

  assert.equal(typeof dispose, 'function')
  assert.equal(registered?.kind, 'prefix')
  assert.equal(registered?.path, ROUTE_PREFIX)
  assert.equal(ctx._tools.length, 2)
  assert.deepEqual(ctx._tools.map((t) => t.name), ['glance', 'act'])

  const res = await call(`${ROUTE_PREFIX}/status`)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.stage, 'C2')
  assert.ok(body.tools.includes('glance'))
  assert.ok(body.tools.includes('act'))
  assert.equal(body.home, home)
  assert.deepEqual(body.tools, ['glance', 'act'])
  assert.equal(body.pet, 'idle')
  assert.equal(body.budget.max, 30)

  dispose()
  for (const off of ctx._disposers) off()
  assert.equal(registered, undefined)
  assert.equal(ctx._tools.length, 0)
})

test('/confirm 需要有效挂起 id', async () => {
  const ctx = fakeCtx()
  const dispose = await apply(ctx)
  await flush()

  const miss = await call(`${ROUTE_PREFIX}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ id: 'nope', allow: true }),
  })
  assert.equal(miss.status, 409)

  dispose()
  for (const off of ctx._disposers) off()
})

test('/state 与 /stop 驱动宠物叶子', async () => {
  const ctx = fakeCtx()
  const dispose = await apply(ctx)
  await flush()

  const stateRes = await call(`${ROUTE_PREFIX}/state`)
  assert.equal(stateRes.status, 200)
  const stateBody = JSON.parse(stateRes.body)
  assert.equal(stateBody.ok, true)
  assert.equal(stateBody.pet.state.data, 'idle')

  const stopRes = await call(`${ROUTE_PREFIX}/stop`, { method: 'POST', body: '{}' })
  assert.equal(stopRes.status, 200)
  assert.equal(JSON.parse(stopRes.body).pet, 'alarmed')

  const after = JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body)
  assert.equal(after.pet.state.data, 'alarmed')
  assert.equal(after.guard.armed.data, false)

  const petRes = await call(`${ROUTE_PREFIX}/pet`, {
    method: 'POST',
    body: JSON.stringify({ state: 'sleeping' }),
  })
  assert.equal(petRes.status, 200)
  assert.equal(JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body).pet.state.data, 'sleeping')

  dispose()
  for (const off of ctx._disposers) off()
})

test('不受信任的请求在进入业务逻辑之前就被拒', async () => {
  const ctx = fakeCtx()
  const dispose = await apply(ctx)
  await flush()

  const res = await call(`${ROUTE_PREFIX}/status`, { headers: { host: 'evil.example' } })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).ok, false)

  const token = readDesktopToken(glanceHome())
  assert.ok(token)
  const ok = await call(`${ROUTE_PREFIX}/status`, {
    headers: { host: 'evil.example', 'x-pet-enhance-token': token },
  })
  assert.equal(ok.status, 200)

  dispose()
})
