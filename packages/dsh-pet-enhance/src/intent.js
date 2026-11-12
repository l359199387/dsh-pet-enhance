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
  /(?:看(?:一?眼|看|下|一下)?|帮我看(?:一?眼|一下)?)(?:我的|下我的)?(?:屏幕|桌面|画面)|(?:屏幕|桌面)上(?:是什么|有什么|写了什么|怎么样|显示什么)|截(?:个|一)?图|现在(?:的)?(?:桌面|屏幕)(?:上)?(?:是什么|有什么)?|这个窗口|窗口里|(?:看|瞅)一眼|glance|(?:盯着|看着|陪看|盯一会儿|看一会儿|看一会|连续看).{0,12}?(?:屏幕|桌面|画面)?|盯着看|看着看/i

/**
 * 插件自己冒过的泡 / 结论——禁止再当作用户口令分流（否则「屏幕上是记事本」会再次看屏，叠出自言自语）。
 */
export const ENHANCE_SELF_TALK_RE =
  /^(?:屏幕上是|屏幕上有|这件事我还没学会|还没学会呢|好，这轮带教先停下|现在不在带教|闲聊已关|这事我来办|嗯，我听着|好，我去主会话|好，执行技能|按变通思路做|主会话这轮没给出|主会话看屏|已急停|小蓝鲸已接入)/u

export function isEnhanceSelfTalk(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  if (
    s.startsWith(GLANCE_FOLLOWUP_PREFIX)
    || s.startsWith(AGENT_WAKE_PREFIX)
    || s.includes(TEACH_FOLLOWUP_PREFIX)
  ) {
    return true
  }
  return ENHANCE_SELF_TALK_RE.test(s)
}

/**
 * 带教中若主人明显改去闲聊/看屏/业务问答，应安静退出带教，不要误 abort。
 * 注意：不要把「先在桌面创建文件」这类本步指示当成离开（那是 step）。
 */
export function shouldLeaveCoaching(text) {
  const s = String(text ?? '').trim()
  if (!s || isEnhanceSelfTalk(s)) return false
  if (isTeachStartIntent(s) || isTeachEndIntent(s)) return false
  if (/放弃|不教了|取消带教|停止带教|不想教了|先别教/.test(s)) return false
  if (isGlanceIntent(s) || isWatchIntent(s) || isNewSessionIntent(s)) return true
  if (/^(?:你叫什么|你好|嗨|哈喽|在吗|早上好|晚上好|晚安|谢谢)/i.test(s)) return true
  // 问已学技能的标准/条件（不是在教本步）
  if (/(?:标准|条件|流程|规则).{0,8}?(?:是什么|有哪些)|(?:是什么|什么是).{0,24}?(?:标准|条件)/.test(s)) {
    return true
  }
  return false
}

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
  /(?:帮我|请(?:你)?|麻烦|给我)?[\s\S]{0,40}?(?:点(?:击|一下|开)?|双击|右键|拖(?:拽|到)?|滚(?:动|轮)?|输入|键入|打字|按下|按一下|按住|按键|打开|关闭|关掉|退出|杀掉|最小化|最大化|还原|聚焦|切换到?|选中|勾选|取消|保存|发送|复制|粘贴|剪切|删除|清空|刷新|提交|确认|搜索|改成|设置成|调成|移到|挪到|放到|运行|启动|click|type|minimize|maximize)|(?:把|将|让).{0,40}?(?:最小化|最大化|关掉|关闭|点(?:一下|开)?|输入|改成|移到|打开)/i

/** 「我教你」→ 进入对话带教（它动手，你说话纠正）。 */
export const TEACH_START_RE =
  /(?:我?教你(?:一下|一遍|一回)?|教你(?:怎么|如何)?做|带教|开始带教|开始教学|进入教学|跟我学(?:一遍|一下)?|学一下我的操作)/i

/** 旧「教完了」口令：非带教中时仍可识别；带教中改走 coach-intent（做成了/放弃）。 */
export const TEACH_END_RE =
  /(?:教完了|教好了|学完了|结束教学|停止教学|按刚才教的(?:去做|做)|照着(?:刚才|我教的)做)/i

/**
 * 「执行一下 / 去记录一下 / 去看看 / 继续刷 / 跑自动化 / 用你学会的…」→ 跑已学会的自动化（不是闲聊）。
 * 例：执行一下记录每日心情、用你学会的去刷B站、我教过你和豆包聊天、去看我学会的然后执行。
 * 注意：不要用裸「帮我看」——会抢走「帮我看屏幕」的 glance。
 */
