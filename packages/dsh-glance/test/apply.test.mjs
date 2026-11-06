/**
 * 「装得上、拔得掉」的最小证明：不启动 DSH，用假 ctx 跑一遍 apply。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apply, ROUTE_PREFIX } from '../src/index.js'

let home
let registered

before(() => {
  home = mkdtempSync(join(tmpdir(), 'glance-test-'))
  process.env.DSH_GLANCE_HOME = home
  process.env.DSH_GLANCE_NO_SIDECAR = '1'
})

after(() => {
  delete process.env.DSH_GLANCE_HOME
  delete process.env.DSH_GLANCE_NO_SIDECAR
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

test('apply 注册路由与 glance 工具，status 到 B2', async () => {
  const ctx = fakeCtx()
  const dispose = await apply(ctx)
  await flush()

  assert.equal(typeof dispose, 'function')
  assert.equal(registered?.kind, 'prefix')
  assert.equal(registered?.path, ROUTE_PREFIX)
  assert.equal(ctx._tools.length, 1)
  assert.equal(ctx._tools[0].name, 'glance')

  const res = await call(`${ROUTE_PREFIX}/status`)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.stage, 'B2')
  assert.equal(body.home, home)
  assert.deepEqual(body.tools, ['glance'])
  assert.equal(body.pet, 'idle')

  dispose()
  for (const off of ctx._disposers) off()
  assert.equal(registered, undefined)
  assert.equal(ctx._tools.length, 0)
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

  dispose()
})
