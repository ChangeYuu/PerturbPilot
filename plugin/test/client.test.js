// 浏览器面板测试。client.js 按 DSH 浏览器模块格式加载，平台的 react 用一个只会建元素树、单次渲染的最小替身；
// 被测的注册逻辑、视图渲染、以及面板和宿主路由之间的请求照常运行（路由是真实的 createPanelHandler）。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { PANEL_ROUTE, createPanelHandler, listRuns, panelView } from '../lib/panel.js'
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
  run = await Run.start({ dir: join(dir, 'sess-1'), runId: 'sess-1', services })
  run.markDriven(1)
  const d = await run.getDecision(services)
  await run.submitSelection({ accept: d.recommendations.map((x) => x.id), replace: [] }, services)
  run.updateHypothesis({ text: 'G001 附近值高', status: 'proposed', cites: [run.state.observations[0].id] })
  run.updateHypothesis({ id: 'H1', status: 'weakened', cites: [], rationale: '复测后不高了' })
  run.writeNote({ text: '第一条笔记', cites: [] })
  run.recordAnalysis({ id: 'A1', purpose: '算特征相关', exit_code: 0, timed_out: false, duration_ms: 40, dir: 'analysis/A1', files: ['fig.txt'] })
  const handler = createPanelHandler({
    getRun: (id) => (id === 'sess-1' ? run : undefined),
    control: (_id, action) => run.control(action, 'human'),
    listRuns: () => listRuns(dir),
    status: async () => ({
      config: { oracleUrl: 'http://127.0.0.1:8701', serviceTokenEnv: 'PERTURBPILOT_SERVICE_TOKEN', pythonTimeoutMs: 60000 },
      token_set: false,
      services: { oracle: { ok: true, task_id: 'fake-task', synthetic: true }, decision: { ok: false, error: 'decision /manifest failed: unreachable' } },
    }),
  })
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
  assert.equal(slots.length, 1 + exports.TOOL_NAMES.length + 6)
  assert.equal(slots[0].opts.name, 'sidebar.right.pane.tab')
  assert.equal(slots[0].opts.key, exports.PANEL_ID)
  assert.equal(slots[0].component, exports.PanelBody)
  // 同一会话拿到同一个 api 对象（轮询的 effect 不会因重渲染而重启），不同会话不同
  const a = slots[0].opts.inject('s1').api
  assert.equal(slots[0].opts.inject('s1').api, a)
  assert.notEqual(slots[0].opts.inject('s2').api, a)
  // 每个 pp_* 工具在对话区有自己的卡片，按工具名注册
  const views = slots.slice(1, 1 + exports.TOOL_NAMES.length)
  assert.ok(views.every((s) => s.opts.name === 'tool.call.toolview' && s.component === exports.ToolCard))
  assert.deepEqual(views.map((s) => s.opts.key).sort(), [
    'pp_control', 'pp_get_decision', 'pp_get_ledger', 'pp_run_python', 'pp_start_task', 'pp_submit_selection', 'pp_update_hypothesis', 'pp_write_note',
  ])
  // 主区的科学台账页、左侧栏入口（id 对上主区的 key）、设置页
  const [page, entry, settings, mark, name, hero] = slots.slice(1 + exports.TOOL_NAMES.length)
  assert.deepEqual([page.opts.name, page.opts.key, page.component], ['main', exports.LEDGER_ID, exports.LedgerPage])
  assert.deepEqual([entry.opts.name, entry.opts.id, entry.opts.label(), entry.component], ['sidebar.panellist', exports.LEDGER_ID, '科学台账', exports.PanelGlyph])
  assert.deepEqual([settings.opts.name, settings.opts.id, settings.opts.label(), settings.component], ['settings.section', exports.SETTINGS_ID, 'PerturbPilot', exports.SettingsSection])
  assert.equal(exports.PanelGlyph({ size: 18 }).props.width, 18)
  // 品牌位：左上角的图标和名字、新会话中间
  assert.deepEqual([mark, name, hero].map((s) => [s.opts.name, s.component]), [
    ['sidebar.brand.mark', exports.BrandMark], ['sidebar.brand.name', exports.BrandName], ['conversation.hero.brand.mark', exports.HeroBrand],
  ])
})

// 按 DSH 工具块的形状包一次调用：start 只有参数，result 带 call 和 content（插件工具的输出是 JSON 文本）。
function started(args) {
  return { phase: 'start', block: { callId: 'c1', argsRaw: JSON.stringify(args) } }
}
function settled(args, value, { isError = false, error } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { phase: 'result', block: { kind: 'tool-result', callId: 'c1', call: { argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text }], isError, error } }
}

