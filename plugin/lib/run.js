// 一次任务（run）的科学状态：轮次、决策模块的推荐、agent 的选择、读数、假设、笔记和检索记录。
// 这里不依赖 DSH，工具和回合驱动都只是调用这里的方法；状态每次变动都落盘到 runs/<run_id>/。
// 任务的形态（做什么扰动、读数有哪些字段、目标是什么、能不能重复测）都来自任务卡片，这里不写死。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditRun, checkReceipt } from './audit.js'
import { RunRecorder, roundFile } from './records.js'
import { lowerIsBetter, objectiveText, objectiveValue, readCandidateIds } from './task.js'

/** 一组候选被选进来的依据。decision = 照决策模块的推荐。 */
export const SOURCES = ['decision', 'prior_knowledge', 'literature', 'analysis', 'hypothesis_test', 'exploration', 'data_quality']
export const HYPOTHESIS_STATUSES = ['proposed', 'supported', 'weakened', 'rejected']
export const CONTROL_ACTIONS = ['pause', 'resume', 'stop']
export const RETRIEVAL_TOOLS = ['web_search', 'web_fetch']
export const STATE_FORMAT = 2
const ALTERNATIVES = 8

export class RunError extends Error {}

export class Run {
  static exists(dir) {
    return existsSync(join(dir, 'state.json'))
  }

