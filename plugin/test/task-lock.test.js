import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskLock, TaskLockError } from '../lib/task-lock.js'

test('task lock prevents a second process scope from starting concurrently', () => {
  const scope = join(tmpdir(), `pp-lock-test-${process.pid}-${Date.now()}`)
  const first = new TaskLock(scope)
  const second = new TaskLock(scope)
  first.acquire('session-a')
  assert.throws(() => second.acquire('session-b'), (error) => {
    assert.ok(error instanceof TaskLockError)
    assert.match(error.message, /session-a/)
    return true
  })
  first.release()
  second.acquire('session-b')
  second.release()
})

test('task lock removes a stale owner record', () => {
  const scope = join(tmpdir(), `pp-lock-stale-${process.pid}-${Date.now()}`)
  const lock = new TaskLock(scope)
  const fd = openSync(lock.path, 'w')
  writeFileSync(fd, JSON.stringify({ pid: 999999999, session_id: 'stale' }) + '\n', 'utf8')
  closeSync(fd)
  lock.acquire('session-live')
  assert.equal(existsSync(lock.path), true)
  lock.release()
  assert.equal(existsSync(lock.path), false)
  try { unlinkSync(lock.path) } catch {}
})
