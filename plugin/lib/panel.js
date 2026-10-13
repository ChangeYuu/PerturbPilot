// 浏览器面板的宿主侧：把一次任务的状态整理成面板要显示的视图，并挂一个 HTTP 路由给面板读和控制。
// 路由挂在 DSH 自己的 web 服务上（同源），只读 runs/ 里已有的状态，写操作只有开始任务和暂停 / 继续 / 结束。
// 开始任务前，面板列出服务里所有的任务包让用户选；agent 用 pp_propose_task 提过设置的，面板上预先填好等用户确认。
// 右侧栏按当前会话读一个任务；主区的科学台账页不绑会话，先列出 runs/ 下所有任务再选。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROL_ACTIONS, RunError, STATE_FORMAT, roundReadout, round4 } from './run.js'
import { ServiceError } from './services.js'
import { lowerIsBetter, objectiveText, objectiveValue } from './task.js'

export const PANEL_ROUTE = '/perturbpilot/api'
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/
const MAX_BODY = 4096

/** 面板路由要按指定状态码回的错误（比如会话不存在回 404）。 */
export class PanelError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** 开始任务前给面板和 agent 预览的任务卡片：去掉服务本机的路径。 */
export function taskPreview(card) {
  const { package_dir, ...rest } = card
  return { ...rest, objective_text: objectiveText(card.objective), goal: lowerIsBetter(card.objective) ? 'low' : 'high' }
}
// 左上角和新会话中间的 logo，由 client.js 的品牌插槽显示。
export const LOGO_PATH = fileURLToPath(new URL('../assets/logo.png', import.meta.url))

/**
 * 面板显示用的视图：状态、每轮的推荐 / 选择 / 读数 / 审计、读数排名、假设（含历次更新）、笔记、分析、检索、最近的事件。
 * 每条读数带 value（目标字段的值，空读数为 null）和完整的 readout。
 */
export function panelView(run, { events = 40 } = {}) {
  const s = run.state
  const audit = run.audit()
  const all = readEvents(run.recorder.dir)
  const auditByRound = new Map(audit.rounds.map((x) => [x.round, x.checks]))
  const objective = s.task.objective
  const reading = (x) => ({ id: x.id, round: x.round, replicate: x.replicate, value: nullableRound(objectiveValue(x.readout, objective)), readout: roundReadout(x.readout) })
  const rounds = []
  for (let r = 1; r <= Math.min(s.round, s.task.budget.rounds); r++) {
    const rec = s.rounds[r]
    const last = rec?.proposals.at(-1)
    rounds.push({
      round: r,
      proposals: rec?.proposals.length ?? 0,
      recommendations: last?.recommendations ?? [],
      steers: rec?.steers ?? 0,
      method: last?.method ?? null,
      submission: rec?.submission ? {
        batch: rec.submission.batch,
        groups: rec.submission.groups,
        outside: rec.submission.outside,
        from_recommendation: rec.submission.from_recommendation,
      } : null,
      results: rec?.results?.map((x) => { const { round, ...rest } = reading(x); return rest }) ?? null,
      receipt: rec?.receipt ? {
        accepted: rec.receipt.accepted.length,
        rejected: rec.receipt.rejected.length,
        state_version_before: rec.receipt.state_version_before,
        state_version_after: rec.receipt.state_version_after,
      } : null,
      checks: auditByRound.get(r) ?? {},
    })
  }
  const sign = lowerIsBetter(objective) ? 1 : -1
  // 空读数排在最后。
  const observations = s.observations.map(reading).sort((a, b) => (a.value === null) - (b.value === null) || sign * (a.value - b.value))
  return {
    run_id: s.runId,
    task: {
      task_id: s.task.task_id,
      title: s.task.title,
      synthetic: s.task.synthetic,
      action: s.task.action,
      objective,
      objective_text: objectiveText(objective),
      goal: lowerIsBetter(objective) ? 'low' : 'high',
      readout_fields: s.task.readout.fields.map((f) => f.name),
      budget: s.task.budget,
      n_candidates: s.task.n_candidates,
    },
    decision: s.decision,
    status: s.status,
    round: s.round,
    audit_counts: audit.counts,
    controls: run.closed ? [] : s.status === 'paused' ? ['resume', 'stop'] : ['pause', 'stop'],
    execution: executionView(all, s),
    rounds,
    observations,
    hypotheses: s.hypotheses.map((h) => ({ ...h, history: h.history ?? [], updates: h.history?.length ?? 0 })),
    notes: s.notes,
    analyses: all.filter((e) => e.type === 'analysis/executed').map((e) => ({ round: e.round, ts: e.ts, ...e.data })),
    retrievals: retrievalView(all),
    events: all.slice(-events).map(({ seq, ts, round, type, source }) => ({ seq, ts, round, type, source })),
  }
}

