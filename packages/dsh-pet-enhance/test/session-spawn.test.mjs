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
  lightestReasoningEffort,
  pickReasoningEffort,
  prepareFreshRunSession,
  readSessionPermissionPreset,
  readSessionReasoningEffort,
} from '../src/session-spawn.js'

test('lightestReasoningEffort：从模型自己的档位里挑最轻', () => {
  assert.equal(lightestReasoningEffort(['high', 'max']), 'high')
  assert.equal(lightestReasoningEffort(['disabled', 'low', 'medium', 'high']), 'disabled')
  assert.equal(lightestReasoningEffort(['medium', 'max']), 'medium')
  assert.equal(lightestReasoningEffort([]), null)
})

test('pickReasoningEffort：看模型菜单，不无条件写 low', () => {
  assert.equal(pickReasoningEffort('low', 'high', null), null)
  assert.equal(pickReasoningEffort('low', 'high', { efforts: [], defaultEffort: null }), null)
  // 上次 high 在菜单里 → 沿用
  assert.equal(
    pickReasoningEffort('low', 'high', { efforts: ['low', 'high', 'max'], defaultEffort: 'high' }),
    'high',
  )
  // 菜单含 low → 用偏好 low
  assert.equal(
    pickReasoningEffort('low', null, { efforts: ['low', 'high'], defaultEffort: 'high' }),
    'low',
  )
  // 菜单无 low（如部分模型只有 high/max）→ 取最轻 high，绝不硬写 low
  assert.equal(
    pickReasoningEffort('low', null, { efforts: ['high', 'max'], defaultEffort: 'max' }),
    'high',
  )
  // 上次不在菜单 → 回落偏好；偏好也不在 → 最轻
  assert.equal(
    pickReasoningEffort('low', 'xhigh', { efforts: ['medium', 'max'], defaultEffort: null }),
    'medium',
  )
})

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

function makeSpawnCtx({
  oldEffort = null,
  newEffort = null,
  reasoning = {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    defaultEffort: 'high',
  },
} = {}) {
  const sessions = new Map([['old', { id: 'old' }]])
  const perms = new Map([[sessions.get('old'), 'workspace-write']])
  const selections = []
  let modes = []
  let createReq = null
  const renames = []
  const modelState = {
    old: { provider: 'deepseek', model: 'deepseek-chat', ...(oldEffort ? { reasoningEffort: oldEffort } : {}) },
    new: { provider: 'deepseek', model: 'deepseek-chat', ...(newEffort ? { reasoningEffort: newEffort } : {}) },
  }
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
            const sid = String(id)
            const session = sessions.get(sid)
            return {
              agent: {
                session,
                model: {
                  current: () => ({ ...modelState[sid] }),
                  select: (sel) => {
                    selections.push(sel)
                    modelState[sid] = { ...modelState[sid], ...sel }
                  },
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
      if (name === 'llm') {
        return {
          async resolveModelInfo() {
            if (!reasoning) {
              return { provider: 'trae', id: 'DeepSeek-V4-Flash' }
            }
            return {
              provider: 'deepseek',
              id: 'deepseek-chat',
              reasoning,
            }
          },
        }
      }
      return null
    },
  }
  return { ctx, sessions, selections, modes, getCreateReq: () => createReq, renames, perms }
}

test('openNewWorkspaceSession：有档默认 low；无档跳过', async () => {
  const { ctx, sessions, selections, modes, getCreateReq, renames } = makeSpawnCtx()
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
  assert.deepEqual(getCreateReq()?.agentPreset, STANDARD_AGENT_PRESET)
  assert.equal(getCreateReq()?.workspaceId, 'ws1')
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

test('openNewWorkspaceSession：沿用上一会话的高档', async () => {
  const { ctx, selections } = makeSpawnCtx({ oldEffort: 'high' })
  const r = await openNewWorkspaceSession({
    get(name) {
      if (name === 'uiWorkspace') return { openSession() {} }
      return ctx.get(name)
    },
  }, { preferredId: 'old' })
  assert.equal(r.ok, true)
  assert.equal(r.reasoningApplied, true)
  assert.equal(r.reasoningEffort, 'high')
  assert.deepEqual(selections.at(-1), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
  })
})

test('openNewWorkspaceSession：trae 无思考档位时不写 reasoningEffort', async () => {
  const { ctx, selections } = makeSpawnCtx({
    oldEffort: 'low',
    reasoning: null,
  })
  const r = await openNewWorkspaceSession({
    get(name) {
      if (name === 'uiWorkspace') return { openSession() {} }
      return ctx.get(name)
    },
  }, { preferredId: 'old' })
  assert.equal(r.ok, true)
  assert.equal(r.reasoningApplied, false)
  assert.equal(r.reasoningEffort, null)
  assert.equal(selections.length, 0)
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

test('applySessionReasoningEffort：无 model 时不写', async () => {
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
  assert.deepEqual(await applySessionReasoningEffort(ctx, 'x', 'low'), {
    applied: false,
    effort: null,
  })
})

test('readSessionReasoningEffort：读上一会话档位', async () => {
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async resolveAgent() {
            return {
              agent: {
                model: {
                  current: () => ({
                    provider: 'deepseek',
                    model: 'deepseek-chat',
                    reasoningEffort: 'max',
                  }),
                },
              },
            }
          },
        }
      }
      return null
    },
  }
  assert.equal(await readSessionReasoningEffort(ctx, 'old'), 'max')
})
