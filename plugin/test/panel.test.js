// 面板路由测试：真实的 Run（oracle 和决策模块用替身）+ 真实的 HTTP 处理函数，检查视图内容、防伪造、控制动作。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { LOGO_PATH, PANEL_ROUTE, PanelError, createPanelHandler, listRuns, panelView, taskPreview } from '../lib/panel.js'
import { ServiceError } from '../lib/services.js'
import { Run } from '../lib/run.js'
import { fakeServices } from './fake-services.js'

let dir
let server
let base
let run
let controlled
let packages

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pp-panel-'))
  const services = fakeServices({ empty: ['G002'] })
  packages = [services.packageDir]
  run = await Run.start({ dir, runId: 'sess-1', services })
  run.markDriven(1)
  const d = await run.getDecision(services)
  const ids = d.recommendations.map((x) => x.id)
  const extra = d.alternatives[0].id
  await run.submitSelection({ batch: [ids[1], ids[2], extra], groups: [{ ids: [extra], source: 'exploration', reason: '看看' }] }, services)
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
  for (const p of packages) rmSync(p, { recursive: true, force: true })
})

const post = (path, body, headers = { 'content-type': 'application/json', 'x-perturbpilot': '1' }) =>
  fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })

test('view summarizes rounds, audit, ranked observations and events', () => {
  const view = panelView(run)
  assert.equal(view.status, 'active')
  assert.equal(view.round, 2)
  assert.deepEqual(view.controls, ['pause', 'stop'])
  assert.deepEqual(view.task.budget, { rounds: 3, batch_size: 3, allow_repeats: true })
  assert.equal(view.task.goal, 'high')
  assert.equal(view.task.objective_text, '找效应最强的基因（看 score，越高越好）')
  assert.deepEqual(view.task.readout_fields, ['score', 'absolute_effect'])
  assert.equal(view.decision.method, 'coverage')
  assert.equal(view.rounds.length, 2)
  const [r1, r2] = view.rounds
  assert.equal(r1.method, 'coverage')
  assert.deepEqual(r1.submission, {
    batch: ['G001', 'G002', 'G003'],
    groups: [{ ids: ['G003'], source: 'exploration', reason: '看看' }],
    outside: ['G003'],
    from_recommendation: 2,
  })
  assert.deepEqual(r1.results[0], { id: 'G001', replicate: 0, value: 0.8415, readout: { score: 0.8415, absolute_effect: 0.8415 } })
  assert.deepEqual(r1.results[1], { id: 'G002', replicate: 0, value: null, readout: null })
  assert.deepEqual(r1.receipt, { accepted: 2, rejected: 1, state_version_before: 0, state_version_after: 1 })
  assert.equal(r1.checks.receipt_complete.result, 'pass')
  assert.equal(r1.checks.state_carried.result, 'pending')
  assert.equal(r2.submission, null)
  assert.equal(r2.results, null)
  // 目标越高越好，读数按从大到小排，空读数在最后
  assert.deepEqual(view.observations.map((o) => [o.id, o.value]), [['G001', 0.8415], ['G003', 0.1411], ['G002', null]])
  assert.equal(view.notes[0].text, '第一轮读数都偏低')
  assert.deepEqual(view.retrievals, [])
  assert.ok(view.events.some((e) => e.type === 'selection/submitted' && e.source === 'model'))
  assert.ok(view.events.every((e) => !('data' in e)))
})

