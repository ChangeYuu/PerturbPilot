// 浏览器面板的宿主侧：把一次任务的状态整理成面板要显示的视图，并挂一个 HTTP 路由给面板读和控制。
// 路由挂在 DSH 自己的 web 服务上（同源），只读 runs/ 里已有的状态，写操作只有暂停 / 继续 / 结束。
// 右侧栏按当前会话读一个任务；主区的科学台账页不绑会话，先列出 runs/ 下所有任务再选。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditRun } from './audit.js'
import { CONTROL_ACTIONS, RunError, STATE_FORMAT, roundReadout, round4 } from './run.js'
import { lowerIsBetter, objectiveText, objectiveValue } from './task.js'

export const PANEL_ROUTE = '/perturbpilot/api'
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/
const MAX_BODY = 4096
// 左上角和新会话中间的 logo，由 client.js 的品牌插槽显示。
export const LOGO_PATH = fileURLToPath(new URL('../assets/logo.png', import.meta.url))

/**
 * 面板显示用的视图：状态、每轮的推荐 / 选择 / 读数 / 审计、读数排名、假设（含历次更新）、笔记、分析、检索、最近的事件。
 * 每条读数带 value（目标字段的值，空读数为 null）和完整的 readout。
 */
export function panelView(run, { events = 40 } = {}) {
  const s = run.state
  const audit = auditRun(s)
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
    rounds,
    observations,
    hypotheses: s.hypotheses.map((h) => ({ ...h, history: h.history ?? [], updates: h.history?.length ?? 0 })),
    notes: s.notes,
    analyses: all.filter((e) => e.type === 'analysis/executed').map((e) => ({ round: e.round, ts: e.ts, ...e.data })),
    retrievals: all
      .filter((e) => e.type === 'retrieval/searched' || e.type === 'retrieval/fetched')
      .map((e) => ({ round: e.round, ts: e.ts, tool: e.type === 'retrieval/searched' ? 'web_search' : 'web_fetch', ...e.data })),
    events: all.slice(-events).map(({ seq, ts, round, type, source }) => ({ seq, ts, round, type, source })),
  }
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
 *   GET  <PANEL_ROUTE>/sessions/<会话 id>          → { run: 视图 | null }
 *   POST <PANEL_ROUTE>/sessions/<会话 id>/control  body { action } → { run: 视图 }
 *   GET  <PANEL_ROUTE>/status                      → 插件配置和服务是否连得上（设置页用）
 *   GET  <PANEL_ROUTE>/logo                        → assets/logo.png
 * POST 要求 content-type 为 application/json 且带 x-perturbpilot 头，别的网页没法跨站伪造（会触发预检，这里不答预检）。
 * @param deps.getRun - (sessionId) => Run | undefined
 * @param deps.control - (sessionId, action) => void，执行控制并在需要时推动回合
 * @param deps.listRuns - () => 摘要列表
 * @param deps.status - async () => 状态对象
 */
export function createPanelHandler({ getRun, control, listRuns = () => [], status = async () => ({}), logger }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const rest = url.pathname.slice(PANEL_ROUTE.length).split('/').filter(Boolean)
      if (rest.length === 1 && rest[0] === 'logo') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' })
        return res.end(readFileSync(LOGO_PATH))
      }
      if (rest.length === 1 && (rest[0] === 'sessions' || rest[0] === 'status')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        return send(res, 200, rest[0] === 'sessions' ? { runs: listRuns() } : await status())
      }
      if (rest[0] !== 'sessions' || !SESSION_ID.test(rest[1] ?? '') || rest.length > 3) return send(res, 404, { error: 'not found' })
      const sessionId = rest[1]
      if (rest.length === 2) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        const run = getRun(sessionId)
        return send(res, 200, { run: run ? panelView(run) : null })
      }
      if (rest[2] !== 'control') return send(res, 404, { error: 'not found' })
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || req.headers['x-perturbpilot'] !== '1') {
        return send(res, 403, { error: 'forbidden' })
      }
      const body = JSON.parse(await readBody(req))
      if (!CONTROL_ACTIONS.includes(body?.action)) return send(res, 400, { error: `action 必须是 ${CONTROL_ACTIONS.join('/')} 之一` })
      const run = getRun(sessionId)
      if (!run) return send(res, 404, { error: '这个会话还没有开始任务' })
      control(sessionId, body.action)
      return send(res, 200, { run: panelView(run) })
    } catch (error) {
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
