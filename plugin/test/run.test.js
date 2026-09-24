import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { Run, RunError } from '../lib/run.js'
import { fakeServices as makeServices } from './fake-services.js'

let dir
let packages
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pp-run-'))
  packages = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const p of packages) rmSync(p, { recursive: true, force: true })
})

function fakeServices(options) {
  const services = makeServices(options)
  packages.push(services.packageDir)
  return services
}

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** 照推荐交一轮；extra = [{id, source, reason}] 把推荐的最后几个换成推荐以外的候选。 */
async function playRound(run, services, { extra = [] } = {}) {
  const d = await run.getDecision(services)
  const recs = d.recommendations.map((x) => x.id)
  const batch = [...recs.slice(0, recs.length - extra.length), ...extra.map((x) => x.id)]
  const groups = extra.map((x) => ({ ids: [x.id], source: x.source, reason: x.reason }))
  return run.submitSelection({ batch, groups }, services)
}

test('start hands the task package to the decision module, resets the oracle and writes the card', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  assert.deepEqual(services.calls.map((c) => c.name), ['task', 'manifest', 'init', 'resetOracle'])
  assert.equal(services.calls[2].body.package_dir, services.packageDir)
  assert.equal(readJson(join(dir, 'task.json')).n_candidates, 20)
  assert.equal(run.state.format, 2)
  assert.equal(run.state.candidateIds.length, 20)
  assert.deepEqual(run.state.decision, { name: 'fake', version: 'fake/0', method: 'coverage', inputs_used: [] })
  assert.equal(run.state.round, 1)
  assert.equal(run.nextRoundToDrive(), 1)
  const started = readJsonl(join(dir, 'events.jsonl'))[0]
  assert.equal(started.type, 'run/started')
  assert.equal(started.data.method, 'coverage')
  assert.deepEqual(started.data.budget, { rounds: 3, batch_size: 3, allow_repeats: true })
})

test('start refuses a decision module whose required inputs the task package lacks', async () => {
  const services = fakeServices({ required: [{ role: 'candidate_features', modality: 'embedding' }] })
  await assert.rejects(Run.start({ dir, runId: 's1', services }), /candidate_features\/embedding/)
  assert.equal(services.calls.filter((c) => c.name === 'init').length, 0)
})

test('full closed loop: rounds advance, audit passes, records written', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  for (let r = 1; r <= 3; r++) {
    run.markDriven(r)
    if (r > 1) run.updateHypothesis({ text: `假设${r}`, status: 'proposed', cites: [run.state.rounds[r - 1].submission.batch[0]] })
    const res = await playRound(run, services, r === 2 ? { extra: [{ id: 'G000', source: 'data_quality', reason: '复测 G000' }] } : {})
    assert.equal(res.round, r)
  }
  assert.equal(run.state.status, 'finished')
  assert.equal(run.state.observations.length, 9)
  // 第 2 轮推荐以外进来的 G000 是第二次测
  const again = run.state.rounds[2].results.find((x) => x.id === 'G000')
  assert.equal(again.replicate, 1)
  assert.equal(again.readout.score, 0.01)
  const sub = run.state.rounds[2].submission
  assert.deepEqual(sub.outside, ['G000'])
  assert.equal(sub.from_recommendation, 2)
  assert.deepEqual(sub.by_source, { decision: 2, data_quality: 1 })

  const audit = readJson(join(dir, 'audit.json'))
  const byRound = Object.fromEntries(audit.rounds.map((x) => [x.round, x.checks]))
  for (const r of [1, 2, 3]) {
    assert.equal(byRound[r].decision_called.result, 'pass')
    assert.equal(byRound[r].selection_submitted.result, 'pass')
    assert.equal(byRound[r].literature_backed.result, 'n/a')
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
  assert.equal(run.state.rounds[1].proposals[0].file, 'decision/01-propose-1.json')
  assert.equal(readJson(join(dir, 'decision', '01-propose-1.json')).pool.length, 20)
  assert.throws(() => run.writeNote({ text: 'x', cites: [] }), RunError)
})