const EXECUTION_TEXT = {
  'run/started': '任务已启动',
  'round/started': '开始新一轮',
  'decision/proposed': '决策模块已给出推荐',
  'analysis/executed': 'Python 分析完成',
  'retrieval/started': '正在检索文献',
  'retrieval/searched': '文献搜索完成',
  'retrieval/fetched': '网页读取完成',
  'retrieval/aborted': '文献检索中断',
  'selection/submitted': '已提交候选，等待读数',
  'oracle/results': 'oracle 已返回读数',
  'decision/observed': '决策模块已收到读数',
  'decision/observe-failed': '决策模块接收失败',
  'hypothesis/updated': '假设已更新',
  'note/written': '笔记已写入',
  'run/finished': '任务已完成',
  'run/paused': '任务已暂停',
}

function executionDetail(event) {
  const d = event.data ?? {}
  if (event.type === 'analysis/executed') return `${d.id ?? '分析'}：${d.exit_code === 0 && !d.timed_out ? '成功' : d.timed_out ? '超时' : '失败'}`
  if (event.type === 'retrieval/started') return d.tool === 'web_fetch' ? `读取 ${d.url ?? ''}` : `搜索 ${(d.queries ?? []).join('；')}`
  if (event.type === 'retrieval/searched') return `${(d.queries ?? []).join('；')} · ${(d.results ?? []).length} 条结果${d.is_error ? ' · 出错' : ''}`
  if (event.type === 'retrieval/fetched') return `${d.url ?? ''}${d.status ? ` · HTTP ${d.status}` : ''}${d.is_error ? ' · 出错' : ''}`
  if (event.type === 'retrieval/aborted') return d.reason ?? '调用中断'
  if (event.type === 'selection/submitted') return `${(d.batch ?? []).length} 个候选`
  if (event.type === 'oracle/results') return `${(d.results ?? []).length} 个读数`
  if (event.type === 'decision/observed') return `接受 ${d.accepted?.length ?? 0} 个`
  if (event.type === 'decision/observe-failed') return d.error ?? '服务不可用'
  if (event.type === 'run/paused') return d.reason ?? '等待继续'
  return ''
}

function executionView(events, state) {
  const relevant = events.filter((e) => EXECUTION_TEXT[e.type])
  const latest = relevant.at(-1)
  const total = state.task.budget.rounds
  const round = Math.min(state.round, total)
  const steps = relevant.slice(-12).map((e) => ({
    ts: e.ts,
    round: e.round,
    type: e.type,
    source: e.source,
    label: EXECUTION_TEXT[e.type],
    detail: executionDetail(e),
  }))
  return {
    status: state.status,
    round,
    rounds: total,
    label: state.status === 'finished' ? '任务已完成' : state.status === 'paused' ? '任务已暂停' : latest ? EXECUTION_TEXT[latest.type] : '等待执行事件',
    detail: latest ? executionDetail(latest) : '',
    updated_at: latest?.ts ?? null,
    steps,
  }
}

function retrievalView(events) {
  const byId = new Map()
  for (const event of events) {
    if (!event.type.startsWith('retrieval/')) continue
    const id = event.data?.id
    if (!id) continue
    const previous = byId.get(id) ?? { round: event.round, ts: event.ts, id }
    if (event.type === 'retrieval/started') {
      byId.set(id, { ...previous, ...event.data, round: event.round, ts: event.ts, status: 'started', tool: event.data.tool })
    } else if (event.type === 'retrieval/searched' || event.type === 'retrieval/fetched') {
      byId.set(id, {
        ...previous,
        ...event.data,
        round: event.round,
        ts: event.ts,
        status: event.data.is_error ? 'completed_error' : 'completed',
        tool: event.type === 'retrieval/searched' ? 'web_search' : 'web_fetch',
      })
    } else if (event.type === 'retrieval/aborted') {
      byId.set(id, { ...previous, ...event.data, round: event.round, ts: event.ts, status: 'aborted', is_error: true })
    }
  }
  return [...byId.values()]
}

