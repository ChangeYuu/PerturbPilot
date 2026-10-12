// 抓取发往模型服务的原始 HTTP 请求和响应。
// 做法：替换全局 fetch，URL 命中 pattern 的调用在不耽误响应交付的前提下复制一份正文落盘。
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
    // DSH consumes streaming responses and may abort the response after the
    // turn has completed. Cloning here and reading the clone later races with
    // that lifecycle, which turns a successful HTTP response into a spurious
    // "This operation was aborted" model-call error. Tee the body before the
    // caller can consume it so the recorder owns an independent branch.
    if (!response.body) {
      emit({
        startedAt,
        url,
        method: request.method,
        requestText,
        status: response.status,
        responseText: '',
        error: response.ok === false ? 'HTTP ' + response.status : null,
      })
      return response
    }
    if (typeof response.body.tee !== 'function') {
      emit({
        startedAt,
        url,
        method: request.method,
        requestText,
        status: response.status,
        error: response.ok === false ? 'HTTP ' + response.status : null,
        recordError: 'response body does not support tee; response body was not recorded',
      })
      return response
    }

    // The real fetch implementation exposes a WHATWG reader. Keep a small
    // tee fallback for host/test response shims that only implement tee().
    if (typeof response.body.getReader !== 'function') {
      const [callerBody, captureBody] = response.body.tee()
      const callerResponse = new Response(callerBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      new Response(captureBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }).text().then(
        (responseText) => emit({ startedAt, url, method: request.method, requestText, status: response.status, responseText, error: response.ok === false ? 'HTTP ' + response.status : null }),
        (error) => emit({
          startedAt,
          url,
          method: request.method,
          requestText,
          status: response.status,
          error: response.ok === false ? 'HTTP ' + response.status : null,
          recordError: response.ok && isExpectedStreamAbort(error) ? null : String(error?.message ?? error),
        }),
      )
      return callerResponse
    }

    // Preserve native text/event-stream Responses for DSH. Reconstructing a
    // Response around a wrapped SSE stream is not compatible with every DSH
    // stream reader;
    // the request, HTTP status, and the durable DSH/session trace remain
    // recorded here while the caller owns the original body.
    const contentType = response.headers.get('content-type') ?? ''
    if (/text\/event-stream/i.test(contentType)) {
      emit({
        startedAt,
        url,
        method: request.method,
        requestText,
        status: response.status,
        error: response.ok === false ? 'HTTP ' + response.status : null,
      })
      return response
    }

    // Put the recorder in a pass-through reader instead of teeing the body.
    // DSH is the sole consumer of the provider stream; a second consumer can
    // perturb cancellation/backpressure at exactly the point where a turn
    // finishes. The pass-through preserves the bytes and ordering delivered to
    // DSH while recording whatever was actually observed.
    let reader
    let settled = false
    const chunks = []
    const finishCapture = (recordError = null) => {
      if (settled) return
      settled = true
      emit({
        startedAt,
        url,
        method: request.method,
        requestText,
        status: response.status,
        responseText: decodeChunks(chunks),
        error: response.ok === false ? 'HTTP ' + response.status : null,
        recordError: response.ok && isExpectedStreamAbortMessage(recordError) ? null : recordError,
      })
    }
    const callerBody = new ReadableStream({
      start(controller) {
        reader = response.body.getReader()
        void (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read()
              if (done) {
                finishCapture()
                controller.close()
                return
              }
              chunks.push(toUint8Array(value))
              controller.enqueue(value)
            }
          } catch (error) {
            const message = String(error?.message ?? error)
            finishCapture(message)
            controller.error(error)
          }
        })()
      },
      cancel(reason) {
        void reader?.cancel(reason)
        finishCapture(String(reason?.message ?? reason ?? 'stream cancelled'))
      },
    })
    return new Response(callerBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  function emit({ startedAt, url, method, requestText, status, responseText, error, recordError }) {
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
        record_error: recordError ?? null,
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

function isExpectedStreamAbort(error) {
  return isExpectedStreamAbortMessage(error)
}

function isExpectedStreamAbortMessage(error) {
  const message = String(error?.message ?? error)
  return error?.name === 'AbortError' || message === 'This operation was aborted' || message === 'The operation was aborted'
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value)
}

function decodeChunks(chunks) {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
