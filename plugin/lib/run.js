// 一次任务（run）的科学状态：轮次、决策模块的推荐、agent 的选择、读数、假设和笔记。
// 这里不依赖 DSH，工具和回合驱动都只是调用这里的方法；状态每次变动都落盘到 runs/<run_id>/。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { auditRun } from './audit.js'
import { RunRecorder, roundFile } from './records.js'

export const REASON_TYPES = ['hypothesis_test', 'exploration', 'data_quality', 'other']
export const HYPOTHESIS_STATUSES = ['proposed', 'supported', 'weakened', 'rejected']
export const CONTROL_ACTIONS = ['pause', 'resume', 'stop']
const ALTERNATIVES = 8

export class RunError extends Error {}

export class Run {
  static exists(dir) {
    return existsSync(join(dir, 'state.json'))
  }

  static load(dir, runId) {
    const recorder = new RunRecorder(dir, runId)
    return new Run(recorder, recorder.readJson('state.json'))
  }

  static async start({ dir, runId, services, signal }) {
    const card = await services.task(signal)
    const manifest = await services.manifest(signal)
    // 服务进程里可能残留上一次任务的状态，开跑前清空：oracle 的重复测量计数、决策模块的观测。
    await services.resetOracle({}, signal)
    await services.restore({ snapshot: { decision_version: manifest.version, state_version: 0, observations: [] } }, signal)

    const recorder = new RunRecorder(dir, runId)
    recorder.writeJson('task.json', card)
    const { candidates, ...rest } = card
    const state = {
      runId,
      task: { ...rest, n_candidates: candidates.length },
      candidateIds: candidates.map((c) => c.id),
      decision: { name: manifest.name, version: manifest.version },
      status: 'active',
      round: 1,
      lastDrivenRound: 0,
      rounds: {},
      observations: [],
      hypotheses: [],
      notes: [],
      citations: [],
    }
    const run = new Run(recorder, state)
    recorder.event('run/started', 'framework', 1, {
      task_id: card.task_id,
      synthetic: card.synthetic,
      max_rounds: card.max_rounds,
      batch_size: card.batch_size,
      decision_version: manifest.version,
      oracle_task: card.task_id,
    })
    run.save()
    return run
  }

  constructor(recorder, state) {
    this.recorder = recorder
    this.state = state
    this.candidateSet = new Set(state.candidateIds)
  }

  get closed() {
    return this.state.status === 'finished' || this.state.status === 'stopped'
  }

  roundRecord(r) {
    this.state.rounds[r] ??= { round: r, proposals: [], steers: 0, submission: null, results: null, receipt: null }
    return this.state.rounds[r]
  }

  requireOpen() {
    if (this.closed) throw new RunError(`任务已${this.state.status === 'finished' ? '完成' : '停止'}，不能再操作。`)
  }

  // ---- 决策模块 ----

  async getDecision(services, signal) {
    this.requireOpen()
    const r = this.state.round
    const k = this.state.task.batch_size
    const proposal = await services.propose({ round: r, k: k + ALTERNATIVES }, signal)
    const rec = this.roundRecord(r)
    const index = rec.proposals.length + 1
    this.recorder.writeJson(join('decision', roundFile(`propose-${index}`, r)), proposal)
    const recommendations = proposal.recommendations.slice(0, k)
    const alternatives = proposal.recommendations.slice(k)
    rec.proposals.push({
      at: new Date().toISOString(),
      state_version: proposal.state_version,
      n_observations: proposal.n_observations,
      recommendations: recommendations.map((x) => x.id),
      alternatives: alternatives.map((x) => x.id),
    })
    this.recorder.event('decision/proposed', 'decision', r, {
      call: index,
      decision_version: proposal.decision_version,
      state_version: proposal.state_version,
      recommendations: recommendations.map((x) => x.id),
      alternatives: alternatives.map((x) => x.id),
      file: `decision/${roundFile(`propose-${index}`, r)}`,
    })
    this.save()
    const view = (x) => ({ id: x.id, rank: x.rank, mu: round4(x.mu), sigma: round4(x.sigma), score: round4(x.score) })
    return {
      round: r,
      max_rounds: this.state.task.max_rounds,
      batch_size: k,
      state_version: proposal.state_version,
      n_observations: proposal.n_observations,
      recommendations: recommendations.map(view),
      alternatives: alternatives.map(view),
    }
  }

