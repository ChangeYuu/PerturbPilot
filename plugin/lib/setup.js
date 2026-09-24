// 开任务前的设置：跑哪个任务包、决策模块用什么方法、预算（轮数、每轮个数）。
// agent 用 pp_propose_task 提议、用户在面板上确认开始，都经过这里的同一套检查。

import { RunError } from './run.js' // 只在函数里用，和 run.js 互相引用没问题

export const MAX_ROUNDS = 50

/** 决策模块提供的方法名（manifest.methods 可以是 {名字: 说明} 或名字数组）。 */
export function methodNames(manifest) {
  const m = manifest.methods ?? []
  return Array.isArray(m) ? m : Object.keys(m)
}

/**
 * 检查一份设置并补全默认值。
 * @param tasks - oracle /tasks 返回的任务卡片列表
 * @param manifest - 决策模块的 manifest
 * @param setup - { task_id, method, rounds, batch_size }，都可以省略：
 *   task_id 只有一个任务时可省；method 省略用决策模块的默认方法；rounds / batch_size 省略用任务包的预算。
 * @returns { card, method（省略时为 null）, budget（生效的预算） }；有问题时抛 RunError，一次列出全部。
 */
export function checkSetup(tasks, manifest, setup = {}) {
  const { task_id, method = null, rounds, batch_size } = setup
  let card
  if (task_id === undefined || task_id === null) {
    if (tasks.length !== 1) throw new RunError(`有 ${tasks.length} 个任务包，要指定 task_id`)
    card = tasks[0]
  } else {
    card = tasks.find((t) => t.task_id === task_id)
    if (!card) throw new RunError(`没有 task_id 为 ${task_id} 的任务包；可选：${tasks.map((t) => t.task_id).join(', ')}`)
  }
  const problems = []
  let required = manifest.inputs?.required ?? []
  if (method !== null) {
    const names = methodNames(manifest)
    if (!names.includes(method)) problems.push(`决策模块没有方法 ${method}；可选：${names.join(', ')}`)
    required = manifest.requires?.[method] ?? []
  }
  const cards = card.data_cards ?? []
  const missing = required.filter((need) => !cards.some((dc) => dc.role === need.role && dc.modality === need.modality))
  if (missing.length) {
    problems.push(`决策模块${method ? `的方法 ${method}` : ` ${manifest.name}`} 需要的输入任务包里没有：${missing.map((x) => `${x.role}/${x.modality}`).join(', ')}`)
  }
  const budget = { ...card.budget }
  if (rounds !== undefined && rounds !== null) {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) problems.push(`rounds 要是 1–${MAX_ROUNDS} 的整数`)
    else budget.rounds = rounds
  }
  if (batch_size !== undefined && batch_size !== null) {
    if (!Number.isInteger(batch_size) || batch_size < 1 || batch_size > card.n_candidates) problems.push(`batch_size 要是 1–${card.n_candidates}（候选数）的整数`)
    else budget.batch_size = batch_size
  }
  if (problems.length) throw new RunError(problems.join('；'))
  return { card, method, budget }
}