export const RUN_AUTOMATION_RE =
  /(?:再做一次|再来一遍|跑(?:一下)?自动化|照着做|按刚才(?:教的)?(?:去做|做)?|继续(?:去)?(?:做|看|刷|逛|玩|吧)?|接着(?:做|弄|干|来)|^(?:继续|接着)$)|(?:执行|运行|跑|去做|去记|去写|帮我做|帮我记|帮我写)(?:一下|一遍|一回)?|(?:去看看|去刷刷|去逛逛|去溜达|帮我刷刷)|(?:用(?:你|小蓝鲸)?学会的|按(?:你|小蓝鲸)?学会的|用学会的|按学会的|按上次学的|照上次学的|按学过的|我教过你|你(?:已经)?学过的|按我教(?:过|的)|照我教的)|(?:去?看(?:一?下|看)?我学会的(?:东西|技能|条目|自动化)?(?:然后|再|并)?(?:去)?(?:执行|去做|跑|运行|做一遍)?)/i

/**
 * 软执行气味：不必写「执行一下」，但像在让宠物按已学目标去聊/沟通几轮，
 * 或按已学技能回答业务问题（标准/条件/是什么）。
 * 须配合已学 goal 命中才升为 task（见 classify isLearnedGoalReplayIntent）。
 */
export const SKILL_REPLAY_SOFT_RE =
  /(?:聊聊天|聊一聊|闲聊几句)|(?:聊|沟通|闲聊|对话|交谈).{0,16}?\d+\s*(?:轮|次|句)|(?:聊|沟通|闲聊).{0,10}?(?:几轮|几句|一会儿)|沟通\s*\d+|聊\s*\d+\s*轮|(?:再|去|帮我).{0,16}?(?:聊|刷|逛)(?:聊|刷|逛|一?下|一?会儿)?|(?:标准|条件|流程|规则).{0,8}?(?:是什么|有哪些)|(?:是什么|什么是|有哪些条件|有哪些标准)|(?:根据|按|用).{0,12}?(?:代码|项目|学会的|技能).{0,16}?(?:回答|查|看|说)/i

/**
 * 「新开/开启一个新的窗口 / 开个新会话」→ 新建工作区聊天窗（不是闲聊）。
 */
export const NEW_SESSION_RE =
  /(?:新开|另开|再开|开启)(?:一个)?(?:新的)?(?:工作区)?(?:聊天窗口|聊天窗|窗口聊天|窗口|会话|对话|聊天)|(?:开|建|开启)(?:一?个)?新(?:的)?(?:工作区)?(?:聊天窗口|聊天窗|窗口|会话|对话|聊天)|新建(?:一个)?(?:会话|对话|聊天窗口|聊天)|开个新(?:窗口|会话|对话|聊天)|打开(?:一个)?新(?:的)?(?:窗口|会话|对话|聊天)/i

function isBridgeEcho(s) {
  return isEnhanceSelfTalk(s)
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

/** 软执行气味（聊 N 轮 / 聊聊天等），单独不够，需配已学目标。 */
export function hasSkillReplaySoftCue(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return SKILL_REPLAY_SOFT_RE.test(s)
}

/** 主人主动要求新开工作区聊天窗口。 */
export function isNewSessionIntent(text) {
  const s = String(text ?? '').trim()
  if (!s || isBridgeEcho(s)) return false
  return NEW_SESSION_RE.test(s)
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

/** 干活 / 教学 / 新开会话优先；chat-bridge 应跳过，避免又抓一帧抢话。 */
export function shouldSkipGlanceBridge(text) {
  return (
    isComputerTaskIntent(text)
    || isTeachStartIntent(text)
    || isTeachEndIntent(text)
    || isNewSessionIntent(text)
  )
}

/** agent-bridge 应让路给教学模式 / 新开会话。 */
export function shouldSkipAgentBridge(text) {
  return isTeachStartIntent(text) || isTeachEndIntent(text) || isNewSessionIntent(text)
}

export {
  COACH_LABELS,
  buildCoachClassifyPrompt,
  buildCoachGoalExtractPrompt,
  parseCoachClassifyLabel,
  parseCoachGoalReply,
  classifyCoachUtterance,
  extractCoachGoal,
} from './coach-intent.js'
