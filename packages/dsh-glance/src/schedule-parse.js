/**
 * 从用户话里解析「要不要定时」。未明确说时间 → null（不定时、不开启）。
 *
 * @module src/schedule-parse.js
 */

const WEEKDAY_CN = Object.freeze({
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
})

const HOUR_CN = Object.freeze({
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
})

const DEFAULT_TZ = 'Asia/Shanghai'

/** @param {string} tok */
function parseHourToken(tok) {
  if (/^\d{1,2}$/.test(tok)) return Number(tok)
  if (tok === '十') return 10
  if (tok.length === 2 && tok[0] === '十' && HOUR_CN[tok[1]] != null) return 10 + HOUR_CN[tok[1]]
  if (tok.length === 2 && HOUR_CN[tok[0]] != null && tok[1] === '十') return HOUR_CN[tok[0]] * 10
  if (tok.length === 3 && HOUR_CN[tok[0]] != null && tok[1] === '十' && HOUR_CN[tok[2]] != null) {
    return HOUR_CN[tok[0]] * 10 + HOUR_CN[tok[2]]
  }
  if (HOUR_CN[tok] != null) return HOUR_CN[tok]
  return null
}

function clipJoin(parts) {
  return parts.filter((p) => String(p || '').trim()).map((p) => String(p).trim()).join('\n')
}

/**
 * 把「晚上九点 / 9点半 / 21:30 / 上午10点」收成 HH:mm:ss.SSS
 * @param {string} text
 * @returns {string | null}
 */
export function parseClockTime(text) {
  const s = String(text || '')
  const hm = s.match(/(?:(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?)/)
  if (hm) {
    let h = Number(hm[1])
    const m = Number(hm[2])
    const sec = hm[3] != null ? Number(hm[3]) : 0
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000`
    }
  }

  const cn = s.match(
    /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今晚)?\s*([零〇一二两三四五六七八九十\d]{1,3})\s*(?:点|时)(?:\s*([零〇一二两三四五六七八九十\d]{1,3})\s*分|\s*半)?/,
  )
  if (cn) {
    const period = cn[1] || ''
    let h = parseHourToken(cn[2])
    let m = 0
    if (h == null) return null
    if (/半/.test(cn[0])) m = 30
    else if (cn[3] != null) {
      const pm = parseHourToken(cn[3])
      if (pm != null) m = pm
    }
    if (/下午|傍晚|晚上|夜里|今晚/.test(period) && h > 0 && h < 12) h += 12
    if (/中午/.test(period) && h < 11) h = 12
    if (/凌晨/.test(period) && h === 12) h = 0
    if (h === 24) h = 0
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000`
    }
  }
  return null
}

/**
 * @param {string} text
 * @returns {number[]}
 */
