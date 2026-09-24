// PerturbPilot 的 DSH 插件：把"一次科学任务"接进 DSH 的一个会话里。
// 一轮 = 一个 DSH turn；本轮提交后由框架用 followup 开下一轮。
// agent 负责选（接受或替换决策模块的推荐），框架负责提交给 oracle 并把读数回灌给决策模块。
// 科学状态放在会话之外（runs/<会话 id>/），每一步通过 systemPrompt.context 注入，所以上下文压缩不会丢。

import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installFetchCapture } from './lib/capture.js'
import { CONTROL_ACTIONS, HYPOTHESIS_STATUSES, REASON_TYPES, Run, RunError } from './lib/run.js'
import { createServices } from './lib/services.js'
import { PANEL_ROUTE, createPanelHandler } from './lib/panel.js'
import { ROLE_PROMPT, roundPrompt, steerPrompt } from './lib/prompts.js'

export const name = 'perturbpilot'
export const inject = ['agents', 'tools']

export const Config = z.object({
  oracleUrl: z.string().default('http://127.0.0.1:8701').description('oracle 服务地址'),
  decisionUrl: z.string().default('http://127.0.0.1:8702').description('决策模块服务地址'),
  runsDir: z.string().default('runs').description('运行目录，相对于启动 dsh 时的目录'),
  llmUrlPattern: z.string().default('deepseek').description('URL 命中这个正则的 fetch 调用记为模型调用'),
  maxSteers: z.natural().default(2).description('一轮快结束还没提交时最多催几次'),
})

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx, config) {
  const runsDir = resolve(process.cwd(), config.runsDir)
  const runs = new Map() // agent.id -> Run
  const driven = new Map() // agent.id -> 由框架发起、正在进行的轮次号
  let lastRequest = null // 最近一次 agent/request 的 {agent_id, turn, step}，用来给模型调用记录挂上归属

  const capture = installFetchCapture({
    pattern: config.llmUrlPattern,
    logger: ctx.logger,
    onCall(record) {
      const run = lastRequest && runs.get(lastRequest.agent_id)
      if (run) run.recordLlmCall(record, { turn: lastRequest.turn, step: lastRequest.step, correlation: 'latest-request' })
    },
  })
  const services = createServices({ oracleUrl: config.oracleUrl, decisionUrl: config.decisionUrl, fetch: capture.original })

  function runById(id) {
    let run = runs.get(id)
    if (!run) {
      const dir = join(runsDir, id)
      if (Run.exists(dir)) {
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
    if (!run) throw new RunError('还没有开始任务，先调用 pp_start_task')
    return run
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
    name: 'pp_start_task',
    description: '开始一次 PerturbPilot 任务：读取任务说明，清空 oracle 和决策模块的状态，建立运行记录。一个会话只跑一个任务；已经开始过就返回当前状态。调用后本 turn 结束，第 1 轮由框架自动开始。',
    parameters: {},
    async execute(_args, exec) {
      if (!exec.agent) throw new RunError('PerturbPilot 工具只能在会话里用')
      const existing = runFor(exec.agent)
      if (existing) return { already_started: true, ...summary(existing) }
      const run = await Run.start({ dir: join(runsDir, exec.agent.id), runId: exec.agent.id, services, signal: exec.signal })
      runs.set(exec.agent.id, run)
      exec.concludeTurn()
      return { started: true, ...summary(run), note: '第 1 轮会自动开始。' }
    },
  })

  tool({
    name: 'pp_get_decision',
    description: '向决策模块要本轮的推荐。recommendations 是默认要测的一批（每个带预测均值 mu、不确定度 sigma、得分 score）；alternatives 是排在后面的备选。每轮提交前必须至少调用一次。',
    parameters: {},
    async execute(_args, exec) {
      return requireRun(exec).getDecision(services, exec.signal)
    },
  })

  tool({
    name: 'pp_submit_selection',
    description: '提交本轮要测的一批候选。每个推荐都必须出现在 accept 里，或作为 replace 的 out 被换掉；替换必须给出 reason_type 和理由。框架会把这一批交给 oracle 测量、把读数交给决策模块，然后本 turn 结束。',
    parameters: {
      accept: { type: 'array', required: true, items: { type: 'string' }, description: '原样接受的推荐 id' },
      replace: {
        type: 'array',
        required: true,
        description: '替换；不替换时传空数组',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            out: { type: 'string', required: true, description: '被换掉的推荐 id' },
            in: { type: 'string', required: true, description: '换进来的候选 id（可以是已测过的，表示重复测量）' },
            reason_type: { type: 'string', required: true, enum: [...REASON_TYPES], description: 'hypothesis_test 检验假设 / exploration 探索 / data_quality 复测可疑读数 / other' },
            reason: { type: 'string', required: true, description: '一两句具体理由，引用读数或假设编号' },
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
    description: '取完整的读数账本、全部假设和笔记。状态简报里只列了前 15 个读数，需要全部时用这个。',
    parameters: {},
    async execute(_args, exec) {
      return requireRun(exec).ledger()
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
    const handler = createPanelHandler({
      getRun: runById,
      control(sessionId, action) {
        runById(sessionId).control(action, 'human')
        const agent = ctx.agents.get(sessionId)
        if (action === 'resume' && agent) drive(agent)
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
