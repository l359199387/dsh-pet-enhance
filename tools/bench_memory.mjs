import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const rowsArg = process.argv.find((a) => a.startsWith('--rows='))
const ROWS = rowsArg ? Number(rowsArg.split('=')[1]) : 5000
const keep = process.argv.includes('--keep')
const file = path.join(os.tmpdir(), `glance-memory-bench-${process.pid}.sqlite`)
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true })

const CJK = /[\u3400-\u9fff]/

function bigrams(text) {
  const out = []
  let run = []
  const flush = () => {
    if (run.length === 1) out.push(run[0])
    for (let i = 0; i + 1 < run.length; i++) out.push(run[i] + run[i + 1])
    run = []
  }
  for (const ch of text) {
    if (CJK.test(ch)) run.push(ch)
    else {
      flush()
      if (/[a-z0-9]/i.test(ch)) out.push(ch.toLowerCase())
    }
  }
  flush()
  return out
}

const WORDS = ['保存', '桌面', '记事本', '设置', '语言', '运行', '测试', '文件', '窗口', '截图', '点击', '输入', '打开', '关闭', '另存为', '浏览器']
let seed = 7
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

function synth(i) {
  const n = 3 + Math.floor(rand() * 5)
  const parts = []
  for (let k = 0; k < n; k++) parts.push(WORDS[Math.floor(rand() * WORDS.length)])
  return {
    id: i,
    name: `skill-${i}`,
    title: `把${parts.join('')}任务`,
    body: `步骤：先抓一帧确认窗口，再按语义定位控件。${parts.join('，')}。`,
    tags: parts.slice(0, 3).join(' '),
  }
}

const db = new DatabaseSync(file)
db.exec('pragma journal_mode=wal')
db.exec('pragma synchronous=normal')
db.exec(`create table skill(
  id integer primary key, name text unique, title text, body text, tags text,
  uses integer default 0, ok integer default 0, fail integer default 0, last_used integer default 0)`)
db.exec("create virtual table skill_tri using fts5(name, title, tags, body, content='skill', content_rowid='id', tokenize='trigram')")
db.exec("create virtual table skill_bi using fts5(gram, content='', tokenize='unicode61')")

const ms = (t) => Math.round(performance.now() - t)
const out = {}

let t = performance.now()
db.exec('begin')
const ins = db.prepare('insert into skill(id,name,title,body,tags) values(?,?,?,?,?)')
const insTri = db.prepare('insert into skill_tri(rowid,name,title,tags,body) values(?,?,?,?,?)')
const insBi = db.prepare('insert into skill_bi(rowid, gram) values(?,?)')
for (let i = 1; i <= ROWS; i++) {
  const r = synth(i)
  ins.run(r.id, r.name, r.title, r.body, r.tags)
  insTri.run(r.id, r.name, r.title, r.tags, r.body)
  insBi.run(r.id, bigrams(`${r.title} ${r.tags} ${r.body}`).join(' '))
}
db.exec('commit')
out['批量写入 ' + ROWS + ' 行'] = ms(t) + ' ms'

t = performance.now()
db.prepare('select count(*) c from skill').get()
out['count(*)'] = ms(t) + ' ms'
db.close()
const sizeKB = Math.round(['', '-wal'].reduce((n, s) => n + (fs.existsSync(file + s) ? fs.statSync(file + s).size : 0), 0) / 1024)

t = performance.now()
const cold = new DatabaseSync(file)
cold.prepare('select count(*) c from skill').get()
out['冷启动重开 + count(*)'] = ms(t).toFixed(1) + ' ms'

const time = (label, fn, n) => {
  for (let i = 0; i < Math.ceil(n / 4); i++) fn()
  const rounds = []
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now()
    for (let i = 0; i < n; i++) fn()
    rounds.push((performance.now() - t0) / n)
  }
  rounds.sort((a, b) => a - b)
  out[label] = (rounds[1] * 1000).toFixed(0) + ' µs'
}

const point = cold.prepare('select id,title,body from skill where name=?')
time('点查 WHERE name=?', () => point.get(`skill-${1 + Math.floor(rand() * ROWS)}`), 1000)

const tri = cold.prepare("select s.id from skill_tri f join skill s on s.id=f.rowid where skill_tri match ? order by rank limit 5")
const bi = cold.prepare("select s.id from skill_bi f join skill s on s.id=f.rowid where skill_bi match ? order by rank limit 5")
const like = cold.prepare('select id from skill where title like ? limit 5')

time('FTS trigram 5 字短语', () => tri.all('"保存到桌面"'), 200)
time('FTS bigram 5 字短语', () => bi.all('"' + bigrams('保存到桌面').join(' ') + '"'), 200)
time('LIKE %…% 全表扫', () => like.all('%保存到桌面%'), 20)

let triShortHits = 0
try {
  triShortHits = tri.all('"保存"').length
} catch (e) {
  triShortHits = -1
}
let biShortHits = 0
try {
  biShortHits = bi.all('"' + bigrams('保存').join(' ') + '"').length
} catch (e) {
  biShortHits = -1
}
out['2 字查询：trigram 命中'] = String(triShortHits)
out['2 字查询：bigram 命中'] = String(biShortHits)

cold.close()

const records = Array.from({ length: ROWS }, (_, k) => synth(k + 1))
t = performance.now()
const jsonlPath = file + '.jsonl'
fs.writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join('\n'))
out['JSONL 写'] = ms(t) + ' ms'
t = performance.now()
const parsed = fs.readFileSync(jsonlPath, 'utf8').split('\n').map((l) => JSON.parse(l))
out['JSONL 读+解析 ' + parsed.length] = ms(t) + ' ms'
out['JSONL 体积 KB'] = String(Math.round(fs.statSync(jsonlPath).size / 1024))
fs.rmSync(jsonlPath, { force: true })

console.log('')
console.log('| 项 | 结果 |')
console.log('|---|---|')
for (const [k, v] of Object.entries(out)) console.log(`| ${k} | ${v} |`)
console.log('')
console.log(`db size: ${sizeKB} KB (${ROWS} rows)`)
if (!keep) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