test('tool cards show recommendations, replacements with reasons and readings from real tool results', async () => {
  const { exports } = loadClient(fakeReact())
  const card = (toolName, props) => exports.ToolCard({ toolName, callId: 'c1', ...props })
  const services = fakeServices()
  const d2 = mkdtempSync(join(tmpdir(), 'pp-card-'))
  try {
    const r = await Run.start({ dir: d2, runId: 's2', services })
    const decision = await r.getDecision(services)
    const tree = card('pp_get_decision', settled({}, decision))
    const all = text(tree)
    assert.match(all, /决策模块推荐/)
    assert.match(all, /第 1\/3 轮/)
    for (const x of decision.recommendations) assert.ok(all.includes(x.id))
    assert.equal(find(tree, (n) => n.type === 'tbody')[0].children.length, decision.recommendations.length)

    const ids = decision.recommendations.map((x) => x.id)
    const args = { accept: ids.slice(1), replace: [{ out: ids[0], in: 'G009', reason_type: 'exploration', reason: '看看 G009 那一带' }] }
    const running = text(card('pp_submit_selection', started(args)))
    assert.match(running, /进行中/)
    assert.match(running, new RegExp(`${ids[0]} → G009`))
    const result = await r.submitSelection(args, services)
    const done = text(card('pp_submit_selection', settled(args, result)))
    assert.match(done, /接受 2 个推荐，替换 1 个/)
    assert.match(done, /探索看看 G009 那一带/)
    for (const x of result.results) assert.ok(done.includes(String(x.value)))
    assert.match(done, /替换进来/)
    assert.match(done, /下一轮：第 2\/3 轮/)

    const hArgs = { text: 'G009 附近值高', status: 'proposed', cites: ['G009'], rationale: '第 1 轮读数' }
    const hyp = text(card('pp_update_hypothesis', settled(hArgs, r.updateHypothesis(hArgs))))
    assert.match(hyp, /H1/)
    assert.match(hyp, /提出/)
    assert.match(hyp, /依据 G009/)
    const nArgs = { text: '读数都偏低', cites: [] }
    assert.match(text(card('pp_write_note', settled(nArgs, r.writeNote(nArgs)))), /N1读数都偏低/)
  } finally {
    rmSync(d2, { recursive: true, force: true })
  }
})

