// 测试用的 oracle 和决策模块替身：行为和 services/ppsvc 的接口一致，但规模很小、完全确定。
// 被测对象是 Run / 审计 / 记录，它们照常运行；这里替换的只是外部 HTTP 服务。
// 任务包（task.json、candidates.csv、一个公开数据文件）写在临时目录里，和真服务一样由插件直接读。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * @param options.empty - 这些候选的读数为空（readout: null）
 * @param options.required - 决策模块默认方法声明的必需输入 [{role, modality}]
 * @param options.otherTask - 再列一个任务（同一个任务包，换了 task_id 和标题），用来测选任务
 */
export function fakeServices({
  n = 20,
  batchSize = 3,
  rounds = 3,
  allowRepeats = true,
  dropFromReceipt = null,
  empty = [],
  direction = 'high',
  required = [],
  otherTask = false,
} = {}) {
  const ids = Array.from({ length: n }, (_, i) => `G${String(i).padStart(3, '0')}`)
  const truth = Object.fromEntries(ids.map((id, i) => [id, Math.sin(i)]))
  const packageDir = mkdtempSync(join(tmpdir(), 'pp-task-'))
  const card = {
    task_id: 'fake-task',
    title: '测试任务',
    synthetic: true,
    brief: '测试用任务',
    action: { type: 'knockout', description: 'CRISPR 敲除' },
    readout: {
      fields: [
        { name: 'score', description: '效应（有符号）' },
        { name: 'absolute_effect', description: '效应的绝对值' },
      ],
      primary: 'score',
    },
    objective: { kind: 'hit_discovery', field: 'score', direction, description: '找效应最强的基因' },
    budget: { rounds, batch_size: batchSize, allow_repeats: allowRepeats },
    data_cards: [{ name: 'expr', modality: 'expression', index: 'id', role: 'candidate_features', visibility: 'public', file: 'data/expr.csv' }],
  }
  writeFileSync(join(packageDir, 'task.json'), JSON.stringify(card), 'utf8')
  writeFileSync(join(packageDir, 'candidates.csv'), `id,name\n${ids.map((id) => `${id},gene ${id}`).join('\n')}\n`, 'utf8')
  mkdirSync(join(packageDir, 'data'))
  writeFileSync(join(packageDir, 'data', 'expr.csv'), `id,x\n${ids.map((id, i) => `${id},${i}`).join('\n')}\n`, 'utf8')

  const preview = { ...card, package_dir: packageDir, n_candidates: ids.length }
  const tasks = otherTask ? [preview, { ...preview, task_id: 'other-task', title: '另一个任务' }] : [preview]
  let active = tasks.length === 1 ? card.task_id : null
  let method = 'coverage'
  let replicates = {}
  let obs = []
  let version = 0
  const calls = []
  const log = (name, body) => calls.push({ name, body })
  return {
    calls,
    packageDir,
    card,
    async task() {
      log('task')
      return preview
    },
    async tasks() {
      log('tasks')
      return { tasks, active }
    },
    async manifest() {
      log('manifest')
      return {
        name: 'fake',
        version: 'fake/0',
        method: 'coverage',
        methods: { coverage: '按顺序覆盖', 'gp-ucb': '高斯过程' },
        requires: { coverage: [], 'gp-ucb': [{ role: 'candidate_features', modality: 'embedding' }] },
        inputs: { required, optional: [] },
      }
    },
    async init(body) {
      log('init', body)
      obs = []
      version = 0
      method = body.method ?? 'coverage'
      return { ok: true, decision_version: 'fake/0', method, inputs_used: [] }
    },
    async resetOracle(body) {
      log('resetOracle', body)
      replicates = {}
      active = body.task_id ?? active
      return { ok: true, task_id: active, batch_size: body.batch_size ?? batchSize }
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
        method,
        state_version: version,
        inputs_used: [],
        n_observations: obs.length,
        params: {},
        recommendations: recs.map((id, i) => ({ id, rank: i + 1, score: 1 - i / 100 })),
        pool: ids.map((id, i) => ({ id, measured: seen.has(id), score: 1 - i / 100 })),
      }
    },
    async run(body) {
      log('run', body)
      const results = body.batch.map((id) => {
        const rep = replicates[id] ?? 0
        replicates[id] = rep + 1
        const v = truth[id] + rep * 0.01
        return { id, replicate: rep, readout: empty.includes(id) ? null : { score: v, absolute_effect: Math.abs(v) } }
      })
      return { oracle_version: 'fake-oracle/0', round: body.round, results }
    },
    async observe(body) {
      log('observe', body)
      const usable = body.observations.filter((o) => typeof o.readout?.score === 'number')
      const accepted = usable.filter((o) => o.id !== dropFromReceipt)
      const rejected = body.observations.filter((o) => !usable.includes(o)).map((o) => ({ id: o.id, reason: 'empty_readout' }))
      const before = version
      obs.push(...accepted)
      if (accepted.length) version += 1
      return {
        decision_version: 'fake/0',
        round: body.round,
        accepted: accepted.map((o) => o.id),
        rejected,
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
