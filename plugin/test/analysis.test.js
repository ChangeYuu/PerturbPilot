// 分析工具测试：真实的 Run（oracle 和决策模块用替身）+ 真实的 Python 子进程。
// 用仓库的 .venv 里的 Python（有 numpy）；没有时用 PATH 上的 python。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import { childEnv, resolvePython, runAnalysis } from '../lib/analysis.js'
import { Run } from '../lib/run.js'
import { fakeServices } from './fake-services.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const venv = process.platform === 'win32' ? join(repo, '.venv', 'Scripts', 'python.exe') : join(repo, '.venv', 'bin', 'python')
const python = existsSync(venv) ? venv : 'python'

let dir
let run
let services
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pp-analysis-'))
  services = fakeServices()
  run = await Run.start({ dir, runId: 's1', services })
  const d = await run.getDecision(services)
  await run.submitSelection({ batch: d.recommendations.map((x) => x.id), groups: [] }, services)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(services.packageDir, { recursive: true, force: true })
})

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const opts = (extra = {}) => ({ python, timeoutMs: 20000, ...extra })

test('script reads the exported ledger, output and files are recorded', async () => {
  const code = [
    'import csv, os',
    'rows = list(csv.DictReader(open("observations.csv", encoding="utf-8")))',
    'cands = list(csv.DictReader(open("candidates.csv", encoding="utf-8")))',
    'expr = list(csv.DictReader(open("data/expr.csv", encoding="utf-8")))',
    'dec = list(csv.DictReader(open("decision.csv", encoding="utf-8")))',
    'best = max(rows, key=lambda r: float(r["score"]))',
    'print(len(rows), len(cands), len(expr), sum(r["measured"] == "false" for r in dec), best["id"], "最高")',
    'os.makedirs("out", exist_ok=True)',
    'open("out/summary.txt", "w", encoding="utf-8").write("ok")',
  ].join('\n')
  const res = await runAnalysis(run, { code, purpose: '看看谁最高' }, opts())
  assert.equal(res.id, 'A1')
  assert.equal(res.exit_code, 0, res.stderr)
  assert.equal(res.timed_out, false)
  const best = [...run.state.observations].sort((a, b) => b.readout.score - a.readout.score)[0].id
  // 决策模块的候选池是提交之前拿的，那时 20 个都没测过。
  const line = `3 20 20 20 ${best} 最高`
  assert.equal(res.stdout.trim(), line)
  assert.deepEqual(res.files, ['out/summary.txt'])

  const adir = join(dir, 'analysis', 'A1')
  assert.equal(readFileSync(join(adir, 'code.py'), 'utf8'), code)
  assert.equal(readFileSync(join(adir, 'stdout.txt'), 'utf8').trim(), line)
  const obs = readFileSync(join(adir, 'observations.csv'), 'utf8').split('\n')
  assert.equal(obs[0], 'id,round,replicate,score,absolute_effect')
  assert.equal(obs[1], 'G000,1,0,0,0')
  assert.equal(readFileSync(join(adir, 'candidates.csv'), 'utf8').split('\n')[0], 'id,name')
  assert.equal(readFileSync(join(adir, 'decision.csv'), 'utf8').split('\n')[0], 'id,measured,score')

  const event = readJsonl(join(dir, 'events.jsonl')).find((e) => e.type === 'analysis/executed')
  assert.equal(event.source, 'model')
  assert.equal(event.round, 2)
  assert.deepEqual({ ...event.data, duration_ms: 0 }, {
    id: 'A1', purpose: '看看谁最高', exit_code: 0, timed_out: false, duration_ms: 0, dir: 'analysis/A1', files: ['out/summary.txt'],
  })

  // 第二次分析拿到新目录
  assert.equal((await runAnalysis(run, { code: 'print(1)', purpose: '再来' }, opts())).id, 'A2')
})

test('child process gets no service token or model key', async () => {
  const source = { ...process.env, PERTURBPILOT_SERVICE_TOKEN: 'tok-secret', DEEPSEEK_API_KEY: 'sk-secret' }
  const env = childEnv(source)
  assert.equal(env.PERTURBPILOT_SERVICE_TOKEN, undefined)
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  const code = 'import os\nprint(sorted(k for k, v in os.environ.items() if "secret" in v))'
  const res = await runAnalysis(run, { code, purpose: '看环境变量' }, opts({ env }))
  assert.equal(res.exit_code, 0, res.stderr)
  assert.equal(res.stdout.trim(), '[]')
})

test('errors, timeouts and a missing interpreter are reported, not thrown', async () => {
  const failed = await runAnalysis(run, { code: 'raise ValueError("坏了")', purpose: '出错' }, opts())
  assert.equal(failed.exit_code, 1)
  assert.match(failed.stderr, /ValueError: 坏了/)

  const slow = await runAnalysis(run, { code: 'import time\ntime.sleep(30)', purpose: '超时' }, opts({ timeoutMs: 500 }))
  assert.equal(slow.timed_out, true)
  assert.notEqual(slow.exit_code, 0)

  const missing = await runAnalysis(run, { code: 'print(1)', purpose: '没有 Python' }, opts({ python: join(dir, 'no-such-python.exe') }))
  assert.equal(missing.exit_code, null)
  assert.match(missing.stderr, /无法启动 Python/)

  const events = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.type === 'analysis/executed')
  assert.deepEqual(events.map((e) => [e.data.exit_code === 0, e.data.timed_out]), [[false, false], [false, true], [false, false]])
})

test('analysis needs code, a purpose and an open run', async () => {
  await assert.rejects(runAnalysis(run, { code: ' ', purpose: 'x' }, opts()), /code 不能为空/)
  await assert.rejects(runAnalysis(run, { code: 'print(1)', purpose: '' }, opts()), /purpose/)
  run.control('stop', 'human')
  await assert.rejects(runAnalysis(run, { code: 'print(1)', purpose: 'x' }, opts()), /已停止/)
  assert.equal(existsSync(join(dir, 'analysis')), false)
})

test('python path: bare names go to PATH, relative paths resolve against the start directory', () => {
  assert.equal(resolvePython('python', 'D:/work'), 'python')
  assert.equal(resolvePython(join('.venv', 'Scripts', 'python.exe'), repo), join(repo, '.venv', 'Scripts', 'python.exe'))
  assert.equal(resolvePython(venv, 'D:/elsewhere'), venv)
})