  /** 早期版本（读数只有一个 value、按 accept/replace 提交）留下的记录：只列出，不再打开。 */
  static isLegacy(dir) {
    try {
      return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).format !== STATE_FORMAT
    } catch {
      return false
    }
  }

  static load(dir, runId) {
    const recorder = new RunRecorder(dir, runId)
    const state = recorder.readJson('state.json')
    if (state.format !== STATE_FORMAT) throw new RunError('这个会话里是旧格式的任务记录，不能继续；新开一个会话再开始任务。')
    return new Run(recorder, state)
  }

  static async start({ dir, runId, services, signal }) {
    const card = await services.task(signal)
    const manifest = await services.manifest(signal)
    const cards = card.data_cards ?? []
    const missing = (manifest.inputs?.required ?? []).filter((need) => !cards.some((dc) => dc.role === need.role && dc.modality === need.modality))
    if (missing.length) {
      throw new RunError(`决策模块 ${manifest.name} 需要的输入任务包里没有：${missing.map((x) => `${x.role}/${x.modality}`).join(', ')}`)
    }
    // /init 把任务包交给决策模块并清空它的观测；oracle 清空重复测量计数。
    const init = await services.init({ task: card, package_dir: card.package_dir }, signal)
    await services.resetOracle({}, signal)
    const candidateIds = readCandidateIds(card.package_dir)
    if (candidateIds.length !== card.n_candidates) throw new RunError('任务包的 candidates.csv 和 oracle 报的候选数对不上')

    const recorder = new RunRecorder(dir, runId)
    recorder.writeJson('task.json', card)
    const state = {
      format: STATE_FORMAT,
      runId,
      task: card,
      candidateIds,
      decision: { name: manifest.name, version: init.decision_version, method: init.method, inputs_used: init.inputs_used },
      status: 'active',
      round: 1,
      lastDrivenRound: 0,
      rounds: {},
      observations: [],
      hypotheses: [],
      notes: [],
      citations: [],
      retrievals: [],
    }
    const run = new Run(recorder, state)
    recorder.event('run/started', 'framework', 1, {
      task_id: card.task_id,
      synthetic: card.synthetic,
      action: card.action.type,
      objective: card.objective,
      budget: card.budget,
      n_candidates: card.n_candidates,
      decision_version: init.decision_version,
      method: init.method,
      inputs_used: init.inputs_used,
    })
    run.save()
    return run
  }

  constructor(recorder, state) {
    this.recorder = recorder
    this.state = state
    this.candidateSet = new Set(state.candidateIds)
  }

  get budget() {
    return this.state.task.budget
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

  measuredIds() {
    return new Set(this.state.observations.map((o) => o.id))
  }

  /** 本轮必须交几个：正好 batch_size；不许重复测时，未测的候选不够了就是剩下的全部。 */
  expectedBatchSize() {
    const k = this.budget.batch_size
    if (this.budget.allow_repeats) return k
    return Math.min(k, this.state.candidateIds.length - this.measuredIds().size)
  }

  /** 最近一次推荐的原始文件（相对运行目录，用 /），分析工作区导出 decision.csv 用。 */
  latestProposalFile() {
    for (let r = this.state.round; r >= 1; r--) {
      const file = this.state.rounds[r]?.proposals.at(-1)?.file
      if (file) return file
    }
    return null
  }

  // ---- 决策模块 ----

  async getDecision(services, signal) {
    this.requireOpen()
    const r = this.state.round
    const k = this.expectedBatchSize()
    const proposal = await services.propose({ round: r, k: k + ALTERNATIVES }, signal)
    const rec = this.roundRecord(r)
    const index = rec.proposals.length + 1
    const name = roundFile(`propose-${index}`, r)
    this.recorder.writeJson(join('decision', name), proposal)
    const recommendations = proposal.recommendations.slice(0, k)
    const alternatives = proposal.recommendations.slice(k)
    rec.proposals.push({
      at: new Date().toISOString(),
      method: proposal.method,
      state_version: proposal.state_version,
      n_observations: proposal.n_observations,
      recommendations: recommendations.map((x) => x.id),
      alternatives: alternatives.map((x) => x.id),
      file: `decision/${name}`,
    })
    this.recorder.event('decision/proposed', 'decision', r, {
      call: index,
      decision_version: proposal.decision_version,
      method: proposal.method,
      state_version: proposal.state_version,
      recommendations: recommendations.map((x) => x.id),
      alternatives: alternatives.map((x) => x.id),
      file: `decision/${name}`,
    })
    this.save()
    return {
      round: r,
      rounds: this.budget.rounds,
      batch_size: k,
      method: proposal.method,
      decision_version: proposal.decision_version,
      inputs_used: proposal.inputs_used,
      params: proposal.params,
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
    const recs = rec.proposals.at(-1).recommendations
    const recSet = new Set(recs)
    const batch = Array.isArray(args.batch) ? args.batch : []
    const groups = Array.isArray(args.groups) ? args.groups : []
    const problems = []

    const expected = this.expectedBatchSize()
    if (batch.length !== expected) problems.push(`这一轮要正好交 ${expected} 个候选，交了 ${batch.length} 个`)
    for (const id of batch) if (!this.candidateSet.has(id)) problems.push(`${id} 不是候选`)
    const dup = batch.filter((id, i) => batch.indexOf(id) !== i)
    if (dup.length) problems.push(`批次里有重复：${[...new Set(dup)].join(', ')}`)
    if (!this.budget.allow_repeats) {
      const measured = this.measuredIds()
      const again = batch.filter((id) => measured.has(id))
      if (again.length) problems.push(`这个任务不能重复测，这些已经测过：${again.join(', ')}`)
    }

    const inBatch = new Set(batch)
    const grouped = new Map() // id -> 所在组的 source
    for (const [i, g] of groups.entries()) {
      const label = `groups[${i}]`
      if (!SOURCES.includes(g?.source)) problems.push(`${label}.source 必须是 ${SOURCES.join('/')} 之一`)
      if (typeof g?.reason !== 'string' || g.reason.trim() === '') problems.push(`${label} 缺少理由`)
      const ids = Array.isArray(g?.ids) ? g.ids : []
      if (ids.length === 0) problems.push(`${label}.ids 不能为空`)
      for (const id of ids) {
        if (!inBatch.has(id)) problems.push(`${label} 里的 ${id} 不在 batch 里`)
        else if (grouped.has(id)) problems.push(`${id} 出现在不止一个组里`)
        else grouped.set(id, g.source)
      }
    }
    // 推荐以外的候选必须写明为什么选它。
    for (const id of new Set(batch)) {
      if (recSet.has(id) || !this.candidateSet.has(id)) continue
      const source = grouped.get(id)
      if (source === undefined) problems.push(`${id} 不在本轮推荐里，要放进一个写了理由的组`)
      else if (source === 'decision') problems.push(`${id} 不在本轮推荐里，它所在组的 source 不能是 decision`)
    }
    if (problems.length) throw new RunError(`选择不合法：\n- ${problems.join('\n- ')}`)

    const bySource = {}
    for (const id of batch) {
      const source = grouped.get(id) ?? 'decision'
      bySource[source] = (bySource[source] ?? 0) + 1
    }
    const outside = batch.filter((id) => !recSet.has(id))
    return {
      batch,
      groups: groups.map((g) => ({ ids: g.ids, source: g.source, reason: g.reason })),
      recommendations: recs,
      from_recommendation: batch.length - outside.length,
      outside,
      by_source: bySource,
    }
  }

  async submitSelection(args, services, signal) {
    this.requireOpen()
    const r = this.state.round
    const selection = this.validateSelection(args)
    const rec = this.roundRecord(r)
    rec.submission = { at: new Date().toISOString(), ...selection }
    this.recorder.event('selection/submitted', 'model', r, {
      batch: selection.batch,
      groups: selection.groups,
      from_recommendation: selection.from_recommendation,
      outside: selection.outside,
      forced: rec.steers > 0,
    })

    const run = await services.run({ round: r, batch: selection.batch }, signal)
    this.recorder.writeJson(join('oracle', roundFile('run', r)), run)
    rec.results = run.results
    for (const x of run.results) this.state.observations.push({ id: x.id, round: r, replicate: x.replicate, readout: x.readout })
    this.recorder.event('oracle/results', 'environment', r, { oracle_version: run.oracle_version, results: run.results })

    const objective = this.state.task.objective
    let failure = null
    try {
      const receipt = await services.observe({ round: r, observations: run.results.map((x) => ({ id: x.id, readout: x.readout })) }, signal)
      this.recorder.writeJson(join('decision', roundFile('observe', r)), receipt)
      rec.receipt = receipt
      this.recorder.event('decision/observed', 'decision', r, receipt)
      if (!checkReceipt(run.results, receipt, objective).ok) {
        failure = '决策模块的回执和提交的读数对不上'
        this.recorder.event('receipt/mismatch', 'framework', r, { batch: selection.batch, receipt })
      }
      const snapshot = await services.snapshot(signal)
      this.recorder.writeJson(join('decision', roundFile('snapshot', r)), snapshot)
    } catch (error) {
      failure = `决策模块没有收下本轮读数：${error.message}`
      this.recorder.event('decision/observe-failed', 'framework', r, { error: error.message })
    }

    const exhausted = !this.budget.allow_repeats && this.measuredIds().size >= this.state.candidateIds.length
    const finished = r >= this.budget.rounds || exhausted
    if (finished) {
      this.state.status = 'finished'
      this.recorder.event('run/finished', 'framework', r, { rounds: r, ...(exhausted && r < this.budget.rounds ? { reason: 'candidates_exhausted' } : {}) })
    } else {
      this.state.round = r + 1
    }
    if (failure && !finished) {
      this.state.status = 'paused'
      this.recorder.event('run/paused', 'framework', r, { reason: failure })
    }
    this.save()

    const recommended = new Set(selection.recommendations)
    const empty = run.results.filter((x) => objectiveValue(x.readout, objective) === null).map((x) => x.id)
    return {
      round: r,
      results: run.results.map((x) => ({ id: x.id, replicate: x.replicate, readout: roundReadout(x.readout), recommended: recommended.has(x.id) })),
      empty,
      receipt: rec.receipt && {
        accepted: rec.receipt.accepted.length,
        rejected: rec.receipt.rejected,
        state_version_after: rec.receipt.state_version_after,
      },
      problem: failure,
      next: finished ? { finished: true } : { round: r + 1, rounds: this.budget.rounds, status: this.state.status },
    }
  }

  // ---- 检索记录（web_search / web_fetch 由 DSH 执行，这里只记下来，不拦截） ----

  /**
   * 记一次检索。call 是会话里 tool/call 的 {name, arguments}，result 是 tool/result 的
   * {message: {isError, content}, meta}。原文落到 retrieval/R<N>.json，事件和状态里只放摘要。
   * 任务结束后查的也记（事后审计要看得到），所以不检查状态。
   */
  recordRetrieval(call, result) {
    this.state.retrievals ??= []
    const id = `R${this.state.retrievals.length + 1}`
    const r = this.state.round
    const text = (result.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    const isError = Boolean(result.message?.isError)
    const file = `retrieval/${id}.json`
    this.recorder.writeJson(join('retrieval', `${id}.json`), {
      id,
      round: r,
      tool: call.name,
      arguments: call.arguments ?? null,
      is_error: isError,
      meta: result.meta ?? null,
      text,
    })
    const entry = { id, round: r, at: new Date().toISOString(), tool: call.name, is_error: isError }
    this.state.retrievals.push(entry)
    if (call.name === 'web_search') {
      const queries = call.arguments?.queries ?? (call.arguments?.query ? [call.arguments.query] : [])
      const results = (result.meta?.sources ?? []).map((x) => ({ title: x.title ?? null, url: x.url }))
      this.recorder.event('retrieval/searched', 'model', r, { id, queries, results, is_error: isError, file })
    } else {
      const url = call.arguments?.url ?? result.meta?.url ?? null
      this.recorder.event('retrieval/fetched', 'model', r, { id, url, status: result.meta?.statusCode ?? null, chars: text.length, is_error: isError, file })
    }
    this.save()
    return entry
  }

  // ---- 假设与笔记 ----

  checkCites(cites) {
    const measured = this.measuredIds()
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
      objective: this.state.task.objective,
      observations: this.state.observations.map((o) => ({ ...o, readout: roundReadout(o.readout) })),
      hypotheses: this.state.hypotheses.map(({ history, ...h }) => h),
      notes: this.state.notes,
      retrievals: this.state.retrievals ?? [],
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
    if (s.status !== 'active' || s.round > s.task.budget.rounds || s.lastDrivenRound >= s.round) return null
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
    const t = s.task
    const b = t.budget
    const objective = t.objective
    const lines = []
    lines.push('<perturbpilot_state>')
    lines.push(`任务：${t.title}（${t.task_id}${t.synthetic ? '，合成数据，不是真实实验' : ''}）`)
    lines.push(`扰动：${t.action.type}${t.action.description ? `，${t.action.description}` : ''}`)
    lines.push(`目标：${objectiveText(objective)}`)
    lines.push(`读数字段：${t.readout.fields.map((f) => `${f.name}（${f.description ?? ''}）`).join('；')}`)
    lines.push(`预算：共 ${b.rounds} 轮，每轮正好 ${b.batch_size} 个；候选 ${t.n_candidates} 个，${b.allow_repeats ? '可以重复测' : '不能重复测'}`)
    const used = s.decision.inputs_used ?? []
    lines.push(`决策模块：${s.decision.name}，方法 ${s.decision.method}，${used.length ? `用到 ${used.map((x) => `${x.role}/${x.modality}`).join(', ')}` : '没用任何候选特征'}`)
    const statusText = { active: '进行中', paused: '已暂停（不会自动开始下一轮）', stopped: '已停止', finished: '已完成' }[s.status]
    lines.push(`状态：${statusText}`)
    if (!this.closed) {
      const rec = s.rounds[s.round]
      const step = !rec || rec.proposals.length === 0 ? '还没调用 pp_get_decision' : rec.submission ? '已提交' : '已拿到推荐，还没提交 pp_submit_selection'
      lines.push(`当前第 ${s.round}/${b.rounds} 轮：${step}`)
    }
    const sign = lowerIsBetter(objective) ? 1 : -1
    const valued = s.observations.map((o) => ({ ...o, v: objectiveValue(o.readout, objective) })).filter((o) => o.v !== null)
    valued.sort((x, y) => sign * (x.v - y.v))
    const empties = s.observations.length - valued.length
    lines.push(`已测 ${s.observations.length} 次${empties ? `（其中 ${empties} 次读数为空）` : ''}${valued.length ? `，${objective.field} 最好的前 10：` : ''}`)
    for (const o of valued.slice(0, 10)) lines.push(`  ${o.id} ${objective.field}=${round4(o.v)}（第 ${o.round} 轮${o.replicate ? `，第 ${o.replicate + 1} 次测` : ''}）`)
    const last = s.rounds[s.round - 1]
    if (last?.results) {
      const got = last.results.map((x) => ({ id: x.id, v: objectiveValue(x.readout, objective) }))
      const ok = got.filter((x) => x.v !== null).sort((x, y) => sign * (x.v - y.v))
      const none = got.length - ok.length
      lines.push(`上一轮（第 ${s.round - 1} 轮）测了 ${got.length} 个${ok.length ? `，最好的：${ok.slice(0, 5).map((x) => `${x.id}=${round4(x.v)}`).join('，')}` : ''}${none ? `；${none} 个读数为空` : ''}`)
    }
    if (s.hypotheses.length) {
      lines.push('假设：')
      for (const h of s.hypotheses) lines.push(`  ${h.id} [${h.status}] ${h.text}（引用 ${h.cites.join(', ') || '无'}）`)
    }
    if (s.notes.length) {
      lines.push('最近笔记：')
      for (const n of s.notes.slice(-3)) lines.push(`  ${n.id}（第 ${n.round} 轮）${n.text}`)
    }
    lines.push('全部读数用 pp_get_ledger 取；要算统计、看任务包里的数据用 pp_run_python。')
    lines.push('</perturbpilot_state>')
    return lines.join('\n')
  }
}

/** 推荐里给模型看的一项：id、rank，加上决策模块给的数值（方法不同，字段不同），保留 4 位小数。 */
function view(x) {
  const out = { id: x.id, rank: x.rank }
  for (const [k, v] of Object.entries(x)) if (k !== 'id' && k !== 'rank' && typeof v === 'number') out[k] = round4(v)
  return out
}

/** 读数里的数值保留 4 位小数；空读数原样返回 null。 */
export function roundReadout(readout) {
  if (!readout) return null
  return Object.fromEntries(Object.entries(readout).map(([k, v]) => [k, typeof v === 'number' ? round4(v) : v]))
}

export function round4(x) {
  return Math.round(x * 1e4) / 1e4
}
