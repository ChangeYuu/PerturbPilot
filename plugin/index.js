// PerturbPilot 的 DSH 插件：把"一次科学任务"接进 DSH 的一个会话里。
// 任务由用户在面板上确认开始（自己选任务，或确认 agent 用 pp_propose_task 提的设置），框架建好运行记录后开第 1 轮。
// 一轮 = 一个 DSH turn；本轮提交后由框架用 followup 开下一轮。
// agent 负责选（参考决策模块的推荐，按依据分组写理由），框架负责提交给 oracle 并把读数回灌给决策模块。
// agent 用 DSH 自带的 web_search / web_fetch 查文献，这里只记录检索，不拦截。
// 科学状态放在会话之外（runs/<会话 id>/），每一步通过 systemPrompt.context 注入，所以上下文压缩不会丢。

import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolvePython, runAnalysis } from './lib/analysis.js'
import { installFetchCapture } from './lib/capture.js'
import { CONTROL_ACTIONS, HYPOTHESIS_STATUSES, RETRIEVAL_TOOLS, Run, RunError, SOURCES } from './lib/run.js'
import { createServices } from './lib/services.js'
import { PANEL_ROUTE, PanelError, createPanelHandler, listRuns, taskPreview } from './lib/panel.js'
import { MAX_ROUNDS, checkSetup } from './lib/setup.js'
import { ROLE_PROMPT, roundPrompt, steerPrompt } from './lib/prompts.js'

export const name = 'perturbpilot'
export const inject = ['agents', 'tools']

