// 测试用的 oracle 和决策模块替身：行为和 services/ppsvc 的接口一致，但规模很小、完全确定。
// 被测对象是 Run / 审计 / 记录，它们照常运行；这里替换的只是外部 HTTP 服务。

export function fakeServices({ n = 20, batchSize = 3, maxRounds = 3, dropFromReceipt = null } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `G${String(i).padStart(3, '0')}`)
  const truth = Object.fromEntries(ids.map((id, i) => [id, Math.sin(i)]))
  let replicates = {}
  let obs = []
  let version = 0
  const calls = []
  const log = (name, body) => calls.push({ name, body })
  return {
    calls,
    async task() {
      log('task')
      return {
        task_id: 'fake-task',
        title: '测试任务',
        synthetic: true,
        objective: { name: 'phenotype_reduction', direction: 'maximize' },
        batch_size: batchSize,
        max_rounds: maxRounds,
        data_cards: [],
        candidates: ids.map((id) => ({ id, features: [0] })),
      }
    },
    async manifest() {
      log('manifest')
      return { name: 'fake', version: 'fake/0' }
    },
    async resetOracle(body) {
      log('resetOracle', body)
      replicates = {}
      return { ok: true }
    },
    async restore(body) {
      log('restore', body)
      obs = [...body.snapshot.observations]
      version = body.snapshot.state_version
      return { ok: true, state_version: version }
    },
    async propose(body) {
      log('propose', body)
      const seen = new Set(obs.map((o) => o.id))
      const recs = ids.filter((id) => !seen.has(id)).slice(0, body.k)
      return {
        decision_version: 'fake/0',
        round: body.round,
        state_version: version,
        n_observations: obs.length,
        recommendations: recs.map((id, i) => ({ id, mu: 0, sigma: 1, score: 1 - i / 100, rank: i + 1 })),
        pool: [],
      }
    },
    async run(body) {
      log('run', body)
      const results = body.batch.map((id) => {
        const rep = replicates[id] ?? 0
        replicates[id] = rep + 1
        return { id, value: truth[id] + rep * 0.01, replicate: rep }
      })
      return { oracle_version: 'fake-oracle/0', round: body.round, results }
    },
    async observe(body) {
      log('observe', body)
      const accepted = body.observations.filter((o) => o.id !== dropFromReceipt)
      const before = version
      obs.push(...accepted)
      if (accepted.length) version += 1
      return {
        decision_version: 'fake/0',
        round: body.round,
        accepted: accepted.map((o) => o.id),
        rejected: [],
        state_version_before: before,
        state_version_after: version,
        n_observations: obs.length,
      }
    },
    async snapshot() {
      log('snapshot')
      return { decision_version: 'fake/0', state_version: version, observations: obs }
    },
  }
}
