// 浏览器面板的宿主侧：把一次任务的状态整理成面板要显示的视图，并挂一个 HTTP 路由给面板读和控制。
// 路由挂在 DSH 自己的 web 服务上（同源），只读 runs/ 里已有的状态，写操作只有暂停 / 继续 / 结束。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditRun } from './audit.js'
import { CONTROL_ACTIONS, RunError } from './run.js'

export const PANEL_ROUTE = '/perturbpilot/api'
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/
const MAX_BODY = 4096

/** 面板显示用的视图：状态、每轮的推荐 / 选择 / 读数 / 审计、读数排名、假设、笔记、最近的事件。 */
export function panelView(run, { events = 40 } = {}) {
  const s = run.state
  const audit = auditRun(s)
  const auditByRound = new Map(audit.rounds.map((x) => [x.round, x.checks]))
  const rounds = []
  for (let r = 1; r <= Math.min(s.round, s.task.max_rounds); r++) {
    const rec = s.rounds[r]
    const last = rec?.proposals.at(-1)
    rounds.push({
      round: r,
      proposals: rec?.proposals.length ?? 0,
      recommendations: last?.recommendations ?? [],
      steers: rec?.steers ?? 0,
      submission: rec?.submission ? { accept: rec.submission.accept, replace: rec.submission.replace, batch: rec.submission.batch } : null,
      results: rec?.results?.map((x) => ({ id: x.id, value: round4(x.value), replicate: x.replicate })) ?? null,
      receipt: rec?.receipt ? {
        accepted: rec.receipt.accepted.length,
        rejected: rec.receipt.rejected.length,
        state_version_before: rec.receipt.state_version_before,
        state_version_after: rec.receipt.state_version_after,
      } : null,
      checks: auditByRound.get(r) ?? {},
    })
  }
  const direction = s.task.objective.direction === 'minimize' ? 1 : -1
  const observations = s.observations
    .map((o) => ({ id: o.id, value: round4(o.value), replicate: o.replicate, round: o.round }))
    .sort((a, b) => direction * (a.value - b.value))
  return {
    run_id: s.runId,
    task: {
      task_id: s.task.task_id,
      title: s.task.title,
      synthetic: s.task.synthetic,
      objective: s.task.objective,
      batch_size: s.task.batch_size,
      max_rounds: s.task.max_rounds,
      n_candidates: s.task.n_candidates,
    },
    decision: s.decision,
    status: s.status,
    round: s.round,
    audit_counts: audit.counts,
    controls: run.closed ? [] : s.status === 'paused' ? ['resume', 'stop'] : ['pause', 'stop'],
    rounds,
    observations,
    hypotheses: s.hypotheses.map(({ history, ...h }) => ({ ...h, updates: history?.length ?? 0 })),
    notes: s.notes,
    events: tailEvents(run.recorder.dir, events),
  }
}

function tailEvents(dir, n) {
  const path = join(dir, 'events.jsonl')
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-n)
  return lines.map((line) => {
    const { seq, ts, round, type, source } = JSON.parse(line)
    return { seq, ts, round, type, source }
  })
}

/**
 * 面板路由的处理函数。
 *   GET  <PANEL_ROUTE>/sessions/<会话 id>          → { run: 视图 | null }
 *   POST <PANEL_ROUTE>/sessions/<会话 id>/control  body { action } → { run: 视图 }
 * POST 要求 content-type 为 application/json 且带 x-perturbpilot 头，别的网页没法跨站伪造（会触发预检，这里不答预检）。
 * @param deps.getRun - (sessionId) => Run | undefined
 * @param deps.control - (sessionId, action) => void，执行控制并在需要时推动回合
 */
export function createPanelHandler({ getRun, control, logger }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const rest = url.pathname.slice(PANEL_ROUTE.length).split('/').filter(Boolean)
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

function round4(x) {
  return Math.round(x * 1e4) / 1e4
}
