// 插件装配测试：用真实的 defineTool / createUserMessage 装配插件，DSH 宿主（ctx、agent）用最小替身，
// oracle 和决策模块用本地 HTTP 替身。检查工具能注册、参数校验生效、回合驱动与催交按预期触发、记录落盘。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import * as plugin from '../index.js'
import { fakeServices } from './fake-services.js'

const ROUTES = {
  'GET /task': 'task',
  'GET /manifest': 'manifest',
  'POST /init': 'init',
  'POST /reset': 'resetOracle',
  'POST /restore': 'restore',
  'POST /propose': 'propose',
  'POST /run': 'run',
  'POST /observe': 'observe',
  'GET /snapshot': 'snapshot',
}

let server
let base
let dir
let services
const tokens = [] // 服务替身收到的每个请求带的令牌头
before(async () => {
  services = fakeServices()
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/llm/chat') return res.end(JSON.stringify({ choices: [] }))
      tokens.push(req.headers['x-perturbpilot-token'])
      const method = ROUTES[`${req.method} ${req.url}`]
      if (!method) {
        res.statusCode = 404
        return res.end(JSON.stringify({ error: 'no route' }))
      }
      res.end(JSON.stringify(await services[method](body ? JSON.parse(body) : {})))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  dir = mkdtempSync(join(tmpdir(), 'pp-plugin-'))
})
after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(services.packageDir, { recursive: true, force: true })
})

function fakeHost() {
  const agents = new Map()
  const host = {
    handlers: {},
    tools: {},
    sections: [],
    contexts: [],
    disposers: [],
    warnings: [],
    routes: [],
  }
  host.ctx = {
    logger: { warn: (m) => host.warnings.push(m) },
    agents: { get: (id) => agents.get(id), withoutInitiator: (fn) => fn() },
    tools: { register: (t) => (host.tools[t.name] = t) },
    inject(_keys, fn) {
      fn({
        systemPrompt: { section: (s) => host.sections.push(s), context: (c) => host.contexts.push(c) },
        webServer: { register: (route) => (host.routes.push(route), () => host.routes.splice(host.routes.indexOf(route), 1)) },
        effect: (register) => host.disposers.push(register()),
      })
    },
    on(name, fn) {
      host.handlers[name] = fn
    },
    effect(gen) {
      host.disposers.push(gen().next().value)
    },
  }
  host.addAgent = (id) => {
    const agent = {
      id,
      status: 'idle',
      session: { id },
      inbox: { nextTurn: [] },
      followups: [],
      steers: [],
      followup: (m) => agent.followups.push(m),
      steer: (m) => agent.steers.push(m),
    }
    agents.set(id, agent)
    return agent
  }
  return host
}

function exec(agent) {
  const e = { agent, signal: new AbortController().signal, concluded: false }
  e.concludeTurn = () => (e.concluded = true)
  return e
}