export function parseWeekdays(text) {
  const s = String(text || '')
  const out = new Set()
  if (/工作日|平日/.test(s)) {
    for (let d = 1; d <= 5; d += 1) out.add(d)
  }
  if (/每天|每日|天天|everyday/i.test(s) && !/每周|每星期|周[一二三四五六日天]/.test(s)) {
    return [] // 空 = 每日，不是 weekly
  }
  const re = /(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/g
  let m
  while ((m = re.exec(s))) {
    const tok = m[1]
    if (/^[1-7]$/.test(tok)) out.add(Number(tok))
    else if (WEEKDAY_CN[tok]) out.add(WEEKDAY_CN[tok])
  }
  // 「每周一三五」连写
  const compact = s.match(/(?:每周|每星期|周)\s*([一二三四五六日天]{2,7})/)
  if (compact) {
    for (const ch of compact[1]) {
      if (WEEKDAY_CN[ch]) out.add(WEEKDAY_CN[ch])
    }
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * 是否出现「要定时」的明确说法。
 * 「记录每日的心情」这种目标名不算；必须带周几 / 几点 / 每隔 / 定时等。
 * @param {string} text
 */
export function hasExplicitScheduleIntent(text) {
  const s = String(text || '')
  if (!s.trim()) return false
  if (/每周|每星期|工作日|(?:周|星期|礼拜)\s*[一二三四五六日天1-7]/.test(s)) return true
  if (/(?:每天|每日|天天).{0,16}(?:\d{1,2}\s*[:：]\s*\d{1,2}|[零〇一二两三四五六七八九十\d]{1,3}\s*点|凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今晚)/.test(s)) {
    return true
  }
  if (/(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今晚)\s*[零〇一二两三四五六七八九十\d]{1,3}\s*点/.test(s)) return true
  if (/定时|整点|到点执行|设个闹钟|提醒我/.test(s)) return true
  if (/每隔|每\s*\d+\s*(?:秒|分钟|分|小时|钟头|天)|(?:\d+)\s*(?:分钟|分|小时|钟头)\s*后/.test(s)) return true
  return false
}

/**
 * @param {...(string|null|undefined)} parts
 * @returns {null | {
 *   kind: 'daily'|'weekly'|'every'|'after'|'at',
 *   label: string,
 *   time?: string,
 *   timeZone?: string,
 *   weekdays?: number[],
 *   everySeconds?: number,
 *   afterSeconds?: number,
 *   at?: string,
 * }}
 */
export function parseScheduleSpec(...parts) {
  const text = clipJoin(parts)
  if (!hasExplicitScheduleIntent(text)) return null

  const time = parseClockTime(text) || '09:00:00.000'
  const tz = DEFAULT_TZ
  const weekdays = parseWeekdays(text)

  // N 分钟/小时后
  const afterM = text.match(/(\d+)\s*(秒|分钟|分|小时|钟头)\s*后/)
  if (afterM) {
    const n = Number(afterM[1])
    const unit = afterM[2]
    let sec = n
    if (/分/.test(unit)) sec = n * 60
    else if (/小时|钟头/.test(unit)) sec = n * 3600
    if (sec > 0) {
      return { kind: 'after', afterSeconds: sec, label: `${n}${unit}后` }
    }
  }

  // 每隔 N
  const everyM = text.match(/(?:每隔|每)\s*(\d+)\s*(秒|分钟|分|小时|钟头|天)/)
  if (everyM && !/每周|每星期/.test(text)) {
    const n = Number(everyM[1])
    const unit = everyM[2]
    let sec = n
    if (/分/.test(unit)) sec = n * 60
    else if (/小时|钟头/.test(unit)) sec = n * 3600
    else if (/天/.test(unit)) sec = n * 86400
    if (sec >= 60) {
      return { kind: 'every', everySeconds: sec, label: `每${n}${unit}` }
    }
  }

  if (weekdays.length) {
    const names = '一二三四五六日'
    const labelDays = weekdays.map((d) => names[d - 1] || d).join('')
    return {
      kind: 'weekly',
      time,
      timeZone: tz,
      weekdays,
      label: `每周${labelDays} ${time.slice(0, 5)}`,
    }
  }

  if (/每天|每日|天天|每天都|每日都/.test(text) || /(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里).*\d{1,2}\s*点/.test(text)) {
    return {
      kind: 'daily',
      time,
      timeZone: tz,
      label: `每天 ${time.slice(0, 5)}`,
    }
  }

  // 仅「21:00 / 晚上九点」也视为每日到点
  if (parseClockTime(text)) {
    return {
      kind: 'daily',
      time,
      timeZone: tz,
      label: `每天 ${time.slice(0, 5)}`,
    }
  }

  return null
}

/**
 * 转成 schedule.create 可用的字段（兼容扁平 after_seconds 与 timing 对象）。
 * @param {NonNullable<ReturnType<typeof parseScheduleSpec>>} spec
 */
export function timingToCreateFields(spec) {
  if (!spec) return null
  if (spec.kind === 'after') {
    return { after_seconds: spec.afterSeconds }
  }
  if (spec.kind === 'every') {
    return { every_seconds: spec.everySeconds }
  }
  if (spec.kind === 'at') {
    return { at: spec.at }
  }
  if (spec.kind === 'daily') {
    return {
      timing: {
        kind: 'daily',
        daily: { time: spec.time, time_zone: spec.timeZone },
      },
    }
  }
  if (spec.kind === 'weekly') {
    return {
      timing: {
        kind: 'weekly',
        weekly: {
          time: spec.time,
          time_zone: spec.timeZone,
          weekdays: spec.weekdays,
        },
      },
    }
  }
  return null
}
