// 抓取发往模型服务的原始 HTTP 请求和响应。
// 做法：替换全局 fetch，URL 命中 pattern 的调用在不耽误响应交付的前提下克隆一份正文落盘。
// 请求头和响应头一律不记录（密钥在请求头里）；URL 只保留 origin + pathname。

export function installFetchCapture({ pattern, onCall, logger }) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  if (!descriptor || typeof descriptor.value !== 'function') {
    logger?.warn?.('perturbpilot: global fetch is not a plain value; model call capture disabled')
    return { original: globalThis.fetch, uninstall() {} }
  }
  const original = descriptor.value
  const matcher = new RegExp(pattern)

  async function capturingFetch(input, init) {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (!matcher.test(url.href)) return Reflect.apply(original, globalThis, [request])

    const startedAt = Date.now()
    const requestText = request.body === null ? null : await request.clone().text()
    let response
    try {
      response = await Reflect.apply(original, globalThis, [request])
    } catch (error) {
      emit({ startedAt, url, method: request.method, requestText, error: String(error?.message ?? error) })
      throw error
    }
    const copy = response.clone()
    copy.text().then(
      (responseText) => emit({ startedAt, url, method: request.method, requestText, status: response.status, responseText }),
      (error) => emit({ startedAt, url, method: request.method, requestText, status: response.status, error: String(error?.message ?? error) }),
    )
    return response
  }

  function emit({ startedAt, url, method, requestText, status, responseText, error }) {
    try {
      onCall({
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Date.now() - startedAt,
        url: url.origin + url.pathname,
        method,
        status: status ?? null,
        request: parseMaybeJson(requestText),
        response: responseText === undefined ? null : parseMaybeJson(responseText),
        error: error ?? null,
      })
    } catch (e) {
      logger?.warn?.(`perturbpilot: failed to record model call: ${e?.message ?? e}`)
    }
  }

  globalThis.fetch = capturingFetch
  return {
    original,
    uninstall() {
      if (globalThis.fetch === capturingFetch) globalThis.fetch = original
    },
  }
}

function parseMaybeJson(text) {
  if (text === null || text === undefined) return null
  try {
    return { kind: 'json', body: JSON.parse(text) }
  } catch {
    return { kind: 'text', body: text }
  }
}
