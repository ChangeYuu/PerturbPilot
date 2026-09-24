// 运行目录 runs/<run_id>/ 的落盘：事件流、模型调用记录、决策模块与 oracle 的原始往返、状态快照。
// 所有文本都是 UTF-8、换行 \n、JSON 不转义中文。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const EVENT_SOURCES = ['framework', 'model', 'environment', 'human', 'decision']

export class RunRecorder {
  constructor(dir, runId) {
    this.dir = dir
    this.runId = runId
    mkdirSync(join(dir, 'decision'), { recursive: true })
    mkdirSync(join(dir, 'oracle'), { recursive: true })
    this.seq = lastSeq(join(dir, 'events.jsonl'))
    this.llmSeq = lastSeq(join(dir, 'llm_calls.jsonl'))
  }

  event(type, source, round, data = {}) {
    if (!EVENT_SOURCES.includes(source)) throw new Error(`unknown event source ${source}`)
    const record = { seq: ++this.seq, ts: new Date().toISOString(), run_id: this.runId, round, type, source, data }
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(record) + '\n', 'utf8')
    return record
  }

  llmCall(record) {
    const line = { seq: ++this.llmSeq, run_id: this.runId, ...record }
    appendFileSync(join(this.dir, 'llm_calls.jsonl'), JSON.stringify(line) + '\n', 'utf8')
    return line
  }

  writeJson(relPath, value) {
    const path = join(this.dir, relPath)
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  }

  readJson(relPath) {
    const path = join(this.dir, relPath)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
  }
}

export function roundFile(kind, round) {
  return `${String(round).padStart(2, '0')}-${kind}.json`
}

function lastSeq(path) {
  if (!existsSync(path)) return 0
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  return lines.length === 0 ? 0 : JSON.parse(lines[lines.length - 1]).seq
}