test('the decision is asked for the batch plus alternatives and returns the method and numbers', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  const d = await run.getDecision(services)
  assert.equal(services.calls.at(-1).body.k, 3 + 8)
  assert.equal(d.method, 'coverage')
  assert.equal(d.batch_size, 3)
  assert.equal(d.rounds, 3)
  assert.deepEqual(d.recommendations[0], { id: 'G000', rank: 1, score: 1 })
  assert.equal(d.alternatives.length, 8)
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

test('submission is rejected without a decision call, with the wrong size or without reasons', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  const submit = (batch, groups = []) => run.submitSelection({ batch, groups }, services)
  await assert.rejects(submit(['G000', 'G001', 'G002']), /pp_get_decision/)
  await run.getDecision(services)
  await assert.rejects(submit(['G000', 'G001']), /正好交 3 个/)
  await assert.rejects(submit(['G000', 'G001', 'G002', 'G003']), /正好交 3 个/)
  await assert.rejects(submit(['G000', 'G001', 'G019']), /G019 不在本轮推荐里，要放进一个写了理由的组/)
  await assert.rejects(submit(['G000', 'G001', 'G019'], [{ ids: ['G019'], source: 'decision', reason: 'x' }]), /source 不能是 decision/)
  await assert.rejects(submit(['G000', 'G001', 'G001']), /重复/)
  await assert.rejects(
    submit(['G000', 'G001', 'NOPE'], [{ ids: ['NOPE', 'G005'], source: 'bogus', reason: '' }]),
    (e) => /NOPE 不是候选/.test(e.message) && /source 必须是/.test(e.message) && /缺少理由/.test(e.message) && /G005 不在 batch 里/.test(e.message),
  )
  await assert.rejects(
    submit(['G000', 'G001', 'G019'], [{ ids: ['G019'], source: 'literature', reason: 'a' }, { ids: ['G019'], source: 'analysis', reason: 'b' }]),
    /不止一个组/,
  )
  assert.equal(services.calls.filter((c) => c.name === 'run').length, 0)
  // 推荐里的候选也可以分组写理由；推荐以外的放进非 decision 的组就合法。
  const res = await submit(['G000', 'G001', 'G019'], [
    { ids: ['G000', 'G001'], source: 'decision', reason: '照推荐' },
    { ids: ['G019'], source: 'prior_knowledge', reason: '已知通路成员' },
  ])
  assert.equal(res.results.length, 3)
  assert.deepEqual(res.results.map((x) => x.recommended), [true, true, false])
})

test('without repeats a measured candidate is refused and the last batch shrinks to what is left', async () => {
  const services = fakeServices({ n: 5, batchSize: 3, rounds: 3, allowRepeats: false })
  const run = await Run.start({ dir, runId: 's1', services })
  await playRound(run, services)
  await run.getDecision(services)
  assert.equal(run.expectedBatchSize(), 2)
  await assert.rejects(run.submitSelection({ batch: ['G003', 'G000'], groups: [{ ids: ['G000'], source: 'data_quality', reason: '复测' }] }, services), /不能重复测/)
  const res = await run.submitSelection({ batch: ['G003', 'G004'], groups: [] }, services)
  assert.deepEqual(res.next, { finished: true })
  assert.equal(run.state.status, 'finished')
  const finished = readJsonl(join(dir, 'events.jsonl')).find((e) => e.type === 'run/finished')
  assert.deepEqual(finished.data, { rounds: 2, reason: 'candidates_exhausted' })
})

