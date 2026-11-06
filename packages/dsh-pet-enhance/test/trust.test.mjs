/**
 * 信任栅栏的最小回归：这四条规则任何一条写反，前缀路由就变成「本机谁都能写」。
 *
 * 跑法：`node --test packages/dsh-pet-enhance/test`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rejectionFor } from '../src/trust.js'

const req = (headers) => ({ headers })

test('loopback 且没有跨站标记 → 放行', () => {
  assert.equal(rejectionFor(req({ host: '127.0.0.1:50521' }), undefined), undefined)
  assert.equal(rejectionFor(req({ host: 'localhost:50521' }), undefined), undefined)
})

test('非 loopback 的 Host → 403', () => {
  assert.equal(rejectionFor(req({ host: 'evil.example:50521' }), undefined), 403)
})

test('跨站 fetch → 403', () => {
  assert.equal(rejectionFor(req({ host: '127.0.0.1:50521', 'sec-fetch-site': 'cross-site' }), undefined), 403)
})

test('Origin 与 Host 同源 → 放行，不同源 → 403', () => {
  const same = { host: '127.0.0.1:50521', origin: 'http://127.0.0.1:50521' }
  assert.equal(rejectionFor(req(same), undefined), undefined)
  const other = { host: '127.0.0.1:50521', origin: 'http://127.0.0.1:9999' }
  assert.equal(rejectionFor(req(other), undefined), 403)
})

test('桌面转发 Referer 只在不带 origin / sec-fetch-site 时放行', () => {
  assert.equal(rejectionFor(req({ host: '127.0.0.1:50521', referer: 'dsh-app://app' }), undefined), undefined)
  const mixed = { host: '127.0.0.1:50521', referer: 'dsh-app://app', origin: 'http://127.0.0.1:50521' }
  assert.equal(rejectionFor(req(mixed), undefined), 403)
})

test('有 connection 服务时以它的判定为准；它抛错就 503，绝不放行', () => {
  const allowAll = { admit: () => ({}) }
  assert.equal(rejectionFor(req({ host: 'evil.example' }), allowAll), 403, '结构检查仍要兜底')

  const deny = { admit: () => ({ rejection: 401 }) }
  assert.equal(rejectionFor(req({ host: '127.0.0.1:50521' }), deny), 401)

  const boom = { admit: () => { throw new Error('boom') } }
  assert.equal(rejectionFor(req({ host: '127.0.0.1:50521' }), boom), 503)
})
