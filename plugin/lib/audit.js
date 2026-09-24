// 配对审计：每一轮检查"决策模块给的、agent 交的、oracle 测的、决策模块收到的、后面用到的"是否对得上。
// 每项结果只有四种：pass / fail / pending（还没到能判的时候）/ n/a（本轮不适用）。

export function auditRun(state) {
  const rounds = []
  for (const r of Object.keys(state.rounds).map(Number).sort((a, b) => a - b)) {
    rounds.push(auditRound(state, r))
  }
  const counts = { pass: 0, fail: 0, pending: 0, 'n/a': 0 }
  for (const round of rounds) for (const check of Object.values(round.checks)) counts[check.result]++
  return { run_id: state.runId, status: state.status, current_round: state.round, counts, rounds }
}

function auditRound(state, r) {
  const rec = state.rounds[r]
  const closed = state.status === 'finished' || state.status === 'stopped'
  const checks = {}

  checks.decision_called = rec.proposals.length > 0
    ? { result: 'pass', calls: rec.proposals.length, forced: rec.steers > 0 }
    : { result: rec.submission || closed || state.round > r ? 'fail' : 'pending' }

  if (!rec.submission) {
    const result = closed || state.round > r ? 'fail' : 'pending'
    checks.selection_submitted = { result }
    checks.receipt_complete = { result: 'n/a' }
    checks.state_carried = { result: 'n/a' }
    checks.cited_later = { result: 'n/a' }
    return { round: r, checks }
  }
  checks.selection_submitted = {
    result: 'pass',
    accepted: rec.submission.accept.length,
    replaced: rec.submission.replace.length,
  }

  const batch = rec.submission.batch
  const receipt = rec.receipt
  if (!receipt) {
    checks.receipt_complete = { result: 'fail', reason: 'no_receipt' }
  } else {
    const accepted = new Set(receipt.accepted)
    const missing = batch.filter((id) => !accepted.has(id))
    const versionOk = receipt.state_version_after === receipt.state_version_before + 1
    checks.receipt_complete = {
      result: missing.length === 0 && receipt.rejected.length === 0 && versionOk ? 'pass' : 'fail',
      missing,
      rejected: receipt.rejected,
      state_version_before: receipt.state_version_before,
      state_version_after: receipt.state_version_after,
    }
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

  const ids = new Set(batch)
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
