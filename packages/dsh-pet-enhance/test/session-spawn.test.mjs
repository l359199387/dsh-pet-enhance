import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applySessionPermissionPreset,
  applyStandardTranscriptMode,
  extractCreatedSessionId,
  findWorkspaceForSession,
  openNewWorkspaceSession,
  readSessionPermissionPreset,
} from '../src/session-spawn.js'

test('extractCreatedSessionId：多种返回形状', () => {
  assert.equal(extractCreatedSessionId({ sessionId: 'a' }), 'a')
  assert.equal(extractCreatedSessionId({ agent: { id: 'b' } }), 'b')
  assert.equal(extractCreatedSessionId({ id: 'c' }), 'c')
  assert.equal(extractCreatedSessionId(null), null)
})

test('findWorkspaceForSession / 权限读写', () => {
  const sessions = new Map([
    ['s1', { id: 's1' }],
    ['s2', { id: 's2' }],
  ])
  const perms = new Map([[sessions.get('s1'), 'danger-full-access']])
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { get: (id) => sessions.get(String(id)) || null, list: () => [...sessions.values()] }
      }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ id: 'ws1', path: 'C:/proj', sessionIds: ['s1'] }],
        }
      }
      if (name === 'permissionPresets') {
        return {
          current: (s) => perms.get(s) || null,
          set: (s, v) => { perms.set(s, v) },
        }
      }
      if (name === 'presentationPolicy') {
        return { setMode(mode) { this._mode = mode } }
      }
      return null
    },
  }

  assert.deepEqual(findWorkspaceForSession(ctx, 's1'), { id: 'ws1', path: 'C:/proj' })
  assert.equal(readSessionPermissionPreset(ctx, 's1'), 'danger-full-access')
  assert.equal(applySessionPermissionPreset(ctx, 's2', 'danger-full-access'), true)
  assert.equal(readSessionPermissionPreset(ctx, 's2'), 'danger-full-access')
  assert.equal(applyStandardTranscriptMode(ctx), true)
})

test('openNewWorkspaceSession：复制权限并切新 id', async () => {
  const sessions = new Map([['old', { id: 'old' }]])
  const perms = new Map([[sessions.get('old'), 'danger-full-access']])
  let modes = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async create(req) {
            assert.equal(req.workspaceId, 'ws1')
            const neu = { id: 'new' }
            sessions.set('new', neu)
            return { agent: { id: 'new' } }
          },
        }
      }
      if (name === 'sessions') {
        return {
          get: (id) => sessions.get(String(id)) || null,
          list: () => [...sessions.values()],
        }
      }
      if (name === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws1', path: 'C:/p', sessionIds: ['old'] }] }
      }
      if (name === 'permissionPresets') {
        return {
          current: (s) => perms.get(s) || null,
          set: (s, v) => { perms.set(s, v) },
        }
      }
      if (name === 'presentationPolicy') {
        return { setMode(m) { modes.push(m) } }
      }
      return null
    },
  }

  const opened = []
  const r = await openNewWorkspaceSession({
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => { opened.push(id) } }
      return ctx.get(name)
    },
  }, { preferredId: 'old' })
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'new')
  assert.equal(r.permission, 'danger-full-access')
  assert.equal(r.permissionCopied, true)
  assert.equal(r.modeStandard, true)
  assert.equal(r.revealed, true)
  assert.deepEqual(modes, ['standard'])
  assert.deepEqual(opened, ['new'])
  assert.equal(readSessionPermissionPreset(ctx, 'new'), 'danger-full-access')
})
