import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ensureDesktopToken, readDesktopToken, tokenMatches } from '../src/desktop-token.js'

const home = mkdtempSync(join(tmpdir(), 'glance-token-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('ensureDesktopToken 幂等且可校验', () => {
  const a = ensureDesktopToken(home)
  const b = ensureDesktopToken(home)
  assert.equal(a, b)
  assert.equal(readDesktopToken(home), a)
  assert.equal(tokenMatches(home, a), true)
  assert.equal(tokenMatches(home, 'nope'), false)
})