  // ---- 提交选择 → oracle → 决策模块 ----

  validateSelection(args) {
    const r = this.state.round
    const rec = this.state.rounds[r]
    if (!rec || rec.proposals.length === 0) throw new RunError(`第 ${r} 轮还没有调用 pp_get_decision，先拿决策模块的推荐。`)
    const recs = rec.proposals[rec.proposals.length - 1].recommendations
    const accept = args.accept ?? []
    const replace = args.replace ?? []
    const problems = []
    const outs = replace.map((x) => x.out)
    const ins = replace.map((x) => x.in)
    for (const id of accept) if (!recs.includes(id)) problems.push(`accept 里的 ${id} 不在本轮推荐里`)
    for (const id of outs) if (!recs.includes(id)) problems.push(`replace.out 里的 ${id} 不在本轮推荐里`)
    const covered = [...accept, ...outs]
    for (const id of recs) {
      const n = covered.filter((x) => x === id).length
      if (n === 0) problems.push(`推荐 ${id} 既没有 accept 也没有被 replace`)
      if (n > 1) problems.push(`推荐 ${id} 出现了 ${n} 次`)
    }
    for (const x of replace) {
      if (!this.candidateSet.has(x.in)) problems.push(`replace.in 里的 ${x.in} 不是候选`)
      if (!REASON_TYPES.includes(x.reason_type)) problems.push(`reason_type 必须是 ${REASON_TYPES.join('/')} 之一`)
      if (typeof x.reason !== 'string' || x.reason.trim() === '') problems.push(`替换 ${x.out}→${x.in} 缺少理由`)
    }
    const batch = [...accept, ...ins]
    const dup = batch.filter((id, i) => batch.indexOf(id) !== i)
    if (dup.length) problems.push(`批次里有重复：${[...new Set(dup)].join(', ')}`)
    if (problems.length) throw new RunError(`选择不合法：\n- ${problems.join('\n- ')}`)
    return { accept, replace, batch, recommendations: recs }
  }

  async submitSelection(args, services, signal) {
    this.requireOpen()
    const r = this.state.round
    const selection = this.validateSelection(args)
    const rec = this.roundRecord(r)
    rec.submission = { at: new Date().toISOString(), ...selection }
    this.recorder.event('selection/submitted', 'model', r, {
      accept: selection.accept,
      replace: selection.replace,
      batch: selection.batch,
      forced: rec.steers > 0,
    })

    const run = await services.run({ round: r, batch: selection.batch }, signal)
    this.recorder.writeJson(join('oracle', roundFile('run', r)), run)
    rec.results = run.results
    for (const x of run.results) this.state.observations.push({ id: x.id, value: x.value, replicate: x.replicate, round: r })
    this.recorder.event('oracle/results', 'environment', r, { oracle_version: run.oracle_version, results: run.results })

    let failure = null
    try {
      const receipt = await services.observe({ round: r, observations: run.results.map((x) => ({ id: x.id, value: x.value })) }, signal)
      this.recorder.writeJson(join('decision', roundFile('observe', r)), receipt)
      rec.receipt = receipt
      this.recorder.event('decision/observed', 'decision', r, receipt)
      const accepted = new Set(receipt.accepted)
      const complete = selection.batch.every((id) => accepted.has(id)) && receipt.rejected.length === 0
      if (!complete || receipt.state_version_after !== receipt.state_version_before + 1) {
        failure = '决策模块的回执和提交的读数对不上'
        this.recorder.event('receipt/mismatch', 'framework', r, { batch: selection.batch, receipt })
      }
      const snapshot = await services.snapshot(signal)
      this.recorder.writeJson(join('decision', roundFile('snapshot', r)), snapshot)
    } catch (error) {
      failure = `决策模块没有收下本轮读数：${error.message}`
      this.recorder.event('decision/observe-failed', 'framework', r, { error: error.message })
    }

    const finished = r >= this.state.task.max_rounds
    if (finished) {
      this.state.status = 'finished'
      this.recorder.event('run/finished', 'framework', r, { rounds: r })
    } else {
      this.state.round = r + 1
    }
    if (failure && !finished) {
      this.state.status = 'paused'
      this.recorder.event('run/paused', 'framework', r, { reason: failure })
    }
    this.save()

    const recommended = new Set(selection.recommendations)
    return {
      round: r,
      results: run.results.map((x) => ({ id: x.id, value: round4(x.value), replicate: x.replicate, recommended: recommended.has(x.id) })),
      receipt: rec.receipt && {
        accepted: rec.receipt.accepted.length,
        rejected: rec.receipt.rejected,
        state_version_after: rec.receipt.state_version_after,
      },
      problem: failure,
      next: finished ? { finished: true } : { round: r + 1, max_rounds: this.state.task.max_rounds, status: this.state.status },
    }
  }