function readEvents(dir) {
  const path = join(dir, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** runs/ 下所有任务的摘要，最近更新的在前。读不了的目录跳过；早期版本的记录标 legacy，面板只列不展开。 */
export function listRuns(runsDir) {
  if (!existsSync(runsDir)) return []
  const out = []
  for (const id of readdirSync(runsDir)) {
    if (!SESSION_ID.test(id)) continue
    const path = join(runsDir, id, 'state.json')
    try {
      const s = JSON.parse(readFileSync(path, 'utf8'))
      const legacy = s.format !== STATE_FORMAT
      out.push({
        run_id: id,
        title: s.task?.title ?? id,
        task_id: s.task?.task_id ?? null,
        synthetic: s.task?.synthetic ?? null,
        status: s.status,
        round: s.round,
        max_rounds: (legacy ? s.task?.max_rounds : s.task?.budget?.rounds) ?? null,
        ...(legacy ? { legacy: true } : {}),
        updated: statSync(path).mtime.toISOString(),
      })
    } catch {}
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated))
}

/**
 * 面板路由的处理函数。
 *   GET  <PANEL_ROUTE>/sessions                    → { runs: 摘要列表 }（科学台账页用）
 *   GET  <PANEL_ROUTE>/sessions/<会话 id>          → { run: 视图 | null, proposal: agent 提的设置 | null }
 *   POST <PANEL_ROUTE>/sessions/<会话 id>/start    body { task_id?, method?, rounds?, batch_size? } → { run: 视图 }
 *                                                  （开始任务，第 1 轮随后由框架开；省略的项用默认）
 *   POST <PANEL_ROUTE>/sessions/<会话 id>/control  body { action } → { run: 视图 }
 *   GET  <PANEL_ROUTE>/tasks                       → { tasks: 任务卡片预览列表, active, decision: 方法和各自需要的输入, limits }
 *   GET  <PANEL_ROUTE>/status                      → 插件配置和服务是否连得上（设置页用）
 *   GET  <PANEL_ROUTE>/logo                        → assets/logo.png
 * POST 要求 content-type 为 application/json 且带 x-perturbpilot 头，别的网页没法跨站伪造（会触发预检，这里不答预检）。
 * @param deps.getRun - (sessionId) => Run | undefined
 * @param deps.control - (sessionId, action) => void，执行控制并在需要时推动回合
 * @param deps.start - async (sessionId, setup) => void，开始任务并推动第 1 轮；会话不存在抛 PanelError(404)
 * @param deps.proposal - (sessionId) => 等用户确认的设置 | null
 * @param deps.tasks - async () => 任务列表和决策模块的方法
 * @param deps.listRuns - () => 摘要列表
 * @param deps.status - async () => 状态对象
 */
export function createPanelHandler({ getRun, control, start, proposal = () => null, tasks, listRuns = () => [], status = async () => ({}), logger }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const rest = url.pathname.slice(PANEL_ROUTE.length).split('/').filter(Boolean)
      if (rest.length === 1 && rest[0] === 'logo') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' })
        return res.end(readFileSync(LOGO_PATH))
      }
      if (rest.length === 1 && (rest[0] === 'sessions' || rest[0] === 'status' || rest[0] === 'tasks')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        if (rest[0] === 'tasks') return send(res, 200, await tasks())
        return send(res, 200, rest[0] === 'sessions' ? { runs: listRuns() } : await status())
      }
      if (rest[0] !== 'sessions' || !SESSION_ID.test(rest[1] ?? '') || rest.length > 3) return send(res, 404, { error: 'not found' })
      const sessionId = rest[1]
      if (rest.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        const run = getRun(sessionId)
        return send(res, 200, { run: run ? panelView(run) : null, proposal: run ? null : proposal(sessionId) })
      }
      if (rest[2] !== 'control' && rest[2] !== 'start') return send(res, 404, { error: 'not found' })
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || req.headers['x-perturbpilot'] !== '1') {
        return send(res, 403, { error: 'forbidden' })
      }
      const body = JSON.parse(await readBody(req))
      if (rest[2] === 'start') {
        if (getRun(sessionId)) return send(res, 400, { error: '这个会话已经开始过任务' })
        const { task_id, method, rounds, batch_size } = body ?? {}
        await start(sessionId, { task_id, method, rounds, batch_size })
        return send(res, 200, { run: panelView(getRun(sessionId)) })
      }
      if (!CONTROL_ACTIONS.includes(body?.action)) return send(res, 400, { error: `action 必须是 ${CONTROL_ACTIONS.join('/')} 之一` })
      const run = getRun(sessionId)
      if (!run) return send(res, 404, { error: '这个会话还没有开始任务' })
      control(sessionId, body.action)
      return send(res, 200, { run: panelView(run) })
    } catch (error) {
      if (error instanceof PanelError) return send(res, error.status, { error: error.message })
      if (error instanceof ServiceError) return send(res, 502, { error: error.message })
      if (error instanceof RunError || error instanceof SyntaxError) return send(res, 400, { error: error.message })
      logger?.warn(`perturbpilot: panel request failed: ${error?.message ?? error}`)
      return send(res, 500, { error: 'internal error' })
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        reject(new RunError('请求体太大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function nullableRound(x) {
  return x === null ? null : round4(x)
}