test('tool cards show errors, interruptions and the preparing phase', () => {
  const { exports } = loadClient(fakeReact())
  const card = (toolName, props) => exports.ToolCard({ toolName, callId: 'c1', ...props })
  assert.match(text(card('pp_get_decision', { phase: 'preparing', block: { callId: 'c1' } })), /准备中/)
  const err = card('pp_submit_selection', settled({ accept: [] }, '既没有 accept 也没有被替换：G000', { isError: true }))
  assert.equal(err.props.className, 'pp-tool pp-tool-error')
  assert.match(text(err), /既没有 accept/)
  const stopped = card('pp_write_note', settled({ text: 'x', cites: [] }, [], { isError: true, error: { name: 'AbortError', code: 'interrupted' } }))
  assert.match(text(stopped), /已中断/)
  // 结果文本不是 JSON 时不报错，只是不显示结果部分
  assert.match(text(card('pp_control', settled({ action: 'pause' }, 'not json'))), /暂停/)
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

test('python card shows the purpose, the code, the output and failures', () => {
  const { exports } = loadClient(fakeReact())
  const card = (props) => exports.ToolCard({ toolName: 'pp_run_python', callId: 'c1', ...props })
  const args = { purpose: '算相关', code: 'print(0.42)' }
  const ok = card(settled(args, { id: 'A1', exit_code: 0, timed_out: false, stdout: '0.42\n', stderr: '', files: ['out/fig.txt'] }))
  const all = text(ok)
  assert.match(all, /Python 分析/)
  assert.match(all, /算相关/)
  assert.equal(text(find(ok, (n) => n.type === 'details')[0]), '代码print(0.42)')
  assert.match(all, /A1 · 完成 · 写出 out\/fig\.txt/)
  assert.match(all, /0\.42/)
  const failed = text(card(settled(args, { id: 'A2', exit_code: 1, timed_out: false, stdout: '', stderr: 'ValueError: 坏了', files: [] })))
  assert.match(failed, /出错（退出码 1）/)
  assert.match(failed, /ValueError: 坏了/)
  assert.match(text(card(settled(args, { id: 'A3', exit_code: null, timed_out: true, stdout: '', stderr: '', files: [] }))), /超时，已停止/)
})

test('ledger page renders the run list and the whole record of the selected run', () => {
  const { exports } = loadClient(fakeReact())
  const render = (props) => exports.renderLedger({ error: null, busy: false, onSelect: () => {}, onControl: () => {}, ...props })
  assert.match(text(render({ runs: undefined, selected: null })), /加载中/)
  assert.match(text(render({ runs: [], selected: null })), /还没有任务/)

  const runs = listRuns(dir)
  const view = panelView(run)
  const picked = []
  const tree = render({ runs, selected: 'sess-1', view, onSelect: (id) => picked.push(id) })
  const all = text(tree)
  assert.match(all, /科学台账/)
  assert.match(all, /测试任务/)

  // 总览：目标、当前最佳、已测数量、改推荐的比例、审计
  const best = view.observations[0]
  assert.match(all, new RegExp(`目标：在 ${view.task.n_candidates} 个候选里找出`))
  assert.match(all, new RegExp(`当前最佳${best.id} = ${best.value}第 1 轮测到`))
  assert.match(all, new RegExp(`已测3 / ${view.task.n_candidates}`))
  assert.match(all, /agent 改了推荐0 \/ 3占 0%/)
  assert.match(all, /审计全部通过/)
  // 进展图每个读数一个点，本轮新的最佳单独标出
  const dots = find(tree, (n) => n.type === 'circle')
  assert.equal(dots.length, 3)
  assert.equal(dots.filter((n) => n.props.className === 'pp-dot pp-dot-best').length, 1)

  // 当前结论：假设的最新状态和演变
  assert.match(all, /当前结论（1 条假设）/)
  assert.match(all, /H1削弱第 2 轮提出 · 更新 1 次/)
  assert.match(all, /看它是怎么变过来的/)

  // 逐轮：每轮一张卡片；第 1 轮有推荐、提交、读数条和回执，第 2 轮有本轮的分析、假设和笔记
  const cards = find(tree, (n) => n.type === 'article')
  assert.equal(cards.length, 2)
  const [r1, r2] = cards.map(text)
  for (const id of view.rounds[0].recommendations) assert.ok(r1.includes(id))
  assert.match(r1, /全部接受推荐/)
  assert.equal(find(cards[0], (n) => n.props.className === 'pp-bar-row').length, 3)
  assert.match(r1, new RegExp(`${best.id}.*${best.value}新的最佳`))
  assert.match(r1, /决策模块收下 3 条读数，状态版本 0 → 1/)
  assert.match(r1, /✓ 调用决策模块/)
  assert.match(r2, /还没有向决策模块要推荐/)
  assert.match(r2, /分析A1 算特征相关 · 完成 · analysis\/A1 · 写出 fig\.txt/)
  assert.match(r2, /提出假设H1 提出G001 附近值高/)
  assert.match(r2, /更新假设H1 削弱复测后不高了/)
  assert.match(r2, /笔记N1 第一条笔记/)
  assert.match(r2, /还没提交/)

  // 全部读数和事件日志折叠在最后
  const folds = find(tree, (n) => n.props.className === 'pp-fold')
  assert.deepEqual(folds.map((n) => text(n.children[0])), ['全部读数排名（3 条）', `事件日志（最近 ${view.events.length} 条）`])

  // 列表项可点
  const items = find(tree, (n) => n.type === 'button' && n.props.className?.startsWith?.('pp-run'))
  assert.equal(items.length, 1)
  assert.equal(items[0].props.className, 'pp-run pp-run-active')
  items[0].props.onClick()
  assert.deepEqual(picked, ['sess-1'])
  assert.match(text(render({ runs, selected: 'sess-1', view: undefined })), /加载中/)
  assert.match(text(render({ runs, selected: 'sess-1', view: null, error: 'HTTP 500' })), /出错了：HTTP 500.*读不到/)
})

test('ledger replacement reasons show up in the rounds table', async () => {
  const { exports } = loadClient(fakeReact())
  const services = fakeServices()
  const d2 = mkdtempSync(join(tmpdir(), 'pp-ledger-'))
  try {
    const r = await Run.start({ dir: d2, runId: 's3', services })
    const ids = (await r.getDecision(services)).recommendations.map((x) => x.id)
    await r.submitSelection({ accept: ids.slice(1), replace: [{ out: ids[0], in: 'G009', reason_type: 'hypothesis_test', reason: '检验 H1' }] }, services)
    const all = text(exports.renderLedger({ runs: listRuns(d2), selected: 's3', view: panelView(r), onSelect: () => {}, onControl: () => {} }))
    assert.match(all, new RegExp(`${ids[0]} → G009`))
    assert.match(all, /检验 H1/)
  } finally {
    rmSync(d2, { recursive: true, force: true })
  }
})

test('settings page shows service reachability, the token and the config', () => {
  const { exports } = loadClient(fakeReact())
  assert.match(text(exports.renderSettings({ status: undefined })), /加载中/)
  const status = {
    config: { oracleUrl: 'http://127.0.0.1:8701', serviceTokenEnv: 'PERTURBPILOT_SERVICE_TOKEN', pythonTimeoutMs: 60000 },
    token_set: false,
    services: { oracle: { ok: true, task_id: 'fake-task', synthetic: true }, decision: { ok: false, error: 'unreachable' } },
  }
  const refreshed = []
  const tree = exports.renderSettings({ status, error: null, onRefresh: () => refreshed.push(1) })
  const all = text(tree)
  assert.match(all, /oracle：连得上 fake-task（合成数据）/)
  assert.match(all, /决策模块：连不上：unreachable/)
  assert.match(all, /没设.*PERTURBPILOT_SERVICE_TOKEN/)
  assert.match(all, /oracle 服务地址oracleUrlhttp:\/\/127\.0\.0\.1:8701/)
  assert.match(all, /决策模块服务地址decisionUrl—/)
  find(tree, (n) => n.type === 'button')[0].props.onClick()
  assert.deepEqual(refreshed, [1])
  const set = text(exports.renderSettings({ status: { ...status, token_set: true, services: { decision: { ok: true, name: 'gp-ucb', version: '0.1' } } } }))
  assert.match(set, /已设（PERTURBPILOT_SERVICE_TOKEN）/)
  assert.match(set, /决策模块：连得上 gp-ucb 0\.1/)
})

test('ledger page and settings section talk to the real host routes', async () => {
  const react = fakeReact()
  const { exports } = loadClient(react)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => originalFetch(new URL(url, base), init)
  try {
    const updates = []
    react.useState = (initial) => [initial, (v) => updates.push(v)]
    assert.match(text(exports.LedgerPage()), /加载中/)
    // 先只有任务列表的轮询（还没选中任务，视图的轮询不启动）
    assert.equal(react.effects.length, 2)
    const stops = react.effects.map((fn) => fn())
    await new Promise((r) => setTimeout(r, 100))
    stops.forEach((stop) => stop?.())
    const list = updates.find(Array.isArray)
    assert.deepEqual(list.map((x) => [x.run_id, x.title]), [['sess-1', '测试任务']])

    react.effects.length = 0
    updates.length = 0
    exports.SettingsSection({ close: () => {} })
    assert.equal(react.effects.length, 1)
    react.effects[0]()
    await new Promise((r) => setTimeout(r, 100))
    const status = updates.find((v) => v && v.services)
    assert.equal(status.services.oracle.task_id, 'fake-task')
    assert.equal(status.token_set, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('brand pieces crop the mark and the name out of the one logo image', () => {
  const { exports } = loadClient(fakeReact())
  const [box] = [exports.BrandMark({ size: 24 })]
  assert.deepEqual(box.props.style, { width: '24px', height: '24px' })
  // 螺旋在原图里是 205×278（从 1,11 开始），按高 24 显示
  const k = 24 / 278
  const mark = box.children[0].props.style
  assert.equal(mark.height, '24px')
  assert.equal(mark.width, `${205 * k}px`)
  assert.equal(mark.backgroundImage, 'url("/perturbpilot/api/logo")')
  assert.equal(mark.backgroundSize, `${1753 * k}px ${307 * k}px`)
  assert.equal(mark.backgroundPosition, `${-1 * k}px ${-11 * k}px`)
  // 名字只取 DeepAutonomy 字样那一块
  const name = exports.BrandName().props.style
  assert.equal(name.height, '15px')
  const n = 15 / 182
  assert.equal(name.backgroundPosition, `${-267 * n}px ${-70 * n}px`)
  // 新会话中间：螺旋加两行字
  const hero = exports.HeroBrand()
  assert.equal(hero.children[0].props.style.height, '56px')
  assert.deepEqual(find(hero, (n) => n.props.className?.startsWith?.('pp-hero-')).slice(1).map(text), ['PerturbPilot', '提出假设 · 挑选实验 · 从每一轮读数里学习'])
})