const tick = () => new Promise((r) => setTimeout(r, 20))
const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('plugin drives rounds, steers, validates and records', async () => {
  const originalFetch = globalThis.fetch
  const host = fakeHost()
  const config = new plugin.Config({ oracleUrl: base, decisionUrl: base, runsDir: dir, llmUrlPattern: '/llm/', serviceTokenEnv: 'PP_TEST_SERVICE_TOKEN' })
  process.env.PP_TEST_SERVICE_TOKEN = 'tok-1'
  try {
    plugin.apply(host.ctx, config)
  } finally {
    delete process.env.PP_TEST_SERVICE_TOKEN
  }
  const agent = host.addAgent('sess-1')
  const runDir = join(dir, 'sess-1')

  assert.deepEqual(Object.keys(host.tools).sort(), [
    'pp_control', 'pp_get_decision', 'pp_get_ledger', 'pp_run_python', 'pp_start_task', 'pp_submit_selection', 'pp_update_hypothesis', 'pp_write_note',
  ])
  assert.equal(host.sections[0].name, 'perturbpilot:role')
  const brief = () => host.contexts[0].text({ agent })
  assert.equal(brief(), '') // 没有任务时不注入

  await assert.rejects(host.tools.pp_get_decision.execute({}, exec(agent)), /pp_start_task/)
  const start = exec(agent)
  const started = await host.tools.pp_start_task.execute({}, start)
  assert.equal(started.started, true)
  assert.equal(start.concluded, true)
  assert.match(brief(), /第 1\/3 轮/)

  // 空闲 → 框架开第 1 轮
  host.handlers['agent/status']({ agent, status: 'idle' })
  await tick()
  assert.equal(agent.followups.length, 1)
  assert.deepEqual(agent.followups[0].source, { kind: 'perturbpilot', round: 1 })
  host.handlers['session/event'](agent.session, { type: 'user/message', data: agent.followups[0] })

  // 快结束还没交 → 催一次
  await host.handlers['agent/turn-stopping']({ agent, turn: 2 })
  assert.equal(agent.steers.length, 1)

  // 模型调用抓取：归属到最近一次 agent/request
  await host.handlers['agent/request']({ agent, turn: 2, step: 3 }, async () => ({}))
  await fetch(`${base}/llm/chat`, { method: 'POST', headers: { authorization: 'Bearer sk-x' }, body: '{"q":1}' })
  await tick()
  const llm = readJsonl(join(runDir, 'llm_calls.jsonl'))
  assert.equal(llm.length, 1)
  assert.equal(llm[0].turn, 2)
  assert.equal(llm[0].step, 3)
  assert.ok(!JSON.stringify(llm).includes('sk-x'))

  // 检索：web_search 的调用和结果经 session/event 到达，只记录；别的工具不记
  host.handlers['session/event'](agent.session, { type: 'tool/call', data: { turn: 2, step: 3, callId: 'w1', name: 'web_search', arguments: { queries: ['G009 通路'] } } })
  host.handlers['session/event'](agent.session, { type: 'tool/call', data: { turn: 2, step: 3, callId: 'o1', name: 'pp_get_ledger', arguments: {} } })
  host.handlers['session/event'](agent.session, { type: 'tool/result', data: { message: { toolCallId: 'o1', isError: false, content: [] }, meta: {} } })
  host.handlers['session/event'](agent.session, {
    type: 'tool/result',
    data: { message: { toolCallId: 'w1', isError: false, content: [{ type: 'text', text: '搜到一篇' }] }, meta: { sources: [{ url: 'https://example.org/a', title: 'A' }] } },
  })
  assert.deepEqual(readJsonl(join(runDir, 'events.jsonl')).filter((e) => e.type.startsWith('retrieval/')).map((e) => [e.type, e.data.id]), [['retrieval/searched', 'R1']])
  assert.equal(JSON.parse(readFileSync(join(runDir, 'retrieval', 'R1.json'), 'utf8')).text, '搜到一篇')

  const decision = await host.tools.pp_get_decision.execute({}, exec(agent))
  assert.equal(decision.method, 'coverage')
  const ids = decision.recommendations.map((x) => x.id)
  await assert.rejects(host.tools.pp_submit_selection.execute({ batch: ids }, exec(agent))) // 缺 groups，参数校验拒绝
  await assert.rejects(host.tools.pp_submit_selection.execute({ batch: ids, groups: [{ ids: [ids[0]], source: 'bogus', reason: 'x' }] }, exec(agent))) // source 不在枚举里
  const extra = decision.alternatives[0].id
  const submit = exec(agent)
  const result = await host.tools.pp_submit_selection.execute(
    { batch: [...ids.slice(1), extra], groups: [{ ids: [extra], source: 'literature', reason: '搜到的文章提到它' }] },
    submit,
  )
  assert.equal(submit.concluded, true)
  assert.equal(result.results.length, 3)
  assert.equal(result.results.filter((x) => !x.recommended).length, 1)
  const audit = JSON.parse(readFileSync(join(runDir, 'audit.json'), 'utf8'))
  assert.equal(audit.rounds[0].checks.literature_backed.result, 'pass')

  // 已经交了 → 不再催；空闲 → 开第 2 轮
  await host.handlers['agent/turn-stopping']({ agent, turn: 2 })
  assert.equal(agent.steers.length, 1)
  host.handlers['agent/status']({ agent, status: 'idle' })
  await tick()
  assert.equal(agent.followups.length, 2)
  assert.equal(agent.followups[1].source.round, 2)

  // 用户插话：记为 human 事件；用户排了消息时框架不抢
  host.handlers['session/event'](agent.session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先暂停一下' }] },
  })
  await host.tools.pp_control.execute({ action: 'pause' }, exec(agent))
  host.handlers['agent/status']({ agent, status: 'idle' })
  await tick()
  assert.equal(agent.followups.length, 2)

  // 面板路由：读到暂停状态；从面板点"继续"，空闲的会话马上开下一轮
  assert.equal(host.routes.length, 1)
  assert.equal(host.routes[0].kind, 'prefix')
  assert.equal(host.routes[0].path, '/perturbpilot/api')
  const panel = createServer(host.routes[0].handler)
  await new Promise((r) => panel.listen(0, '127.0.0.1', r))
  const apiBase = `http://127.0.0.1:${panel.address().port}/perturbpilot/api`
  const panelBase = `${apiBase}/sessions/sess-1`
  try {
    const listed = (await (await fetch(`${apiBase}/sessions`)).json()).runs
    assert.deepEqual(listed.map((x) => [x.run_id, x.status, x.round]), [['sess-1', 'paused', 2]])
    const status = await (await fetch(`${apiBase}/status`)).json()
    assert.equal(status.token_set, true)
    assert.ok(!JSON.stringify(status).includes('tok-1')) // 只报有没有设，不报值
    assert.equal(status.config.runsDir, dir)
    assert.deepEqual(status.services.oracle, { ok: true, task_id: 'fake-task', synthetic: true })
    assert.deepEqual(status.services.decision, { ok: true, name: 'fake', version: 'fake/0', method: 'coverage' })
    const view = (await (await fetch(panelBase)).json()).run
    assert.equal(view.status, 'paused')
    assert.equal(view.round, 2)
    agent.inbox.nextTurn = []
    const resumed = await fetch(`${panelBase}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-perturbpilot': '1' },
      body: JSON.stringify({ action: 'resume' }),
    })
    assert.equal((await resumed.json()).run.status, 'active')
    await tick()
    assert.equal(agent.followups.length, 3)
    assert.equal(agent.followups[2].source.round, 2)
  } finally {
    panel.close()
  }

  // 每个服务请求（包括设置页的探测）都带了令牌
  assert.ok(tokens.length > 0)
  assert.ok(tokens.every((t) => t === 'tok-1'))

  const events = readJsonl(join(runDir, 'events.jsonl'))
  const human = events.find((e) => e.type === 'human/message')
  assert.equal(human.source, 'human')
  assert.equal(human.data.text, '先暂停一下')
  assert.ok(events.some((e) => e.type === 'round/steered' && e.round === 1))
  assert.ok(existsSync(join(runDir, 'audit.json')))

  for (const dispose of host.disposers) dispose()
  assert.equal(globalThis.fetch, originalFetch)
  assert.equal(host.routes.length, 0)
  assert.deepEqual(host.warnings, [])
})
