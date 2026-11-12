import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ackForLabel,
  runChatGate,
  shouldTakeoverChat,
} from '../src/chat-gate.js'
import {
  CHAT_GATE_PATCH_MARK,
  CHAT_GATE_PATCH_MARK_V1,
  patchChatWithPetSource,
  stripChatGateV1,
} from '../src/patch-dsh-pet-chat-gate.js'
import { patchChatClientSource, CHAT_CLIENT_GATE_MARK } from '../src/patch-dsh-pet-chat-client.js'
import {
  CONFIRM_PATCH_MARK,
  CONFIRM_SCRIPT_NAME,
  patchHelperConfirmHtml,
} from '../src/patch-dsh-pet-confirm.js'

test('shouldTakeoverChat：任务/看屏/教学/新开会话接管，闲聊放行', () => {
  assert.equal(shouldTakeoverChat('task'), true)
  assert.equal(shouldTakeoverChat('glance'), true)
  assert.equal(shouldTakeoverChat('teach'), true)
  assert.equal(shouldTakeoverChat('new_session'), true)
  assert.equal(shouldTakeoverChat('chat'), false)
})

test('ackForLabel 含任务接手；纯闲聊无强制文案', () => {
  assert.match(ackForLabel('task', 'zh'), /这事我来办/)
  assert.match(ackForLabel('new_session', 'zh'), /新开/)
  assert.equal(ackForLabel('chat', 'zh'), '')
})

test('runChatGate：new_session 接管并开窗', async () => {
  const opens = []
  const result = await runChatGate({
    ctx: {},
    home: '',
    text: '新开一个窗口聊天',
    classify: async () => ({ label: 'new_session', via: 'test' }),
    openNewSession: async () => { opens.push(1) },
  })
  assert.equal(result.takeover, true)
  assert.equal(result.label, 'new_session')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(opens.length, 1)
})

test('ackForLabel：盯屏口令说明秒数', () => {
  assert.match(ackForLabel('glance', 'zh', '盯着屏幕看 60 秒'), /60 秒/)
  assert.match(ackForLabel('glance', 'zh', '看一眼桌面'), /瞅一眼/)
})

test('runChatGate：task 接管并 markHandled', async () => {
  const handled = []
  const tasks = []
  const result = await runChatGate({
    ctx: {},
    home: '',
    text: '打开记事本写下今天日期再保存',
    classify: async () => ({ label: 'task', via: 'test' }),
    agentBridge: { handleTask: async (t) => { tasks.push(t) } },
    markHandled: (c) => handled.push(c),
  })
  assert.equal(result.takeover, true)
  assert.equal(result.label, 'task')
  assert.match(result.ack, /这事我来办/)
  assert.deepEqual(handled, ['打开记事本写下今天日期再保存'])
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(tasks.length, 1)
})

test('runChatGate：纯闲聊不接管（放行 dsh-pet）', async () => {
  const result = await runChatGate({
    ctx: {},
    home: '',
    text: '你叫什么名字呀',
    classify: async () => ({ label: 'chat', via: 'test' }),
  })
  assert.equal(result.takeover, false)
  assert.equal(result.label, 'chat')
})

test('runChatGate：插件自述回声吞掉，不派发', async () => {
  let dispatched = 0
  const result = await runChatGate({
    ctx: {},
    home: '',
    text: '屏幕上是记事本。',
    classify: async () => {
      dispatched += 1
      return { label: 'glance', via: 'test' }
    },
    chatBridge: { handleIntent: async () => { dispatched += 10 } },
  })
  assert.equal(result.takeover, true)
  assert.equal(result.via, 'self-talk')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(dispatched, 0)
})

test('runChatGate：带教中改口闲聊则安静退出再放行', async () => {
  let quiet = 0
  const result = await runChatGate({
    ctx: {},
    home: '',
    text: '你叫什么名字呀',
    teachBridge: {
      isTeaching: () => true,
      cancelTeachingQuiet: () => { quiet += 1 },
      handleCoachUtterance: async () => { quiet += 10 },
    },
    classify: async (_ctx, _t, opts) => {
      assert.equal(opts.teaching, false)
      return { label: 'chat', via: 'test' }
    },
  })
  assert.equal(quiet, 1)
  assert.equal(result.takeover, false)
  assert.equal(result.label, 'chat')
})

test('runChatGate：学会了吗 虽标 chat 仍接管', async () => {
  const result = await runChatGate({
    ctx: {},
    home: '',
    text: '你会和豆包聊天吗',
    classify: async () => ({ label: 'chat', via: 'test' }),
  })
  assert.equal(result.takeover, true)
  assert.equal(result.label, 'chat')
})

