import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { Run, RunError } from '../lib/run.js'
import { fakeServices } from './fake-services.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pp-run-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

async function playRound(run, services, { replace = [] } = {}) {
  const d = await run.getDecision(services)
  const outs = new Set(replace.map((x) => x.out))
  const accept = d.recommendations.map((x) => x.id).filter((id) => !outs.has(id))
  return run.submitSelection({ accept, replace }, services)
}

test('start resets both services and writes the task card', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  assert.deepEqual(services.calls.map((c) => c.name), ['task', 'manifest', 'resetOracle', 'restore'])
  assert.equal(services.calls[3].body.snapshot.observations.length, 0)
  assert.equal(readJson(join(dir, 'task.json')).candidates.length, 20)
  assert.equal(run.state.round, 1)
  assert.equal(run.nextRoundToDrive(), 1)
})

test('full closed loop: rounds advance, audit passes, records written', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  for (let r = 1; r <= 3; r++) {
    run.markDriven(r)
    if (r > 1) run.updateHypothesis({ text: `假设${r}`, status: 'proposed', cites: [run.state.rounds[r - 1].submission.batch[0]] })
    const res = await playRound(run, services, r === 2 ? { replace: [{ out: 'G004', in: 'G000', reason_type: 'data_quality', reason: '复测 G000' }] } : {})
    assert.equal(res.round, r)
  }
  assert.equal(run.state.status, 'finished')
  assert.equal(run.state.observations.length, 9)
  // 第 2 轮换进来的 G000 是第二次测
  assert.equal(run.state.rounds[2].results.find((x) => x.id === 'G000').replicate, 1)

  const audit = readJson(join(dir, 'audit.json'))
  const byRound = Object.fromEntries(audit.rounds.map((x) => [x.round, x.checks]))
  for (const r of [1, 2, 3]) {
    assert.equal(byRound[r].decision_called.result, 'pass')
    assert.equal(byRound[r].selection_submitted.result, 'pass')
    assert.equal(byRound[r].receipt_complete.result, 'pass')
  }
  assert.equal(byRound[1].state_carried.result, 'pass')
  assert.equal(byRound[2].state_carried.result, 'pass')
  assert.equal(byRound[3].state_carried.result, 'n/a')
  assert.equal(byRound[1].cited_later.result, 'pass')
  assert.equal(byRound[2].cited_later.result, 'pass')
  assert.equal(byRound[3].cited_later.result, 'n/a') // 最后一轮交完就结束了，之后不能再引用

  const events = readJsonl(join(dir, 'events.jsonl'))
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1))
  const types = events.map((e) => e.type)
  for (const t of ['run/started', 'round/started', 'decision/proposed', 'selection/submitted', 'oracle/results', 'decision/observed', 'hypothesis/updated', 'run/finished']) {
    assert.ok(types.includes(t), `missing ${t}`)
  }
  assert.ok(events.every((e) => e.run_id === 's1'))
  assert.equal(readJson(join(dir, 'decision', '02-snapshot.json')).state_version, 2)
  assert.equal(readJson(join(dir, 'oracle', '03-run.json')).results.length, 3)
  assert.equal(readJson(join(dir, 'memory.json')).hypotheses.length, 2)
  assert.throws(() => run.writeNote({ text: 'x', cites: [] }), RunError)
})

test('audit fails uncited readings once the run is stopped early', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  run.markDriven(1)
  await playRound(run, services)
  let checks = readJson(join(dir, 'audit.json')).rounds[0].checks
  assert.equal(checks.cited_later.result, 'pending')
  run.control('stop', 'human')
  checks = readJson(join(dir, 'audit.json')).rounds[0].checks
  assert.equal(checks.cited_later.result, 'fail')
})

