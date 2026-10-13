import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export class TaskLockError extends Error {
  constructor(message, owner = null) {
    super(message)
    this.owner = owner
  }
}

/**
 * Cross-process mutex for the one-task-at-a-time service boundary.
 * The lock lives outside runs/ so it does not add a public run-record file.
 */
export class TaskLock {
  constructor(scope) {
    const key = createHash('sha256').update(resolve(scope)).digest('hex').slice(0, 24)
    this.path = join(tmpdir(), `perturbpilot-${key}.lock`)
    this.fd = null
    this.token = null
  }

  acquire(sessionId) {
    if (this.fd !== null) throw new TaskLockError('当前进程已经持有 PerturbPilot 任务锁')
    const token = { pid: process.pid, session_id: sessionId, at: new Date().toISOString() }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.path, 'wx')
        writeFileSync(fd, JSON.stringify(token) + '\n', 'utf8')
        this.fd = fd
        this.token = token
        return token
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const owner = readOwner(this.path)
        if (owner && isProcessAlive(owner.pid)) {
          throw new TaskLockError(
            `另一个 PerturbPilot 进程正在运行任务${owner.session_id ? `（会话 ${owner.session_id}）` : ''}`,
            owner,
          )
        }
        try { unlinkSync(this.path) } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError
        }
      }
    }
    throw new TaskLockError('无法取得 PerturbPilot 任务锁')
  }

  release() {
    if (this.fd === null) return
    closeSync(this.fd)
    this.fd = null
    const current = readOwner(this.path)
    if (current?.pid === this.token?.pid && current?.session_id === this.token?.session_id && current?.at === this.token?.at) {
      try { unlinkSync(this.path) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    this.token = null
  }
}

function readOwner(path) {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
