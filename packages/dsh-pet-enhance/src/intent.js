/**
 * L 对话意图粗筛（决定走哪条桥；真正理解交给模型）。
 *
 * @module src/intent.js
 */

/** chat-bridge 附图 follow-up 前缀——不得再命中看屏意图。 */
export const GLANCE_FOLLOWUP_PREFIX = '【小蓝鲸已附上刚才的画面】'

/** agent-bridge 叫醒主会话的前缀。 */
export const AGENT_WAKE_PREFIX = '【小蓝鲸交办】'

/** 教学收束后叫醒主会话的标记（避免再被当成新教学口令）。 */
export const TEACH_FOLLOWUP_PREFIX = '【小蓝鲸教学回放】'

export const GLANCE_INTENT_RE =
  /(?:看(?:一?眼|看|下|一下)?|帮我看(?:一?眼|一下)?)(?:我的|下我的)?(?:屏幕|桌面|画面)|(?:屏幕|桌面)上|截(?:个|一)?图|现在(?:的)?(?:桌面|屏幕)|这个窗口|窗口里|(?:看|瞅)一眼|glance|(?:盯着|看着|陪看|盯一会儿|看一会儿|看一会|连续看).{0,12}?(?:屏幕|桌面|画面)?|盯着看|看着看/i

/**
 * 「盯着看一会儿 / watch 60 秒」→ 走阻塞陪看，不是单帧 see。
 * 仍算 glance 大类（闸门接管），具体 action 由 chat-bridge / 工具决定。
 */
export const WATCH_INTENT_RE =
  /盯着|陪看|看着看|盯一会儿|看一会儿|看一会|连续看|帮我盯|\bwatch\b|(?:盯|看).{0,12}?\d+\s*(?:秒|s\b)/i

/** 从口令里抠 watch 秒数；默认 60，上限 600。 */
export function parseWatchSeconds(text, fallback = 60) {
  const s = String(text ?? '')
  const m = s.match(/(\d{1,4})\s*(?:秒|s\b)/i)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return Math.min(600, Math.max(1, Math.trunc(n)))
  }
  if (/一会儿|一会|片刻|稍后/i.test(s)) return Math.min(fallback, 30)
  return fallback
}

export function isWatchIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return WATCH_INTENT_RE.test(s)
}

/**
 * 粗筛「可能要操作电脑」。只决定要不要叫醒带 glance/act 的 Agent；
 * 点哪里、按什么键由模型看屏后决定。
 */
export const COMPUTER_TASK_RE =
  /(?:帮我|请(?:你)?|麻烦|给我)?[\s\S]{0,40}?(?:点(?:击|一下|开)?|双击|右键|拖(?:拽|到)?|滚(?:动|轮)?|输入|键入|打字|按下?|打开|关闭|关掉|退出|杀掉|最小化|最大化|还原|聚焦|切换到?|选中|勾选|取消|保存|发送|复制|粘贴|剪切|删除|清空|刷新|提交|确认|搜索|改成|设置成|调成|移到|挪到|放到|运行|启动|click|type|minimize|maximize)|(?:把|将|让).{0,40}?(?:最小化|最大化|关掉|关闭|点(?:一下|开)?|输入|改成|移到|打开)/i

/** 「我教你 / 学一下我的操作」→ 进入只记不练的教学模式。 */
export const TEACH_START_RE =
  /(?:我?教你(?:一下|一遍|一回)?|教你(?:怎么|如何)?做|学一下我的操作|跟我学(?:一遍|一下)?|看我做(?:一遍|一下)?|开始教学|进入教学)/i

/** 「教完了」→ 停止录制并按记录执行目标。 */
export const TEACH_END_RE =
  /(?:教完了|教好了|学完了|结束教学|停止教学|不教了|按刚才教的(?:去做|做)|照着(?:刚才|我教的)做)/i

/**
 * 「执行一下 / 去记录一下 / 去看看 / 继续刷 / 跑自动化」→ 跑已学会的自动化（不是闲聊）。
 * 例：执行一下记录每日心情、去看看B站、继续去刷刷B站、再做一次。
 * 注意：不要用裸「帮我看」——会抢走「帮我看屏幕」的 glance。
 */
export const RUN_AUTOMATION_RE =
  /(?:再做一次|再来一遍|跑(?:一下)?自动化|照着做|按刚才(?:教的)?(?:去做|做)?|继续(?:去)?(?:做|看|刷|逛|玩|吧)?|接着(?:做|弄|干|来)|^(?:继续|接着)$)|(?:执行|运行|跑|去做|去记|去写|帮我做|帮我记|帮我写)(?:一下|一遍|一回)?|(?:去看看|去刷刷|去逛逛|去溜达|帮我刷刷)/i

function isBridgeEcho(s) {
  return (
    s.startsWith(GLANCE_FOLLOWUP_PREFIX)
    || s.startsWith(AGENT_WAKE_PREFIX)
    || s.includes(TEACH_FOLLOWUP_PREFIX)
  )
}

export function isGlanceIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return GLANCE_INTENT_RE.test(s) || isWatchIntent(s)
}

/** 要跑已学自动化 / 再次执行。 */
export function isRunAutomationIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return RUN_AUTOMATION_RE.test(s)
}

export function isComputerTaskIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return COMPUTER_TASK_RE.test(s) || isRunAutomationIntent(s)
}

export function isTeachStartIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return TEACH_START_RE.test(s)
}

export function isTeachEndIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return TEACH_END_RE.test(s)
}

/** 干活 / 教学意图优先；chat-bridge 应跳过，避免又抓一帧抢话。 */
export function shouldSkipGlanceBridge(text) {
  return isComputerTaskIntent(text) || isTeachStartIntent(text) || isTeachEndIntent(text)
}

/** agent-bridge 应让路给教学模式。 */
export function shouldSkipAgentBridge(text) {
  return isTeachStartIntent(text) || isTeachEndIntent(text)
}
