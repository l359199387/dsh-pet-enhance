import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildScriptProposePrompt,
  buildScriptsConfirmSummary,
  parseScriptProposals,
  sanitizeFilename,
  sanitizeScriptId,
  writeCoachScripts,
  skillsRoot,
} from '../src/coach-scripts.js'

const home = mkdtempSync(join(tmpdir(), 'coach-scripts-'))
after(() => {
  rmSync(home, { recursive: true, force: true })
  if (prevDsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDsh
})
const prevDsh = process.env.DSH_HOME
process.env.DSH_HOME = home

test('parseScriptProposals：NONE 与 JSON 多块', () => {
  assert.equal(parseScriptProposals('NONE').none, true)
  const code = [
    '#!/usr/bin/env python3',
    'import argparse',
    'p=argparse.ArgumentParser()',
    'p.add_argument("--dry-run", action="store_true")',
    'a=p.parse_args()',
    'print("dry" if a.dry_run else "run")',
  ].join('\n')
  const r = parseScriptProposals(JSON.stringify([
    { id: 'ensure-dir', purpose: '建目录', filename: 'ensure_dir.py', code },
    { id: 'write-note', purpose: '写笔记', filename: 'write_note.py', code },
  ]))
  assert.equal(r.none, false)
  assert.equal(r.scripts.length, 2)
  assert.equal(r.scripts[0].id, 'ensure-dir')
})

test('parseScriptProposals：拒绝含鼠标注入或无 dry-run', () => {
  assert.equal(parseScriptProposals(JSON.stringify([{
    id: 'bad',
    purpose: '点',
    filename: 'bad.py',
    code: 'import pyautogui\npyautogui.click(1,2)\n# --dry-run\n',
  }])).none, true)
  assert.equal(parseScriptProposals(JSON.stringify([{
    id: 'nodry',
    purpose: '写',
    filename: 'x.py',
    code: 'print("hi")\n',
  }])).none, true)
})

test('sanitize + writeCoachScripts', async () => {
  assert.equal(sanitizeScriptId('Ensure Dir!!'), 'ensure-dir')
  assert.equal(sanitizeFilename('foo'), 'foo.py')
  const code = '# -*- coding: utf-8 -*-\nimport argparse\np=argparse.ArgumentParser()\np.add_argument("--dry-run", action="store_true")\nargs=p.parse_args()\nprint("ok")\n'
  const w = await writeCoachScripts('pe-learn-test', [
    { id: 'a', filename: 'a.py', purpose: 'A', code },
  ])
  assert.equal(w.scripts[0].status, 'ready')
  const path = join(skillsRoot(), 'pe-learn-test', 'scripts', 'a.py')
  assert.ok(existsSync(path))
  assert.match(readFileSync(path, 'utf8'), /dry-run/)
})

test('propose prompt 与确认文案', () => {
  assert.match(buildScriptProposePrompt('g', 's', 'f', ['c']), /脚本拆分/)
  assert.match(buildScriptsConfirmSummary([
    { id: 'a', purpose: '建目录', filename: 'a.py' },
  ], 'pe-x'), /pe-x/)
})
