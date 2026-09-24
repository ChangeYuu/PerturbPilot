// 浏览器面板测试。client.js 按 DSH 浏览器模块格式加载，平台的 react 用一个只会建元素树、单次渲染的最小替身；
// 被测的注册逻辑、视图渲染、以及面板和宿主路由之间的请求照常运行（路由是真实的 createPanelHandler）。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { PANEL_ROUTE, createPanelHandler, panelView } from '../lib/panel.js'
import { Run } from '../lib/run.js'
import { fakeServices } from './fake-services.js'

// 最小 react：createElement 建树；hooks 只支持一次渲染（effect 收集起来由测试决定是否执行）。
function fakeReact() {
  const effects = []
  return {
    effects,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [initial, () => {}],
    useEffect: (fn) => effects.push(fn),
    useCallback: (fn) => fn,
  }
}

function loadClient(react) {
  let spec
  const window = { __ModuleLoader__: { load: (s) => (spec = s) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  const require = (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }
  return { id: spec.id, exports: spec.factory(require) }
}

function text(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return node.children.map(text).join('')
}

function find(node, pred, out = []) {
  if (node && typeof node === 'object') {
    if (pred(node)) out.push(node)
    for (const c of node.children) find(c, pred, out)
  }
  return out
}

let dir
let run
let server
let base
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pp-client-'))
  const services = fakeServices()
  run = await Run.start({ dir, runId: 'sess-1', services })
  run.markDriven(1)
  const d = await run.getDecision(services)
  await run.submitSelection({ accept: d.recommendations.map((x) => x.id), replace: [] }, services)
  run.updateHypothesis({ text: 'G001 附近值高', status: 'proposed', cites: [run.state.observations[0].id] })
  const handler = createPanelHandler({ getRun: (id) => (id === 'sess-1' ? run : undefined), control: (_id, action) => run.control(action, 'human') })
  server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

test('bundle registers under the package name with a page tab type and a session-scoped body', () => {
  const { id, exports } = loadClient(fakeReact())
  assert.equal(id, 'perturbpilot')
  assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs'])

  const types = []
  const slots = []
  const ctx = {
    effect: (fn) => fn(),
    sidebarRightTabs: { register: (def) => (types.push(def), () => {}) },
    slots: { inject: (_name, fn) => fn(), register: (opts, component) => (slots.push({ opts, component }), () => {}) },
  }
  exports.apply(ctx)
  assert.equal(types.length, 1)
  assert.equal(types[0].id, exports.PANEL_ID)
  assert.equal(types[0].kind, 'perturbpilot')
  assert.equal(types[0].patterns, undefined) // 页面型 tab，按 kind 打开
  assert.equal(types[0].title(), 'PerturbPilot')
  assert.equal(types[0].guide.length, 1)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].opts.name, 'sidebar.right.pane.tab')
  assert.equal(slots[0].opts.key, exports.PANEL_ID)
  assert.equal(slots[0].component, exports.PanelBody)
  // 同一会话拿到同一个 api 对象（轮询的 effect 不会因重渲染而重启），不同会话不同
  const a = slots[0].opts.inject('s1').api
  assert.equal(slots[0].opts.inject('s1').api, a)
  assert.notEqual(slots[0].opts.inject('s2').api, a)
})

test('panel renders loading, empty, error and full states', () => {
  const { exports } = loadClient(fakeReact())
  const render = (props) => exports.renderPanel({ busy: false, error: null, onControl: () => {}, ...props })
  assert.match(text(render({ view: undefined })), /加载中/)
  assert.match(text(render({ view: null })), /还没有开始任务/)
  assert.match(text(render({ view: null, error: 'HTTP 500' })), /出错了：HTTP 500/)

  const view = panelView(run)
  const tree = render({ view })
  const all = text(tree)
  assert.match(all, /测试任务/)
  assert.match(all, /合成数据/)
  assert.match(all, /进行中/)
  assert.match(all, /第 2\/3 轮/)
  assert.match(all, /G001 附近值高/)
  for (const r of view.rounds[0].results) assert.ok(all.includes(`${r.id}=${r.value}`))
  // 第 1 轮前三项审计通过
  const marks = find(tree, (n) => n.props.className?.startsWith?.('pp-check '))
  assert.equal(marks.length, view.rounds.length * 5)
  assert.deepEqual(marks.slice(0, 3).map((n) => n.props.className), ['pp-check pp-pass', 'pp-check pp-pass', 'pp-check pp-pass'])

  const actions = []
  const buttons = find(render({ view, onControl: (a) => actions.push(a) }), (n) => n.type === 'button')
  assert.deepEqual(buttons.map(text), ['暂停', '结束任务'])
  buttons[0].props.onClick()
  assert.deepEqual(actions, ['pause'])
  const busy = find(render({ view, busy: true }), (n) => n.type === 'button')
  assert.ok(busy.every((b) => b.props.disabled))
})

test('panel body talks to the real host route: poll, then pause', async () => {
  const react = fakeReact()
  const { exports } = loadClient(react)
  const slots = []
  exports.apply({
    effect: (fn) => fn(),
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_n, fn) => fn(), register: (opts) => (slots.push(opts), () => {}) },
  })
  const { api } = slots[0].inject('sess-1')
  // 浏览器里是同源相对路径；Node 的 fetch 需要绝对地址，这里只补上 origin，请求照常发给真实路由。
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => originalFetch(new URL(url, base), init)
  try {
    const got = await api.get()
    assert.equal(got.run.status, 'active')
    assert.equal(got.run.run_id, 'sess-1')
    const paused = await api.control('pause')
    assert.equal(paused.run.status, 'paused')
    await assert.rejects(api.control('pause').then(() => api.control('stop')).then(() => api.control('resume')), /不能再操作/)

    const missing = slots[0].inject('nobody').api
    assert.equal((await missing.get()).run, null)
    await assert.rejects(missing.control('pause'), /还没有开始任务/)

    // 组件本身：一次渲染 + 执行它登记的轮询 effect，拿到的数据经 setState 送出
    const updates = []
    react.useState = (initial) => [initial, (v) => updates.push(v)]
    react.effects.length = 0
    const tree = exports.PanelBody({ useTabInfo: () => ({ tab: { visible: true } }), api })
    assert.match(text(tree), /加载中/)
    assert.equal(react.effects.length, 1)
    const cleanup = react.effects[0]()
    await new Promise((r) => setTimeout(r, 100))
    cleanup()
    assert.ok(updates.some((v) => v && v.run_id === 'sess-1' && v.status === 'stopped'))
  } finally {
    globalThis.fetch = originalFetch
  }
})
