// 配对审计：每一轮检查"决策模块给的、agent 交的、oracle 测的、决策模块收到的、后面用到的"是否对得上。
// 每项结果只有四种：pass / fail / pending（还没到能判的时候）/ n/a（本轮不适用）。

import { objectiveValue } from './task.js'

/**
 * 决策模块的回执对不对得上这一轮的读数。读数里目标字段有值的必须全部收下，没值的（空读数）必须被拒收；
 * 收下了至少一条时状态版本加 1，一条都没收时不变。
 */
export function checkReceipt(results, receipt, objective) {
  const usable = results.filter((x) => objectiveValue(x.readout, objective) !== null).map((x) => x.id)
  const empty = results.filter((x) => objectiveValue(x.readout, objective) === null).map((x) => x.id)
  const accepted = new Set(receipt.accepted)
  const rejected = new Set(receipt.rejected.map((x) => x.id))
  const missing = usable.filter((id) => !accepted.has(id))
  const unexpected = receipt.rejected.filter((x) => !empty.includes(x.id))
  const notRejected = empty.filter((id) => !rejected.has(id))
  const expectedAfter = receipt.state_version_before + (usable.length ? 1 : 0)
  return {
    ok: missing.length === 0 && unexpected.length === 0 && notRejected.length === 0 && receipt.state_version_after === expectedAfter,
    missing,
    empty,
    unexpected_rejected: unexpected,
    state_version_before: receipt.state_version_before,
    state_version_after: receipt.state_version_after,
  }
}

/**
 * @param retrievalText - (检索编号) => 那次检索的结果全文（retrieval/R<N>.json 的 text），文献核对要用
 */
export function auditRun(state, retrievalText) {
  const rounds = []
  for (const r of Object.keys(state.rounds).map(Number).sort((a, b) => a - b)) {
    rounds.push(auditRound(state, r, retrievalText))
  }
  const counts = { pass: 0, fail: 0, pending: 0, 'n/a': 0 }
  for (const round of rounds) for (const check of Object.values(round.checks)) counts[check.result]++
  return { run_id: state.runId, status: state.status, current_round: state.round, counts, rounds }
}

/**
 * 文献核对（只审不拦）：本轮提交之前成功的检索里，有没有提到写了 literature 理由的候选。
 * 候选 id 按整词、不分大小写在检索结果全文里找；没提到的记进 unbacked，有一个就不通过。
 * 没写 literature 理由、但检索里提到了的本批候选记进 unlabelled，只作参考，不影响结果。
 * 本轮既没有 literature 理由也没有成功的检索时不适用。
 */
function literatureCheck(state, r, sub, retrievalText) {
  const found = (state.retrievals ?? []).filter((x) => x.round === r && x.at <= sub.at && !x.is_error).map((x) => x.id)
  const literature = sub.groups.filter((g) => g.source === 'literature')
  if (literature.length === 0 && found.length === 0) return { result: 'n/a' }
  const texts = found.map((id) => retrievalText(id) ?? '')
  const mentioned = (cid) => {
    const re = new RegExp(`(?<![A-Za-z0-9_])${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i')
    return texts.some((t) => re.test(t))
  }
  const claimed = new Set(literature.flatMap((g) => g.ids))
  const unbacked = [...claimed].filter((cid) => !mentioned(cid))
  const unlabelled = [...new Set(sub.batch)].filter((cid) => !claimed.has(cid) && mentioned(cid))
  return { result: unbacked.length ? 'fail' : 'pass', groups: literature.length, retrievals: found, unbacked, unlabelled }
}

function auditRound(state, r, retrievalText) {
  const rec = state.rounds[r]
  const closed = state.status === 'finished' || state.status === 'stopped'
  const checks = {}

  checks.decision_called = rec.proposals.length > 0
    ? { result: 'pass', calls: rec.proposals.length, forced: rec.steers > 0 }
    : { result: rec.submission || closed || state.round > r ? 'fail' : 'pending' }

  if (!rec.submission) {
    const result = closed || state.round > r ? 'fail' : 'pending'
    checks.selection_submitted = { result }
    checks.literature_backed = { result: 'n/a' }
    checks.receipt_complete = { result: 'n/a' }
    checks.state_carried = { result: 'n/a' }
    checks.cited_later = { result: 'n/a' }
    return { round: r, checks }
  }
  const sub = rec.submission
  checks.selection_submitted = {
    result: 'pass',
    batch: sub.batch.length,
    from_recommendation: sub.from_recommendation,
    outside: sub.outside,
    by_source: sub.by_source,
  }

  checks.literature_backed = literatureCheck(state, r, sub, retrievalText)

  const receipt = rec.receipt
  if (!receipt) {
    checks.receipt_complete = { result: 'fail', reason: 'no_receipt' }
  } else {
    const { ok, ...detail } = checkReceipt(rec.results ?? [], receipt, state.task.objective)
    checks.receipt_complete = { result: ok ? 'pass' : 'fail', ...detail }
  }

  const next = state.rounds[r + 1]
  if (!receipt) {
    checks.state_carried = { result: 'n/a', reason: 'no_receipt' }
  } else if (next && next.proposals.length > 0) {
    // 下一轮第一次调用决策模块时，它用的状态版本必须等于本轮观测写入后的版本。
    const seen = next.proposals[0].state_version
    checks.state_carried = {
      result: seen === receipt.state_version_after ? 'pass' : 'fail',
      expected: receipt.state_version_after,
      seen,
    }
  } else {
    checks.state_carried = closed ? { result: 'n/a', reason: 'no_later_round' } : { result: 'pending' }
  }

  const ids = new Set(sub.batch)
  const citers = state.citations.filter((c) => c.round > r && c.cites.some((id) => ids.has(id)))
  if (citers.length > 0) {
    checks.cited_later = { result: 'pass', by: citers.map((c) => c.ref) }
  } else if (state.status === 'finished' && r === state.round) {
    // 最后一轮交完任务就结束了，之后不能再写假设或笔记，这项无从判断。
    checks.cited_later = { result: 'n/a', reason: 'no_later_round' }
  } else {
    checks.cited_later = { result: closed ? 'fail' : 'pending' }
  }
  return { round: r, checks }
}