test('submission is rejected without a decision call or with bad coverage', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  await assert.rejects(run.submitSelection({ accept: ['G000'], replace: [] }, services), /pp_get_decision/)
  await run.getDecision(services)
  await assert.rejects(run.submitSelection({ accept: ['G000'], replace: [] }, services), /既没有 accept/)
  await assert.rejects(run.submitSelection({ accept: ['G000', 'G001', 'G009'], replace: [] }, services), /不在本轮推荐/)
  await assert.rejects(
    run.submitSelection({ accept: ['G000', 'G001'], replace: [{ out: 'G002', in: 'G001', reason_type: 'exploration', reason: 'x' }] }, services),
    /重复/,
  )
  await assert.rejects(
    run.submitSelection({ accept: ['G000', 'G001'], replace: [{ out: 'G002', in: 'NOPE', reason_type: 'bogus', reason: '' }] }, services),
    (e) => /不是候选/.test(e.message) && /reason_type/.test(e.message) && /缺少理由/.test(e.message),
  )
  assert.equal(services.calls.filter((c) => c.name === 'run').length, 0)
})

test('citations must refer to measured candidates', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  assert.throws(() => run.updateHypothesis({ text: 'x', status: 'proposed', cites: ['G000'] }), /还没测过/)
  await playRound(run, services)
  assert.equal(run.updateHypothesis({ text: 'x', status: 'proposed', cites: ['G000'] }).id, 'H1')
  assert.equal(run.updateHypothesis({ id: 'H1', status: 'supported', cites: ['G001'] }).status, 'supported')
  assert.deepEqual(run.state.hypotheses[0].cites, ['G000', 'G001'])
  assert.throws(() => run.updateHypothesis({ id: 'H9', status: 'supported', cites: [] }), /没有编号/)
})

test('receipt mismatch pauses the run and fails the audit', async () => {
  const services = fakeServices({ dropFromReceipt: 'G001' })
  const run = await Run.start({ dir, runId: 's1', services })
  const res = await playRound(run, services)
  assert.match(res.problem, /对不上/)
  assert.equal(run.state.status, 'paused')
  assert.equal(run.nextRoundToDrive(), null)
  const audit = readJson(join(dir, 'audit.json'))
  assert.equal(audit.rounds[0].checks.receipt_complete.result, 'fail')
  assert.deepEqual(audit.rounds[0].checks.receipt_complete.missing, ['G001'])
})

test('driver bookkeeping: steer limit, stall, pause and resume', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  run.markDriven(1)
  assert.equal(run.nextRoundToDrive(), null) // 已经驱动过的轮次不再重复开
  assert.equal(run.shouldSteer(1, 2), true)
  run.markSteered(1)
  run.markSteered(1)
  assert.equal(run.shouldSteer(1, 2), false)
  assert.equal(run.stallIfOpen(1), true)
  assert.equal(run.state.status, 'paused')
  run.control('resume', 'human')
  assert.equal(run.nextRoundToDrive(), 1) // 恢复后重新驱动没交的那一轮
  run.markDriven(1)
  await playRound(run, services)
  assert.equal(run.stallIfOpen(1), false)
  assert.equal(run.nextRoundToDrive(), 2)
  assert.equal(run.state.rounds[1].steers, 2)
  run.control('pause', 'human')
  assert.equal(run.nextRoundToDrive(), null)
  run.control('stop', 'human')
  assert.throws(() => run.control('resume', 'human'), /已停止/)
})

test('a run reloads from disk with the same state', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  await playRound(run, services)
  run.writeNote({ text: '笔记', cites: ['G000'] })
  const again = Run.load(dir, 's1')
  assert.deepEqual(again.state, run.state)
  again.writeNote({ text: '第二条', cites: [] })
  const seqs = readJsonl(join(dir, 'events.jsonl')).map((e) => e.seq)
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1))
})

test('brief mentions round, synthetic flag and readings', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  assert.match(run.brief(), /第 1\/3 轮：还没调用 pp_get_decision/)
  assert.match(run.brief(), /合成数据/)
  await playRound(run, services)
  const text = run.brief()
  assert.match(text, /第 2\/3 轮/)
  assert.match(text, /上一轮（第 1 轮）读数：G000=0，G001=0\.8415/)
})