test('patchHelperConfirmHtml：迁移旧 glance-confirm', () => {
  const raw = [
    '    <script src="./sprite/menu.js"></script>',
    '    <!-- dsh-glance:confirm-bubble-v2 -->',
    '    <script src="./sprite/glance-confirm.js"></script>',
    '    <script src="./events.js"></script>',
    '',
  ].join('\n')
  const p = patchHelperConfirmHtml(raw)
  assert.equal(p.changed, true)
  assert.ok(p.text.includes(CONFIRM_PATCH_MARK))
  assert.ok(p.text.includes(CONFIRM_SCRIPT_NAME))
  assert.ok(!p.text.includes('glance-confirm.js'))
})

test('patchChatWithPetSource：插入闸门标记', () => {
  const raw = [
    '\t\tif (image !== void 0) log.info(`[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）`);',
    '\t\tconst generated = await generateChat({',
    '\t\t\tctx,',
  ].join('\n')
  const p = patchChatWithPetSource(raw)
  assert.equal(p.changed, true)
  assert.ok(p.text.includes(CHAT_GATE_PATCH_MARK))
  assert.ok(p.text.includes('host-origin.txt'))
  assert.ok(p.text.includes('/api/pet-enhance/chat-gate'))
  const again = patchChatWithPetSource(p.text)
  assert.equal(again.changed, false)
})

test('patchChatWithPetSource：兼容中间插入 recallPatch', () => {
  const raw = [
    '\t\tif (image !== void 0) log.info(`[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）`);',
    '\t\tconst patch = await recallPatch(petId, {',
    '\t\t\tsystem,',
    '\t\t\tuserText: text',
    '\t\t});',
    '\t\tconst generated = await generateChat({',
    '\t\t\tctx,',
  ].join('\n')
  const p = patchChatWithPetSource(raw)
  assert.equal(p.changed, true)
  assert.equal(p.reason, 'patched-before-generateChat')
  assert.ok(p.text.includes(CHAT_GATE_PATCH_MARK))
  assert.ok(p.text.includes('recallPatch'))
  assert.ok(p.text.indexOf(CHAT_GATE_PATCH_MARK) < p.text.indexOf('const generated = await generateChat'))
})

test('stripChatGateV1 可升级到 v2', () => {
  const v1 = [
    '\t\tif (image !== void 0) log.info(`[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）`);',
    `\t\t/* ${CHAT_GATE_PATCH_MARK_V1} */`,
    '\t\tif (image === void 0) { try { } catch {} }',
    '\t\tconst generated = await generateChat({',
  ].join('\n')
  const stripped = stripChatGateV1(v1)
  assert.ok(!stripped.includes(CHAT_GATE_PATCH_MARK_V1))
  const p = patchChatWithPetSource(stripped.includes('generateChat') ? [
    '\t\tif (image !== void 0) log.info(`[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）`);',
    '\t\tconst generated = await generateChat({',
  ].join('\n') : stripped)
  assert.ok(p.changed || p.text.includes(CHAT_GATE_PATCH_MARK))
})

test('patchChatClientSource：sendMessage 闸门', () => {
  const raw = [
    'async function sendMessage(petId, text, attachment) {',
    '\tconst url = ROUTE_PATH + "/chat?pet=" + encodeURIComponent(petId) + "&surface=any";',
    '\tconst result = await sendChat(url, text, attachment);',
    '\treturn result.ok ? { ok: true } : {',
    '\t\tok: false,',
    '\t\tmessage: result.message ?? result.reason',
    '\t};',
    '}',
  ].join('\n')
  const p = patchChatClientSource(raw)
  assert.equal(p.changed, true)
  assert.ok(p.text.includes(CHAT_CLIENT_GATE_MARK))
})

test('runChatGate：短时去重不二次派发', async () => {
  const tasks = []
  const opts = {
    ctx: {},
    home: '',
    text: '打开记事本保存',
    classify: async () => ({ label: 'task', via: 'test' }),
    agentBridge: { handleTask: async (t) => { tasks.push(t) } },
    markHandled: () => {},
    isDuplicate: () => true,
  }
  const r = await runChatGate(opts)
  assert.equal(r.takeover, true)
  assert.equal(r.via, 'dedupe')
  await new Promise((x) => setTimeout(x, 20))
  assert.equal(tasks.length, 0)
})
