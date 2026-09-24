import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { installFetchCapture } from '../lib/capture.js'

let server
let base
before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-secret-response-header', 'should-not-be-stored')
      res.end(JSON.stringify({ echo: body ? JSON.parse(body) : null }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

test('matching calls are recorded without headers or query; others are not', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  const capture = installFetchCapture({ pattern: '/llm/', onCall: (c) => calls.push(c) })
  try {
    assert.equal(capture.original, originalFetch)
    const res = await fetch(`${base}/llm/chat?key=secret-in-query`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    })
    const json = await res.json() // 调用方照常拿到完整响应
    assert.equal(json.echo.messages[0].content, '你好')
    await fetch(`${base}/other`)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.url, `${base}/llm/chat`)
    assert.equal(call.status, 200)
    assert.deepEqual(call.request, { kind: 'json', body: { messages: [{ role: 'user', content: '你好' }] } })
    assert.equal(call.response.body.echo.messages[0].content, '你好')
    const serialized = JSON.stringify(call)
    assert.ok(!serialized.includes('sk-test-secret'))
    assert.ok(!serialized.includes('secret-in-query'))
    assert.ok(!serialized.includes('should-not-be-stored'))
  } finally {
    capture.uninstall()
  }
  assert.equal(globalThis.fetch, originalFetch)
})

test('network failures are recorded and rethrown', async () => {
  const calls = []
  const capture = installFetchCapture({ pattern: '127\\.0\\.0\\.1:1/', onCall: (c) => calls.push(c) })
  try {
    await assert.rejects(fetch('http://127.0.0.1:1/llm'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].status, null)
    assert.ok(calls[0].error)
  } finally {
    capture.uninstall()
  }
})
