// agent 的分析工具：在运行目录里跑一段 Python，读框架导出的读数表，结论拿回来写假设或笔记。
// 每次调用一个目录 runs/<run_id>/analysis/A<N>/：code.py、导出的输入（observations.csv、candidates.csv、
// 最近一次推荐的 decision.csv、任务包里公开的数据文件 data/…）、stdout.txt、stderr.txt，以及脚本自己写出的文件。
// 子进程的环境变量只留白名单里的几项，所以拿不到服务令牌和模型密钥，
// 没法绕过框架直接调 oracle 或决策模块。Windows 上没有沙箱，子进程仍能读盘上的文件。

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RunError } from './run.js'

const ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG',
]
const FIXED = ['code.py', 'stdout.txt', 'stderr.txt']
const MAX_SAVED = 1 << 20 // stdout / stderr 各自最多落盘这么多字符
const MAX_RETURNED = 6000 // 返回给模型的 stdout / stderr 各自最多这么多字符
const MAX_FILES = 50

/** 子进程的环境：只从白名单里取，再强制 UTF-8 输出。 */
export function childEnv(source = process.env) {
  const env = {}
  for (const key of ENV_ALLOW) if (source[key] !== undefined) env[key] = source[key]
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  return env
}

/** 配置里的 Python 路径：带目录的相对路径按启动目录解析，裸命令名交给 PATH。 */
export function resolvePython(pythonPath, cwd = process.cwd()) {
  if (isAbsolute(pythonPath) || !/[\\/]/.test(pythonPath)) return pythonPath
  return resolve(cwd, pythonPath)
}

function csvCell(x) {
  const s = String(x ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

function csv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

/**
 * 把分析要用的输入导出到 dir，返回导出的文件（相对 dir，用 /）。
 * observations.csv 每次测量一行：id、round、replicate，加上读数的每个字段（空读数留空）。
 */
export function writeInputs(run, dir) {
  const written = []
  const put = (rel, text) => {
    writeFileSync(join(dir, rel), text, 'utf8')
    written.push(rel)
  }
  const fields = run.state.task.readout.fields.map((f) => f.name)
  const obs = run.state.observations
  put('observations.csv', csv(['id', 'round', 'replicate', ...fields], obs.map((o) => [o.id, o.round, o.replicate, ...fields.map((f) => o.readout?.[f])])))

  const pkg = run.state.task.package_dir
  copyFileSync(join(pkg, 'candidates.csv'), join(dir, 'candidates.csv'))
  written.push('candidates.csv')
  for (const dc of run.state.task.data_cards ?? []) {
    if (dc.visibility !== 'public') continue
    const parts = dc.file.split(/[\\/]/).filter((x) => x && x !== '.' && x !== '..')
    if (parts[0] === 'data') parts.shift()
    const rel = ['data', ...parts].join('/')
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    copyFileSync(join(pkg, dc.file), join(dir, rel))
    written.push(rel)
  }

  // 最近一次推荐的整个候选池：决策模块对每个候选的打分（方法不同，列不同）。
  const file = run.latestProposalFile()
  const pool = file ? run.recorder.readJson(file)?.pool : null
  if (pool?.length) {
    const cols = [...new Set(pool.flatMap((x) => Object.keys(x)))].filter((k) => k !== 'id' && k !== 'measured')
    put('decision.csv', csv(['id', 'measured', ...cols], pool.map((x) => [x.id, x.measured, ...cols.map((k) => x[k])])))
  }
  return written
}

function claimDir(root) {
  mkdirSync(root, { recursive: true })
  for (let n = readdirSync(root).length + 1; ; n++) {
    const id = `A${n}`
    try {
      mkdirSync(join(root, id))
      return { id, dir: join(root, id) }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

function listOutputs(dir, inputs) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (out.length >= MAX_FILES) return
      const path = join(d, name)
      if (statSync(path).isDirectory()) walk(path)
      else {
        const rel = relative(dir, path).split(sep).join('/')
        if (!inputs.has(rel)) out.push(rel)
      }
    }
  }
  walk(dir)
  return out.sort()
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（截断，共 ${text.length} 字符）`
}

function exec({ python, dir, timeoutMs, signal, env }) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError = null
    const child = spawn(python, ['-X', 'utf8', 'code.py'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const kill = () => child.kill()
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.stdout.setEncoding('utf8').on('data', (c) => (stdout = (stdout + c).slice(0, MAX_SAVED)))
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr = (stderr + c).slice(0, MAX_SAVED)))
    child.on('error', (error) => (spawnError = error))
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      resolvePromise({ code, stdout, stderr, timedOut, spawnError, durationMs: Date.now() - started })
    })
  })
}

/**
 * 跑一次分析。只在任务进行中可用；记一条 analysis/executed 事件。
 * @param options.python - Python 可执行文件（已解析）
 * @param options.timeoutMs - 超时就杀掉子进程
 */
export async function runAnalysis(run, { code, purpose }, { python, timeoutMs, signal, env = childEnv() }) {
  run.requireOpen()
  if (!code?.trim()) throw new RunError('code 不能为空')
  if (!purpose?.trim()) throw new RunError('purpose 不能为空：写一句这段分析要回答什么')
  const { id, dir } = claimDir(join(run.recorder.dir, 'analysis'))
  writeFileSync(join(dir, 'code.py'), code, 'utf8')
  const inputs = new Set([...FIXED, ...writeInputs(run, dir)])
  const r = await exec({ python, dir, timeoutMs, signal, env })
  if (r.spawnError) r.stderr += `${r.stderr ? '\n' : ''}无法启动 Python（${python}）：${r.spawnError.message}`
  writeFileSync(join(dir, 'stdout.txt'), r.stdout, 'utf8')
  writeFileSync(join(dir, 'stderr.txt'), r.stderr, 'utf8')
  const files = listOutputs(dir, inputs)
  const exitCode = r.spawnError ? null : r.code
  run.recordAnalysis({
    id,
    purpose,
    exit_code: exitCode,
    timed_out: r.timedOut,
    duration_ms: r.durationMs,
    dir: `analysis/${id}`,
    files,
  })
  return {
    id,
    exit_code: exitCode,
    timed_out: r.timedOut,
    stdout: clip(r.stdout, MAX_RETURNED),
    stderr: clip(r.stderr, MAX_RETURNED),
    files,
  }
}
