// 调用决策模块和 oracle 两个 HTTP 服务。用插件安装抓取之前保存下来的原始 fetch，避免把这些调用混进模型调用记录。

export class ServiceError extends Error {
  constructor(service, path, status, message) {
    super(`${service} ${path} failed${status ? ` (${status})` : ''}: ${message}`)
    this.service = service
    this.path = path
    this.status = status
  }
}

export function createServices({ oracleUrl, decisionUrl, fetch = globalThis.fetch, timeoutMs = 30000 }) {
  async function call(service, base, method, path, body, signal) {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)
    let response
    try {
      response = await fetch(new URL(path, base), {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      })
    } catch (error) {
      throw new ServiceError(service, path, 0, `unreachable at ${base} (${error?.message ?? error})`)
    }
    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new ServiceError(service, path, response.status, `non-JSON response: ${text.slice(0, 200)}`)
    }
    if (!response.ok) throw new ServiceError(service, path, response.status, data?.error ?? text.slice(0, 200))
    return data
  }
  const oracle = (method, path, body, signal) => call('oracle', oracleUrl, method, path, body, signal)
  const decision = (method, path, body, signal) => call('decision', decisionUrl, method, path, body, signal)
  return {
    task: (signal) => oracle('GET', '/task', undefined, signal),
    run: (body, signal) => oracle('POST', '/run', body, signal),
    resetOracle: (body, signal) => oracle('POST', '/reset', body, signal),
    manifest: (signal) => decision('GET', '/manifest', undefined, signal),
    propose: (body, signal) => decision('POST', '/propose', body, signal),
    observe: (body, signal) => decision('POST', '/observe', body, signal),
    snapshot: (signal) => decision('GET', '/snapshot', undefined, signal),
    restore: (body, signal) => decision('POST', '/restore', body, signal),
  }
}