test('empty readouts are rejected by the decision module and the receipt still checks out', async () => {
  const services = fakeServices({ empty: ['G001'] })
  const run = await Run.start({ dir, runId: 's1', services })
  const res = await playRound(run, services)
  assert.deepEqual(res.empty, ['G001'])
  assert.equal(res.problem, null)
  assert.equal(res.results.find((x) => x.id === 'G001').readout, null)
  assert.equal(run.state.status, 'active')
  const checks = readJson(join(dir, 'audit.json')).rounds[0].checks
  assert.equal(checks.receipt_complete.result, 'pass')
  assert.deepEqual(checks.receipt_complete.empty, ['G001'])
  assert.match(run.brief(), /其中 1 次读数为空/)
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

test('retrievals are recorded with their full text and back literature reasons in the audit', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  const literature = [{ id: 'G019', source: 'literature', reason: '文献说 G019 在同一通路' }]

  // 第 1 轮：说依据文献，但没查过 → 审计不通过（只审不拦，提交照常进行）。
  await playRound(run, services, { extra: literature })
  let checks = readJson(join(dir, 'audit.json')).rounds[0].checks
  assert.equal(checks.literature_backed.result, 'fail')

  // 第 2 轮：先查（一次出错的不算），再提交 → 通过。
  run.recordRetrieval({ name: 'web_fetch', arguments: { url: 'https://example.org/x' } }, { message: { isError: true, content: [{ type: 'text', text: '404' }] }, meta: { url: 'https://example.org/x', statusCode: 404 } })
  const search = run.recordRetrieval(
    { name: 'web_search', arguments: { queries: ['G018 pathway'] } },
    { message: { isError: false, content: [{ type: 'text', text: '搜索结果正文' }] }, meta: { sources: [{ url: 'https://example.org/a', title: 'A' }] } },
  )
  assert.equal(search.id, 'R2')
  await playRound(run, services, { extra: [{ id: 'G018', source: 'literature', reason: '查到 G018 的报道' }] })
  checks = readJson(join(dir, 'audit.json')).rounds[1].checks
  assert.equal(checks.literature_backed.result, 'pass')
  assert.deepEqual(checks.literature_backed.retrievals, ['R2'])

  const saved = readJson(join(dir, 'retrieval', 'R2.json'))
  assert.equal(saved.text, '搜索结果正文')
  assert.deepEqual(saved.arguments, { queries: ['G018 pathway'] })
  assert.equal(saved.round, 2)
  const events = readJsonl(join(dir, 'events.jsonl'))
  const fetched = events.find((e) => e.type === 'retrieval/fetched')
  assert.deepEqual(fetched.data, { id: 'R1', url: 'https://example.org/x', status: 404, chars: 3, is_error: true, file: 'retrieval/R1.json' })
  const searched = events.find((e) => e.type === 'retrieval/searched')
  assert.deepEqual(searched.data.results, [{ title: 'A', url: 'https://example.org/a' }])
  assert.equal(searched.source, 'model')
  assert.equal(run.ledger().retrievals.length, 2)
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

test('a legacy run is recognised and not opened', () => {
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ runId: 'old', task: { max_rounds: 3 } }), 'utf8')
  assert.equal(Run.exists(dir), true)
  assert.equal(Run.isLegacy(dir), true)
  assert.throws(() => Run.load(dir, 'old'), /旧格式/)
})

test('brief describes the task generically and shows the objective field', async () => {
  const services = fakeServices()
  const run = await Run.start({ dir, runId: 's1', services })
  let text = run.brief()
  assert.match(text, /第 1\/3 轮：还没调用 pp_get_decision/)
  assert.match(text, /合成数据/)
  assert.match(text, /扰动：knockout，CRISPR 敲除/)
  assert.match(text, /目标：找效应最强的基因（看 score，越高越好）/)
  assert.match(text, /读数字段：score（效应（有符号））；absolute_effect/)
  assert.match(text, /共 3 轮，每轮正好 3 个；候选 20 个，可以重复测/)
  assert.match(text, /方法 coverage，没用任何候选特征/)
  await playRound(run, services)
  text = run.brief()
  assert.match(text, /第 2\/3 轮/)
  assert.match(text, /上一轮（第 1 轮）测了 3 个，最好的：G002=0\.9093，G001=0\.8415，G000=0/)
  assert.match(text, /G002 score=0\.9093（第 1 轮）/)
})
