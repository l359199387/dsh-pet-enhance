import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FULL_ACCESS_PERMISSION,
  STANDARD_AGENT_PRESET,
  DEFAULT_REASONING_EFFORT,
  applySessionPermissionPreset,
  applySessionReasoningEffort,
  applySessionTitle,
  applyStandardTranscriptMode,
  applyWorkspaceName,
  clipSessionTitle,
  ensurePetWorkspace,
  extractCreatedSessionId,
  findWorkspaceForSession,
  openNewWorkspaceSession,
  PET_WORKSPACE_NAME,
  prepareFreshRunSession,
  readSessionPermissionPreset,
} from '../src/session-spawn.js'

test('clipSessionTitle', () => {
  assert.equal(clipSessionTitle('记录心情'), '小蓝鲸｜记录心情')
  assert.ok(clipSessionTitle('x'.repeat(80)).length <= 40)
})

test('ensurePetWorkspace：走 workspaceController.rename 写 title', async () => {
  const workspaces = [
    { id: 'ws1', path: 'C:/proj/default-workspace', title: '默认工作区', sessionIds: ['s1'] },
  ]
  const renames = []
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => workspaces,
          get: (id) => workspaces.find((x) => x.id === id) || null,
        }
      }
      if (name === 'workspaceController') {
        return {
          async rename(req) {
            renames.push(req)
            const w = workspaces.find((x) => x.id === req.workspaceId)
            if (w) w.title = req.title
            return { workspace: w }
          },
        }
      }
      if (name === 'sessions') {
        return { get: () => null, list: () => [] }
      }
      return null
    },
  }
  const r = await ensurePetWorkspace(ctx, { preferredId: 's1', log() {} })
  assert.equal(r.ok, true)
  assert.equal(r.renamed, true)
  assert.equal(r.workspace.name, PET_WORKSPACE_NAME)
  assert.equal(workspaces[0].title, PET_WORKSPACE_NAME)
  assert.deepEqual(renames[0], { workspaceId: 'ws1', title: PET_WORKSPACE_NAME })
  assert.equal(await applyWorkspaceName(ctx, 'ws1', PET_WORKSPACE_NAME), true)
})

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

  assert.deepEqual(findWorkspaceForSession(ctx, 's1'), { id: 'ws1', path: 'C:/proj', name: null })
  assert.equal(readSessionPermissionPreset(ctx, 's1'), 'danger-full-access')
  assert.equal(applySessionPermissionPreset(ctx, 's2', 'danger-full-access'), true)
  assert.equal(readSessionPermissionPreset(ctx, 's2'), 'danger-full-access')
  assert.equal(applyStandardTranscriptMode(ctx), true)
})

test('openNewWorkspaceSession：workspaceId + 事后 rename 标题', async () => {
  const sessions = new Map([['old', { id: 'old' }]])
  const perms = new Map([[sessions.get('old'), 'workspace-write']])
  const selections = []
  let modes = []
  let createReq = null
  const renames = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async create(req) {
            createReq = req
            assert.equal(req.workspaceId, 'ws1')
            assert.equal(req.title, undefined)
            assert.equal(req.agentPreset, STANDARD_AGENT_PRESET)
            const neu = { id: 'new' }
            sessions.set('new', neu)
            return { sessionId: 'new' }
          },
          async rename(req) {
            renames.push(req)
            const s = sessions.get(String(req.sessionId))
            if (s) s.title = req.title
            return { title: req.title, seq: 1 }
          },
          async resolveAgent(id) {
            const session = sessions.get(String(id))
            return {
              agent: {
                session,
                model: {
                  current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
                  select: (sel) => { selections.push(sel) },
                },
              },
            }
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
        return {
          list: () => [{ id: 'ws1', path: 'C:/p', title: PET_WORKSPACE_NAME, sessionIds: ['old'] }],
          get: () => ({ id: 'ws1', path: 'C:/p', title: PET_WORKSPACE_NAME }),
        }
      }
      if (name === 'workspaceController') {
        return { async rename() { return {} } }
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
  assert.equal(r.permission, FULL_ACCESS_PERMISSION)
  assert.equal(r.permissionCopied, true)
  assert.equal(r.modeStandard, true)
  assert.equal(r.agentPreset, STANDARD_AGENT_PRESET)
  assert.equal(r.reasoningEffort, DEFAULT_REASONING_EFFORT)
  assert.equal(r.reasoningApplied, true)
  assert.equal(r.revealed, true)
  assert.equal(r.titled, true)
  assert.deepEqual(createReq?.agentPreset, STANDARD_AGENT_PRESET)
  assert.equal(createReq?.workspaceId, 'ws1')
  assert.deepEqual(renames[0], { sessionId: 'new', title: '小蓝鲸｜交办' })
  assert.equal(sessions.get('new').title, '小蓝鲸｜交办')
  assert.deepEqual(modes, ['standard'])
  assert.deepEqual(opened, ['new'])
  assert.equal(readSessionPermissionPreset(ctx, 'new'), FULL_ACCESS_PERMISSION)
  assert.deepEqual(selections.at(-1), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'low',
  })
})

test('prepareFreshRunSession：失败时回落旧会话', async () => {
  const sessions = new Map([['old', { id: 'old' }]])
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async create() { throw new Error('boom') },
        }
      }
      if (name === 'sessions') {
        return {
          get: (id) => sessions.get(String(id)) || null,
          list: () => [...sessions.values()],
        }
      }
      if (name === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws1', sessionIds: ['old'] }] }
      }
      return null
    },
  }
  const r = await prepareFreshRunSession(ctx, { preferredId: 'old', log() {} })
  assert.equal(r.fresh, false)
  assert.equal(r.sessionId, 'old')
})

test('applySessionTitle：sessionController.rename', async () => {
  const sessions = new Map([['s1', { id: 's1', title: '' }]])
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async rename(req) {
            const s = sessions.get(String(req.sessionId))
            if (s) s.title = req.title
            return { title: req.title, seq: 1 }
          },
        }
      }
      if (name === 'sessions') {
        return { get: (id) => sessions.get(String(id)) || null }
      }
      return null
    },
  }
  assert.equal(await applySessionTitle(ctx, 's1', '小蓝鲸｜带教｜记心情'), true)
  assert.equal(sessions.get('s1').title, '小蓝鲸｜带教｜记心情')
})

test('applySessionReasoningEffort：无 model 时 false', async () => {
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async resolveAgent() {
            return { agent: { model: { current: () => null } } }
          },
        }
      }
      return null
    },
  }
  assert.equal(await applySessionReasoningEffort(ctx, 'x', 'low'), false)
})