test('view lists retrievals with their round and tool', () => {
  run.recordRetrieval({ name: 'web_search', arguments: { queries: ['G001 通路'] } }, { message: { isError: false, content: [{ type: 'text', text: 'x' }] }, meta: { sources: [{ url: 'https://example.org', title: 'E' }] } })
  const [x] = panelView(run).retrievals
  assert.equal(x.round, 2)
  assert.equal(x.tool, 'web_search')
  assert.deepEqual(x.queries, ['G001 通路'])
  assert.deepEqual(x.results, [{ title: 'E', url: 'https://example.org' }])
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
    packages.push(services.packageDir)
    await Run.start({ dir: join(root, 'older'), runId: 'older', services })
    await new Promise((r) => setTimeout(r, 20))
    const newer = await Run.start({ dir: join(root, 'newer'), runId: 'newer', services })
    newer.control('stop', 'human')
    // 早期版本留下的记录：只列出，标 legacy。
    mkdirSync(join(root, 'ancient'))
    writeFileSync(join(root, 'ancient', 'state.json'), JSON.stringify({ runId: 'ancient', status: 'finished', round: 3, task: { title: '旧任务', max_rounds: 3 } }), 'utf8')
    utimesSync(join(root, 'ancient', 'state.json'), new Date(2000, 0, 1), new Date(2000, 0, 1))
    mkdirSync(join(root, 'not-a-run'))
    writeFileSync(join(root, 'stray.txt'), 'x', 'utf8')
    const runs = listRuns(root)
    assert.deepEqual(runs.map((x) => [x.run_id, x.status, x.round, x.max_rounds, x.title, x.synthetic, x.legacy ?? false]), [
      ['newer', 'stopped', 1, 3, '测试任务', true, false],
      ['older', 'active', 1, 3, '测试任务', true, false],
      ['ancient', 'finished', 3, 3, '旧任务', null, true],
    ])
    assert.deepEqual(listRuns(join(root, 'missing')), [])

    const handler = createPanelHandler({ getRun: () => undefined, control() {}, listRuns: () => runs, status: async () => ({ token_set: false }) })
    const s = createServer(handler)
    await new Promise((r) => s.listen(0, '127.0.0.1', r))
    const b = `http://127.0.0.1:${s.address().port}${PANEL_ROUTE}`
    try {
      assert.deepEqual((await (await fetch(`${b}/sessions`)).json()).runs.map((x) => x.run_id), ['newer', 'older', 'ancient'])
      assert.deepEqual(await (await fetch(`${b}/status`)).json(), { token_set: false })
      assert.equal((await fetch(`${b}/sessions`, { method: 'POST' })).status, 405)
      assert.equal((await fetch(`${b}/status/x`)).status, 404)
      const logo = await fetch(`${b}/logo`)
      assert.equal(logo.headers.get('content-type'), 'image/png')
      const bytes = Buffer.from(await logo.arrayBuffer())
      assert.deepEqual(bytes, readFileSync(LOGO_PATH))
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
      assert.equal((await fetch(`${b}/logo`, { method: 'POST' })).status, 405)
    } finally {
      s.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start creates the run with the chosen setup; the tasks route lists previews; a pending proposal shows before start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-start-'))
  const services = fakeServices({ otherTask: true })
  packages.push(services.packageDir)
  const runs = new Map()
  const started = []
  const proposal = { task_id: 'other-task', method: null, rounds: 2, batch_size: null, rationale: '最接近' }
  const handler = createPanelHandler({
    getRun: (id) => runs.get(id),
    control() {},
    async start(id, setup) {
      if (id !== 'fresh') throw new PanelError(404, '找不到这个会话')
      runs.set(id, await Run.start({ dir: join(root, id), runId: id, services, setup }))
      started.push([id, setup])
    },
    proposal: (id) => (id === 'fresh' ? proposal : null),
    tasks: async () => ({ tasks: (await services.tasks()).tasks.map(taskPreview) }),
  })
  const s = createServer(handler)
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${s.address().port}${PANEL_ROUTE}`
  const postTo = (path, headers = { 'content-type': 'application/json', 'x-perturbpilot': '1' }, body = '{}') =>
    fetch(b + path, { method: 'POST', headers, body })
  try {
    const { tasks } = await (await fetch(`${b}/tasks`)).json()
    const [task] = tasks
    assert.deepEqual(tasks.map((t) => t.task_id), ['fake-task', 'other-task'])
    assert.equal(task.title, '测试任务')
    assert.equal(task.package_dir, undefined) // 不把服务本机的路径给浏览器
    assert.equal(task.objective_text, '找效应最强的基因（看 score，越高越好）')
    assert.deepEqual(task.budget, { rounds: 3, batch_size: 3, allow_repeats: true })
    assert.equal((await fetch(`${b}/tasks`, { method: 'POST' })).status, 405)
    assert.deepEqual(await (await fetch(`${b}/sessions/fresh`)).json(), { run: null, proposal })

    assert.equal((await postTo('/sessions/fresh/start', { 'content-type': 'application/json' })).status, 403)
    assert.equal((await fetch(`${b}/sessions/fresh/start`)).status, 405)
    assert.equal((await postTo('/sessions/nobody/start')).status, 404)
    assert.deepEqual(started, [])

    // 两个任务时不给 task_id 开不了，报错原样回给面板
    const bad = await postTo('/sessions/fresh/start')
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /要指定 task_id/)
    const setup = { task_id: 'other-task', rounds: 2, batch_size: 4, extra: 'ignored' }
    const res = await (await postTo('/sessions/fresh/start', undefined, JSON.stringify(setup))).json()
    assert.equal(res.run.run_id, 'fresh')
    assert.equal(res.run.task.task_id, 'other-task')
    assert.deepEqual(res.run.task.budget, { rounds: 2, batch_size: 4, allow_repeats: true })
    assert.deepEqual(await (await fetch(`${b}/sessions/fresh`)).json().then((x) => x.proposal), null)
    assert.equal(res.run.status, 'active')
    assert.equal(res.run.round, 1)
    // 开过的会话不能再开
    const again = await postTo('/sessions/fresh/start')
    assert.equal(again.status, 400)
    assert.match((await again.json()).error, /已经开始过/)
    assert.deepEqual(started, [['fresh', { task_id: 'other-task', method: undefined, rounds: 2, batch_size: 4 }]])
  } finally {
    s.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('service failures while starting come back as 502 with the message', async () => {
  const handler = createPanelHandler({
    getRun: () => undefined,
    control() {},
    start: async () => { throw new ServiceError('oracle', '/task', 0, 'unreachable at http://127.0.0.1:1') },
    tasks: async () => { throw new ServiceError('oracle', '/tasks', 0, 'unreachable at http://127.0.0.1:1') },
  })
  const s = createServer(handler)
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${s.address().port}${PANEL_ROUTE}`
  try {
    const t = await fetch(`${b}/tasks`)
    assert.equal(t.status, 502)
    assert.match((await t.json()).error, /oracle \/tasks failed: unreachable/)
    const r = await fetch(`${b}/sessions/x/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-perturbpilot': '1' }, body: '{}' })
    assert.equal(r.status, 502)
  } finally {
    s.close()
  }
})
