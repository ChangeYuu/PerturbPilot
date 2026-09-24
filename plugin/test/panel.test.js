// 面板路由测试：真实的 Run（oracle 和决策模块用替身）+ 真实的 HTTP 处理函数，检查视图内容、防伪造、控制动作。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { PANEL_ROUTE, createPanelHandler, listRuns, panelView } from '../lib/panel.js'
import { Run } from '../lib/run.js'
import { fakeServices } from './fake-services.js'

let dir
let server
let base
let run
let controlled

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pp-panel-'))
  const services = fakeServices()
  run = await Run.start({ dir, runId: 'sess-1', services })
  run.markDriven(1)
  const d = await run.getDecision(services)
  const ids = d.recommendations.map((x) => x.id)
  await run.submitSelection({ accept: ids.slice(1), replace: [{ out: ids[0], in: d.alternatives[0].id, reason_type: 'exploration', reason: '看看' }] }, services)
  run.writeNote({ text: '第一轮读数都偏低', cites: [ids[1]] })
  controlled = []
  const handler = createPanelHandler({
    getRun: (id) => (id === 'sess-1' ? run : undefined),
    control: (id, action) => {
      controlled.push([id, action])
      run.control(action, 'human')
    },
  })
  server = createServer((req, res) => (req.url.startsWith(PANEL_ROUTE) ? handler(req, res) : res.end()))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}${PANEL_ROUTE}`
})
afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const post = (path, body, headers = { 'content-type': 'application/json', 'x-perturbpilot': '1' }) =>
  fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })

test('view summarizes rounds, audit, ranked observations and events', () => {
  const view = panelView(run)
  assert.equal(view.status, 'active')
  assert.equal(view.round, 2)
  assert.deepEqual(view.controls, ['pause', 'stop'])
  assert.equal(view.rounds.length, 2)
  const [r1, r2] = view.rounds
  assert.equal(r1.results.length, 3)
  assert.equal(r1.submission.replace[0].reason_type, 'exploration')
  assert.equal(r1.checks.receipt_complete.result, 'pass')
  assert.equal(r1.checks.state_carried.result, 'pending')
  assert.equal(r2.submission, null)
  assert.equal(r2.results, null)
  // 目标是 maximize，读数按从大到小排
  const values = view.observations.map((o) => o.value)
  assert.deepEqual(values, [...values].sort((a, b) => b - a))
  assert.equal(view.notes[0].text, '第一轮读数都偏低')
  assert.ok(view.events.some((e) => e.type === 'selection/submitted' && e.source === 'model'))
  assert.ok(view.events.every((e) => !('data' in e)))
})

test('GET returns the view, or null for a session without a task', async () => {
  const ok = await (await fetch(`${base}/sessions/sess-1`)).json()
  assert.equal(ok.run.run_id, 'sess-1')
  const none = await (await fetch(`${base}/sessions/other`)).json()
  assert.equal(none.run, null)
  assert.equal((await fetch(`${base}/sessions/..%2Fetc`)).status, 404)
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404)
})

test('control requires JSON plus the custom header, and applies the action', async () => {
  assert.equal((await post('/sessions/sess-1/control', { action: 'pause' }, { 'content-type': 'text/plain' })).status, 403)
  assert.equal((await post('/sessions/sess-1/control', { action: 'pause' }, { 'content-type': 'application/json' })).status, 403)
  assert.equal((await post('/sessions/sess-1/control', { action: 'explode' })).status, 400)
  assert.equal((await post('/sessions/other/control', { action: 'pause' })).status, 404)
  assert.equal((await fetch(`${base}/sessions/sess-1/control`)).status, 405)
  assert.deepEqual(controlled, [])

  const paused = await (await post('/sessions/sess-1/control', { action: 'pause' })).json()
  assert.equal(paused.run.status, 'paused')
  assert.deepEqual(paused.run.controls, ['resume', 'stop'])
  const stopped = await (await post('/sessions/sess-1/control', { action: 'stop' })).json()
  assert.equal(stopped.run.status, 'stopped')
  assert.deepEqual(stopped.run.controls, [])
  // 已结束的任务再操作：Run 拒绝，路由答 400
  const again = await post('/sessions/sess-1/control', { action: 'resume' })
  assert.equal(again.status, 400)
  assert.deepEqual(controlled.map((x) => x[1]), ['pause', 'stop', 'resume'])
  assert.ok(panelView(run).events.some((e) => e.type === 'run/paused' && e.source === 'human'))
})

test('view carries hypothesis history and the analyses that were run', async () => {
  const measured = run.state.observations[0].id
  run.updateHypothesis({ text: '偏低', status: 'proposed', cites: [measured] })
  run.updateHypothesis({ id: 'H1', status: 'weakened', cites: [], rationale: '复测后不低' })
  run.recordAnalysis({ id: 'A1', purpose: '算相关', exit_code: 0, timed_out: false, duration_ms: 12, dir: 'analysis/A1', files: [] })
  const view = panelView(run)
  assert.deepEqual(view.hypotheses[0].history.map((x) => [x.status, x.rationale]), [['proposed', null], ['weakened', '复测后不低']])
  assert.equal(view.hypotheses[0].updates, 2)
  assert.deepEqual(view.analyses.map((x) => [x.id, x.purpose, x.round, x.exit_code]), [['A1', '算相关', 2, 0]])
})

test('run list and status routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-runs-'))
  try {
    const services = fakeServices()
    await Run.start({ dir: join(root, 'older'), runId: 'older', services })
    await new Promise((r) => setTimeout(r, 20))
    const newer = await Run.start({ dir: join(root, 'newer'), runId: 'newer', services })
    newer.control('stop', 'human')
    mkdirSync(join(root, 'not-a-run'))
    writeFileSync(join(root, 'stray.txt'), 'x', 'utf8')
    const runs = listRuns(root)
    assert.deepEqual(runs.map((x) => [x.run_id, x.status, x.round, x.max_rounds, x.title, x.synthetic]), [
      ['newer', 'stopped', 1, 3, '测试任务', true],
      ['older', 'active', 1, 3, '测试任务', true],
    ])
    assert.deepEqual(listRuns(join(root, 'missing')), [])

    const handler = createPanelHandler({ getRun: () => undefined, control() {}, listRuns: () => runs, status: async () => ({ token_set: false }) })
    const s = createServer(handler)
    await new Promise((r) => s.listen(0, '127.0.0.1', r))
    const b = `http://127.0.0.1:${s.address().port}${PANEL_ROUTE}`
    try {
      assert.deepEqual((await (await fetch(`${b}/sessions`)).json()).runs.map((x) => x.run_id), ['newer', 'older'])
      assert.deepEqual(await (await fetch(`${b}/status`)).json(), { token_set: false })
      assert.equal((await fetch(`${b}/sessions`, { method: 'POST' })).status, 405)
      assert.equal((await fetch(`${b}/status/x`)).status, 404)
    } finally {
      s.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
