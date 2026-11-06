import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(HERE, '..', 'sidecar')

function resolvePython() {
  const candidates = [
    process.env.DSH_PET_ENHANCE_PYTHON,
    process.env.DSH_PYTHON,
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ].filter(Boolean)
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8' })
    if (r.status === 0) return c
  }
  return null
}

const py = resolvePython()

test('pet_act_shield：dry_run 不写锁', { skip: !py }, () => {
  const home = mkdtempSync(join(tmpdir(), 'glance-shield-'))
  after(() => rmSync(home, { recursive: true, force: true }))
  const code = `
import os, sys
sys.path.insert(0, r${JSON.stringify(SIDECAR)})
os.environ['DSH_PET_ENHANCE_HOME'] = r${JSON.stringify(home)}
from pet_shield import pet_act_shield, act_lock_path
with pet_act_shield(dry_run=True) as info:
    assert info['locked'] is False
    assert not act_lock_path().exists()
print('ok')
`
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.stdout)
})

test('pet_act_shield：写入并清理 desktop-act.lock', { skip: !py }, () => {
  const home = mkdtempSync(join(tmpdir(), 'glance-shield-'))
  after(() => rmSync(home, { recursive: true, force: true }))
  const lock = join(home, 'desktop-act.lock')
  const code = `
import os, sys
sys.path.insert(0, r${JSON.stringify(SIDECAR)})
os.environ['DSH_PET_ENHANCE_HOME'] = r${JSON.stringify(home)}
from pet_shield import pet_act_shield, act_lock_path
with pet_act_shield(dry_run=False, settle_ms=0) as info:
    assert info['locked'] is True
    assert act_lock_path().exists()
    print('locked')
assert not act_lock_path().exists()
print('cleared')
`
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  assert.match(r.stdout, /locked/)
  assert.match(r.stdout, /cleared/)
  assert.equal(existsSync(lock), false)
})