  // ---- 假设与笔记 ----

  checkCites(cites) {
    const measured = new Set(this.state.observations.map((o) => o.id))
    const unknown = cites.filter((id) => !measured.has(id))
    if (unknown.length) throw new RunError(`cites 只能引用已经测过的候选，这些还没测过：${unknown.join(', ')}`)
  }

  updateHypothesis(args) {
    this.requireOpen()
    const r = this.state.round
    const cites = args.cites ?? []
    this.checkCites(cites)
    if (!HYPOTHESIS_STATUSES.includes(args.status)) throw new RunError(`status 必须是 ${HYPOTHESIS_STATUSES.join('/')} 之一`)
    let h = args.id ? this.state.hypotheses.find((x) => x.id === args.id) : undefined
    if (args.id && !h) throw new RunError(`没有编号为 ${args.id} 的假设；新假设不要填 id`)
    if (!h) {
      if (!args.text) throw new RunError('新假设必须有 text')
      h = { id: `H${this.state.hypotheses.length + 1}`, text: args.text, status: args.status, cites: [], created_round: r, history: [] }
      this.state.hypotheses.push(h)
    }
    if (args.text) h.text = args.text
    h.status = args.status
    h.cites = [...new Set([...h.cites, ...cites])]
    h.updated_round = r
    h.history.push({ round: r, status: args.status, text: h.text, cites, rationale: args.rationale ?? null })
    this.state.citations.push({ ref: `${h.id}@${r}`, round: r, cites })
    this.recorder.event('hypothesis/updated', 'model', r, { id: h.id, status: h.status, text: h.text, cites, rationale: args.rationale ?? null })
    this.save()
    return { id: h.id, status: h.status, round: r }
  }

  writeNote(args) {
    this.requireOpen()
    const r = this.state.round
    const cites = args.cites ?? []
    this.checkCites(cites)
    if (!args.text) throw new RunError('笔记不能为空')
    const note = { id: `N${this.state.notes.length + 1}`, round: r, text: args.text, cites }
    this.state.notes.push(note)
    this.state.citations.push({ ref: `${note.id}@${r}`, round: r, cites })
    this.recorder.event('note/written', 'model', r, note)
    this.save()
    return { id: note.id, round: r }
  }

  ledger() {
    return {
      round: this.state.round,
      status: this.state.status,
      observations: this.state.observations.map((o) => ({ ...o, value: round4(o.value) })),
      hypotheses: this.state.hypotheses.map(({ history, ...h }) => h),
      notes: this.state.notes,
    }
  }

  // ---- 控制与回合驱动 ----

  control(action, by) {
    const r = this.state.round
    if (!CONTROL_ACTIONS.includes(action)) throw new RunError(`action 必须是 ${CONTROL_ACTIONS.join('/')} 之一`)
    this.requireOpen()
    if (action === 'pause') this.state.status = 'paused'
    if (action === 'resume') {
      this.state.status = 'active'
      // 暂停时还没交的那一轮要重新驱动一次。
      const rec = this.state.rounds[r]
      if (!rec?.submission) this.state.lastDrivenRound = Math.min(this.state.lastDrivenRound, r - 1)
    }
    if (action === 'stop') this.state.status = 'stopped'
    const type = { pause: 'run/paused', resume: 'run/resumed', stop: 'run/stopped' }[action]
    this.recorder.event(type, by, r, { reason: 'requested' })
    this.save()
    return { status: this.state.status, round: r }
  }

  /** 空闲时该自动开始的轮次；没有则返回 null。 */
  nextRoundToDrive() {
    const s = this.state
    if (s.status !== 'active' || s.round > s.task.max_rounds || s.lastDrivenRound >= s.round) return null
    return s.round
  }

