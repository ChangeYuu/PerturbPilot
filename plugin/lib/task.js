// 任务卡片的几个通用读法：目标字段怎么取值、哪个方向算好、任务包里的候选列表。
// 卡片格式见 services/ppsvc/task.py；插件只读，不校验卡片本身（服务启动时已经校验过）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 目标值越低越好：minimize，或 hit_discovery 且 direction=low。 */
export function lowerIsBetter(objective) {
  return objective.kind === 'minimize' || (objective.kind === 'hit_discovery' && objective.direction === 'low')
}

/** 读数里目标字段的值；读数为空或值不是有限数时返回 null。 */
export function objectiveValue(readout, objective) {
  const v = readout?.[objective.field]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 目标的一句话说明，给简报和面板用。 */
export function objectiveText(objective) {
  const way = lowerIsBetter(objective) ? '越低越好' : '越高越好'
  const kind = objective.kind === 'hit_discovery' ? '找命中' : objective.kind === 'minimize' ? '求最小' : '求最大'
  return `${objective.description ?? kind}（看 ${objective.field}，${way}）`
}

/** 解析一段 CSV 文本（RFC 4180：逗号分隔、双引号转义）。 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** 任务包 candidates.csv 第一列的候选 id，按文件里的顺序。 */
export function readCandidateIds(packageDir) {
  const rows = parseCsv(readFileSync(join(packageDir, 'candidates.csv'), 'utf8').replace(/^﻿/, ''))
  if (rows[0]?.[0] !== 'id') throw new Error('candidates.csv must start with an id column')
  return rows.slice(1).map((r) => r[0])
}