export const Config = z.object({
  oracleUrl: z.string().default('http://127.0.0.1:8701').description('oracle 服务地址'),
  decisionUrl: z.string().default('http://127.0.0.1:8702').description('决策模块服务地址'),
  runsDir: z.string().default('runs').description('运行目录，相对于启动 dsh 时的目录'),
  llmUrlPattern: z.string().default('deepseek').description('URL 命中这个正则的 fetch 调用记为模型调用'),
  maxSteers: z.natural().default(2).description('一轮快结束还没提交时最多催几次'),
  pythonPath: z.string().default('python').description('pp_run_python 用的 Python；带目录的相对路径按启动 dsh 时的目录解析'),
  pythonTimeoutMs: z.natural().default(60000).description('一次 pp_run_python 最多跑多久（毫秒），超时杀掉'),
  serviceTokenEnv: z.string().default('PERTURBPILOT_SERVICE_TOKEN').description('服务令牌所在的环境变量名；设了就随每个服务请求带上'),
})

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx, config) {
  const runsDir = resolve(process.cwd(), config.runsDir)
  const runs = new Map() // agent.id -> Run
  const retrievalCalls = new Map() // callId -> 还没回来的 web_search / web_fetch 调用 {agent_id, name, arguments}
  const driven = new Map() // agent.id -> 由框架发起、正在进行的轮次号
  const proposals = new Map() // agent.id -> agent 用 pp_propose_task 提的、等用户确认的设置
  let lastRequest = null // 最近一次 agent/request 的 {agent_id, turn, step}，用来给模型调用记录挂上归属

  const capture = installFetchCapture({
    pattern: config.llmUrlPattern,
    logger: ctx.logger,
    onCall(record) {
      const run = lastRequest && runs.get(lastRequest.agent_id)
      if (run) run.recordLlmCall(record, { turn: lastRequest.turn, step: lastRequest.step, correlation: 'latest-request' })
    },
  })
  const serviceOptions = {
    oracleUrl: config.oracleUrl,
    decisionUrl: config.decisionUrl,
    fetch: capture.original,
    token: process.env[config.serviceTokenEnv] || undefined,
  }
  const services = createServices(serviceOptions)
  const python = resolvePython(config.pythonPath)

  function runById(id) {
    let run = runs.get(id)
    if (!run) {
      const dir = join(runsDir, id)
      if (Run.exists(dir) && !Run.isLegacy(dir)) {
        run = Run.load(dir, id)
        runs.set(id, run)
      }
    }
    return run
  }

  function runFor(agent) {
    return agent ? runById(agent.id) : undefined
  }

  function requireRun(exec) {
    if (!exec.agent) throw new RunError('PerturbPilot 工具只能在会话里用')
    const run = runFor(exec.agent)
    if (!run) throw new RunError('这个会话还没有开始任务。先用 pp_list_tasks 看有哪些任务，和用户确认后用 pp_propose_task 提议，用户在面板上确认后框架才开始。')
    return run
  }

  /** 能选的任务、决策模块的方法和预算范围：pp_list_tasks 和面板的任务选择用同一份。 */
  async function catalog(api = services, signal) {
    const [{ tasks, active }, manifest] = await Promise.all([api.tasks(signal), api.manifest(signal)])
    return {
      tasks: tasks.map(taskPreview),
      active,
      decision: {
        name: manifest.name,
        default_method: manifest.method,
        methods: Array.isArray(manifest.methods) ? Object.fromEntries(manifest.methods.map((m) => [m, ''])) : manifest.methods ?? {},
        requires: manifest.requires ?? {},
      },
      limits: { rounds: [1, MAX_ROUNDS], batch_size: [1, 'n_candidates'] },
    }
  }

  const starting = new Set() // 正在开始任务的会话，防止连点开出两个

  /**
   * 面板上确认开始：按 setup（{task_id, method, rounds, batch_size}）建运行记录，然后由框架开第 1 轮（会话正忙时等它空下来再开）。
   * 决策模块和 oracle 同一时间只跑一个任务，别的会话里还有没结束的任务时不开。
   */
  async function startTask(sessionId, setup = {}) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) throw new PanelError(404, '找不到这个会话')
    if (runById(sessionId)) throw new RunError('这个会话已经开始过任务')
    const dir = join(runsDir, sessionId)
    if (Run.isLegacy(dir)) throw new RunError('这个会话里有旧格式的任务记录，不能再开任务；新开一个会话。')
    if (starting.size) throw new RunError('正在开始任务')
    for (const [id, other] of runs) {
      if (id !== sessionId && !other.closed) {
        throw new RunError(`会话 ${id} 的任务还没结束（${other.state.status === 'paused' ? '已暂停' : '进行中'}）。决策模块和 oracle 同一时间只跑一个任务，先在那个会话里结束它。`)
      }
    }
    starting.add(sessionId)
    try {
      runs.set(sessionId, await Run.start({ dir, runId: sessionId, services, setup, proposal: proposals.get(sessionId) ?? null }))
    } finally {
      starting.delete(sessionId)
    }
    proposals.delete(sessionId)
    drive(agent)
  }

  function warn(message, error) {
    ctx.logger.warn(`perturbpilot: ${message}: ${error?.message ?? error}`)
  }

  // ---- 提示 ----

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({ name: 'perturbpilot:role', order: 900, text: ROLE_PROMPT, interpolate: false })
    scope.systemPrompt.context({
      name: 'perturbpilot:state',
      order: 130,
      text: (context) => {
        try {
          return runFor(context.agent)?.brief() ?? ''
        } catch (error) {
          warn('could not render state brief', error)
          return ''
        }
      },
    })
  })

  // ---- 工具 ----

  const tool = (options) => ctx.tools.register(defineTool({ output: JSON_OUTPUT, ...options }))

  tool({
    name: 'pp_list_tasks',
    description: '开任务前用：列出能跑的任务包（每个的扰动、读数字段、目标、预算、候选数和带的数据）、决策模块的方法（每个方法需要的输入）和预算能调的范围。只能从这里列出的任务里选。',
    parameters: {},
    async execute(_args, exec) {
      return { ...(await catalog(services, exec.signal)), started: Boolean(exec.agent && runFor(exec.agent)) }
    },
  })

  tool({
    name: 'pp_propose_task',
    description: '和用户问清楚要跑什么之后，提议这个会话要开始的任务设置。框架检查设置能不能跑，然后在对话和面板上显示确认卡片；用户点确认后框架才开始第 1 轮，你不能自己开始。method、rounds、batch_size 省略表示用默认（决策模块的默认方法、任务包的预算）。提议后本 turn 结束；用户改主意就重新提议，新的覆盖旧的。',
    parameters: {
      task_id: { type: 'string', required: true, description: 'pp_list_tasks 里的 task_id' },
      method: { type: 'string', description: '决策模块的方法；省略用默认' },
      rounds: { type: 'integer', description: `轮数，1–${MAX_ROUNDS}；省略用任务包的` },
      batch_size: { type: 'integer', description: '每轮个数，1 到候选数；省略用任务包的' },
      rationale: { type: 'string', required: true, description: '为什么选这个任务、方法和预算；用户的描述里有哪些要素和任务对不上，也写在这里' },
    },
    async execute(args, exec) {
      if (!exec.agent) throw new RunError('PerturbPilot 工具只能在会话里用')
      if (runFor(exec.agent)) throw new RunError('这个会话已经开始了任务，不能再提议')
      const { tasks } = await services.tasks(exec.signal)
      const manifest = await services.manifest(exec.signal)
      const setup = { task_id: args.task_id, method: args.method ?? null, rounds: args.rounds ?? null, batch_size: args.batch_size ?? null }
      const { card, method, budget } = checkSetup(tasks, manifest, setup)
      const proposal = { ...setup, rationale: args.rationale, at: new Date().toISOString() }
      proposals.set(exec.agent.id, proposal)
      exec.concludeTurn()
      return {
        proposal,
        effective: { task_id: card.task_id, title: card.title, method: method ?? manifest.method, budget, n_candidates: card.n_candidates },
        next: '已显示确认卡片，等用户确认；用户确认后框架开始第 1 轮。',
      }
    },
  })

  tool({
    name: 'pp_get_decision',
    description: '向决策模块要本轮的推荐。recommendations 是默认要测的一批，alternatives 是排在后面的备选；每项带的数值随方法不同（比如 gp-ucb 给预测均值 mu、不确定度 sigma、得分 score，coverage 只给顺序分）。method 和 inputs_used 说明它用了什么方法和数据。每轮提交前必须至少调用一次。',
    parameters: {},
    async execute(_args, exec) {
      return requireRun(exec).getDecision(services, exec.signal)
    },
  })

  tool({
    name: 'pp_submit_selection',
    description: '提交本轮要测的一批候选。batch 的个数必须正好是本轮要求的个数（pp_get_decision 返回的 batch_size）；推荐以外的候选都要放进 groups 里某个 source 不是 decision 的组，并写明理由。框架会把这一批交给 oracle 测量、把读数交给决策模块，然后本 turn 结束。',
    parameters: {
      batch: { type: 'array', required: true, items: { type: 'string' }, description: '本轮要测的候选 id' },
      groups: {
        type: 'array',
        required: true,
        description: '按依据分组的理由；全部照推荐时可以传空数组',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ids: { type: 'array', required: true, items: { type: 'string' }, description: '这一组的候选 id，都要在 batch 里，一个 id 只能在一个组' },
            source: { type: 'string', required: true, enum: [...SOURCES], description: 'decision 照推荐 / prior_knowledge 已有知识 / literature 本轮查到的文献 / analysis 分析结果 / hypothesis_test 检验假设 / exploration 探索 / data_quality 复测可疑读数' },
            reason: { type: 'string', required: true, description: '一两句具体理由：引用读数、假设编号、分析编号或查到的来源' },
          },
        },
      },
    },
    async execute(args, exec) {
      const result = await requireRun(exec).submitSelection(args, services, exec.signal)
      exec.concludeTurn()
      return result
    },
  })

  tool({
    name: 'pp_update_hypothesis',
    description: '新建或更新一条假设。新建不填 id；更新填已有的 id（如 H1）。cites 列出支撑或反驳它的已测候选 id。',
    parameters: {
      id: { type: 'string', description: '已有假设的编号；新建时省略' },
      text: { type: 'string', description: '假设内容；更新时可省略表示不改' },
      status: { type: 'string', required: true, enum: [...HYPOTHESIS_STATUSES] },
      cites: { type: 'array', required: true, items: { type: 'string' }, description: '引用的已测候选 id' },
      rationale: { type: 'string', description: '这次更新的理由' },
    },
    async execute(args, exec) {
      return requireRun(exec).updateHypothesis(args)
    },
  })

  tool({
    name: 'pp_write_note',
    description: '写一条研究笔记（观察到的规律、可疑的读数、下一步想法）。cites 列出涉及的已测候选 id。',
    parameters: {
      text: { type: 'string', required: true },
      cites: { type: 'array', required: true, items: { type: 'string' } },
    },
    async execute(args, exec) {
      return requireRun(exec).writeNote(args)
    },
  })

  tool({
    name: 'pp_get_ledger',
    description: '取完整的读数账本（每次测量的全部读数字段）、全部假设、笔记和检索记录。状态简报里只列了最好的 10 个，需要全部时用这个。',
    parameters: {},
    async execute(_args, exec) {
      return requireRun(exec).ledger()
    },
  })

  tool({
    name: 'pp_run_python',
    description: '在本任务的运行目录里跑一段 Python 做分析（numpy 可用）。当前目录下有 observations.csv（id, round, replicate 加每个读数字段，全部测量）、candidates.csv（任务包的候选表）、decision.csv（最近一次推荐里决策模块对每个候选的打分）、data/（任务包里公开的数据文件，比如候选特征）。用 print 输出结论；写出的文件会留在这次分析的目录里。这里不能测量新候选，测量只能经 pp_submit_selection。代码和输出都会记录。',
    parameters: {
      code: { type: 'string', required: true, description: '完整的 Python 脚本' },
      purpose: { type: 'string', required: true, description: '一句话：这段分析要回答什么' },
    },
    async execute(args, exec) {
      return runAnalysis(requireRun(exec), args, { python, timeoutMs: config.pythonTimeoutMs, signal: exec.signal })
    },
  })

  tool({
    name: 'pp_control',
    description: '只在用户明确要求时调用：pause 暂停自动推进（当前轮可以继续做完）、resume 恢复、stop 结束任务。',
    parameters: {
      action: { type: 'string', required: true, enum: [...CONTROL_ACTIONS] },
    },
    async execute(args, exec) {
      return requireRun(exec).control(args.action, 'human')
    },
  })

  // ---- 回合驱动 ----

  function drive(agent) {
    const run = runFor(agent)
    if (!run || agent.status !== 'idle' || ctx.agents.get(agent.id) !== agent) return
    if (agent.inbox?.nextTurn?.length) return // 用户已经排了消息，让用户的先走
    const round = run.nextRoundToDrive()
    if (round === null) return
    try {
      ctx.agents.withoutInitiator(async () => {
        run.markDriven(round)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: roundPrompt(run.state, round) }],
          source: { kind: 'perturbpilot', round },
        }))
      }).catch((error) => warn(`could not queue round ${round}`, error))
    } catch (error) {
      warn(`could not queue round ${round}`, error)
    }
  }

  // ---- 浏览器面板的数据路由（只在带 web 服务的组合里挂） ----

  ctx.inject(['webServer'], (scope) => {
    // 设置页查服务连不连得上，用短超时的另一份客户端，别让页面卡 30 秒。
    const probe = createServices({ ...serviceOptions, timeoutMs: 2000 })
    const check = (fn, pick) => fn().then((x) => ({ ok: true, ...pick(x) }), (error) => ({ ok: false, error: error.message }))
    const handler = createPanelHandler({
      getRun: runById,
      control(sessionId, action) {
        runById(sessionId).control(action, 'human')
        const agent = ctx.agents.get(sessionId)
        if (action === 'resume' && agent) drive(agent)
      },
      start: startTask,
      proposal: (sessionId) => proposals.get(sessionId) ?? null,
      tasks: () => catalog(probe),
      listRuns: () => listRuns(runsDir),
      async status() {
        const [oracle, decision] = await Promise.all([
          check(probe.tasks, (x) => ({ tasks: x.tasks.map((t) => t.task_id), active: x.active })),
          check(probe.manifest, (x) => ({ name: x.name, version: x.version, method: x.method })),
        ])
        return {
          config: {
            oracleUrl: config.oracleUrl,
            decisionUrl: config.decisionUrl,
            runsDir,
            pythonPath: python,
            pythonTimeoutMs: config.pythonTimeoutMs,
            maxSteers: config.maxSteers,
            llmUrlPattern: config.llmUrlPattern,
            serviceTokenEnv: config.serviceTokenEnv,
          },
          token_set: Boolean(serviceOptions.token),
          services: { oracle, decision },
        }
      },
      logger: ctx.logger,
    })
    scope.effect(() => scope.webServer.register({ kind: 'prefix', path: PANEL_ROUTE, handler }), 'perturbpilot panel route')
  })

  ctx.effect(function* () {
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      if (runs.has(agent.id)) lastRequest = { agent_id: agent.id, turn, step }
      return next()
    })

    ctx.on('session/event', (session, event) => {
      if (event.type === 'tool/call' || event.type === 'tool/result') {
        trackRetrieval(session.id, event)
        return
      }
      if (event.type !== 'user/message') return
      const agent = ctx.agents.get(session.id)
      const run = runFor(agent)
      const source = event.data?.source
      if (!run || !source) return
      if (source.kind === 'perturbpilot') {
        driven.set(agent.id, source.round)
      } else if (source.kind === 'user') {
        driven.delete(agent.id) // 用户插话后，这个 turn 归用户，不再催
        const text = (event.data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        try {
          run.recordHuman(text)
        } catch (error) {
          warn('could not record human message', error)
        }
      }
    })

    // 检索只记录不拦截：tool/call 记下调用，tool/result 回来时交给 Run 落盘。
    function trackRetrieval(sessionId, event) {
      const data = event.data ?? {}
      if (event.type === 'tool/call') {
        if (RETRIEVAL_TOOLS.includes(data.name) && runById(sessionId)) {
          retrievalCalls.set(data.callId, { agent_id: sessionId, name: data.name, arguments: data.arguments })
        }
        return
      }
      const id = data.message?.toolCallId
      const call = retrievalCalls.get(id)
      if (!call) return
      retrievalCalls.delete(id)
      try {
        runById(call.agent_id)?.recordRetrieval(call, data)
      } catch (error) {
        warn('could not record retrieval', error)
      }
    }

    ctx.on('agent/turn-stopping', ({ agent }) => {
      const run = runFor(agent)
      const round = driven.get(agent.id)
      if (!run || round === undefined) return
      try {
        if (!run.shouldSteer(round, config.maxSteers)) return
        run.markSteered(round)
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: steerPrompt(round) }],
          source: { kind: 'perturbpilot', round, steer: true },
        }))
      } catch (error) {
        warn('could not steer', error)
      }
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const run = runFor(agent)
      if (!run) return
      const round = driven.get(agent.id)
      driven.delete(agent.id)
      try {
        if (round !== undefined) run.stallIfOpen(round)
      } catch (error) {
        warn('could not record stalled round', error)
      }
      drive(agent)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      runs.delete(agent.id)
      proposals.delete(agent.id)
      driven.delete(agent.id)
    })

    yield () => capture.uninstall()
  }, 'perturbpilot lifecycle')
}

function summary(run) {
  const s = run.state
  return {
    run_id: s.runId,
    task: s.task,
    decision: s.decision,
    status: s.status,
    round: s.round,
  }
}