  markDriven(r) {
    this.state.lastDrivenRound = r
    this.recorder.event('round/started', 'framework', r, {})
    this.save()
  }

  /** 由框架发起的这一轮快结束了但还没交选择：返回是否应当催一次。 */
  shouldSteer(drivenRound, maxSteers) {
    if (drivenRound !== this.state.round || this.state.status !== 'active') return false
    const rec = this.roundRecord(drivenRound)
    return !rec.submission && rec.steers < maxSteers
  }

  markSteered(r) {
    const rec = this.roundRecord(r)
    rec.steers += 1
    this.recorder.event('round/steered', 'framework', r, { steers: rec.steers })
    this.save()
  }

  /** 由框架发起的这一轮结束了还没交：暂停，等人来看。 */
  stallIfOpen(drivenRound) {
    if (drivenRound !== this.state.round || this.state.status !== 'active') return false
    if (this.state.rounds[drivenRound]?.submission) return false
    this.state.status = 'paused'
    this.recorder.event('round/stalled', 'framework', drivenRound, { steers: this.state.rounds[drivenRound]?.steers ?? 0 })
    this.recorder.event('run/paused', 'framework', drivenRound, { reason: 'round_not_submitted' })
    this.save()
    return true
  }

  recordHuman(text) {
    this.recorder.event('human/message', 'human', this.state.round, { text })
  }

  /** 一次 pp_run_python 跑完了（见 analysis.js）。分析跑的时候任务可能已经结束，所以这里不检查状态。 */
  recordAnalysis(entry) {
    this.recorder.event('analysis/executed', 'model', this.state.round, entry)
  }

  recordLlmCall(record, correlation) {
    this.recorder.llmCall({ round: this.state.round, ...correlation, ...record })
  }

  save() {
    this.recorder.writeJson('state.json', this.state)
    this.recorder.writeJson('memory.json', { hypotheses: this.state.hypotheses, notes: this.state.notes })
    this.recorder.writeJson('audit.json', auditRun(this.state))
  }

  // ---- 每轮注入给模型的简报 ----

  brief() {
    const s = this.state
    const lines = []
    lines.push('<perturbpilot_state>')
    lines.push(`任务：${s.task.title}（${s.task.task_id}${s.task.synthetic ? '，合成数据，不是真实实验' : ''}）`)
    lines.push(`目标：${s.task.objective.name}，${s.task.objective.direction === 'maximize' ? '越大越好' : '越小越好'}；每轮 ${s.task.batch_size} 个，共 ${s.task.max_rounds} 轮`)
    const statusText = { active: '进行中', paused: '已暂停（不会自动开始下一轮）', stopped: '已停止', finished: '已完成' }[s.status]
    lines.push(`状态：${statusText}`)
    if (!this.closed) {
      const rec = s.rounds[s.round]
      const step = !rec || rec.proposals.length === 0 ? '还没调用 pp_get_decision' : rec.submission ? '已提交' : '已拿到推荐，还没提交 pp_submit_selection'
      lines.push(`当前第 ${s.round}/${s.task.max_rounds} 轮：${step}`)
    }
    const obs = [...s.observations].sort((a, b) => b.value - a.value)
    lines.push(`已测 ${obs.length} 次读数${obs.length ? '，按读数从高到低（前 15）：' : ''}`)
    for (const o of obs.slice(0, 15)) lines.push(`  ${o.id} = ${round4(o.value)}（第 ${o.round} 轮${o.replicate ? `，第 ${o.replicate + 1} 次测` : ''}）`)
    const last = s.rounds[s.round - 1]
    if (last?.results) lines.push(`上一轮（第 ${s.round - 1} 轮）读数：${last.results.map((x) => `${x.id}=${round4(x.value)}`).join('，')}`)
    if (s.hypotheses.length) {
      lines.push('假设：')
      for (const h of s.hypotheses) lines.push(`  ${h.id} [${h.status}] ${h.text}（引用 ${h.cites.join(', ') || '无'}）`)
    }
    if (s.notes.length) {
      lines.push('最近笔记：')
      for (const n of s.notes.slice(-3)) lines.push(`  ${n.id}（第 ${n.round} 轮）${n.text}`)
    }
    lines.push('</perturbpilot_state>')
    return lines.join('\n')
  }
}

function round4(x) {
  return Math.round(x * 1e4) / 1e4
}
