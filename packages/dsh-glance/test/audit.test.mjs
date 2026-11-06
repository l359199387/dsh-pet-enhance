import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { actionsFilePath, appendAction, buildActionRecord } from '../src/audit.js'

const home = mkdtempSync(join(tmpdir(), 'glance-audit-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('appendAction 写一行 JSONL', async () => {
  await appendAction(home, buildActionRecord({
    action: 'click',
    args: { x: 1, y: 2, reason: '点保存' },
    tier: 'L2',
    confirmed: true,
    ok: true,
    ms: 14,
    screen: { w: 100, h: 100 },
  }))
  const raw = readFileSync(actionsFilePath(home), 'utf8').trim()
  const row = JSON.parse(raw)
  assert.equal(row.tool, 'act')
  assert.equal(row.action, 'click')
  assert.equal(row.tier, 'L2')
  assert.equal(row.confirmed, true)
  assert.equal(row.ok, true)
  assert.ok(row.at)
})
