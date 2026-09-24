// PerturbPilot 的浏览器面板：DSH web 端右侧栏的一个页面型 tab，显示当前会话里这次任务的状态，
// 并提供暂停 / 继续 / 结束。数据来自宿主侧挂在同源 web 服务上的 /perturbpilot/api（见 lib/panel.js）。
// 不经过构建：直接按 DSH 浏览器模块的注册格式手写，只用平台自带的 react。
window.__ModuleLoader__.load({
	id: "perturbpilot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		const PANEL_ID = "perturbpilot/panel";
		const PANEL_KIND = "perturbpilot";
		const API = "/perturbpilot/api";
		const POLL_MS = 2000;

		const STATUS_TEXT = { active: "进行中", paused: "已暂停", stopped: "已结束", finished: "已完成" };
		const CONTROL_TEXT = { pause: "暂停", resume: "继续", stop: "结束任务" };
		const CHECKS = [
			["decision_called", "调用决策模块"],
			["selection_submitted", "提交选择"],
			["receipt_complete", "回执完整"],
			["state_carried", "状态衔接"],
			["cited_later", "后续引用"],
		];
		const RESULT_MARK = { pass: "✓", fail: "✗", pending: "…", "n/a": "–" };
		const REASON_TEXT = { hypothesis_test: "检验假设", exploration: "探索", data_quality: "复测", other: "其他" };
		const HYPOTHESIS_TEXT = { proposed: "提出", supported: "支持", weakened: "削弱", rejected: "否定" };

		// ---- 数据 ----

		async function parse(res) {
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
			return body;
		}

		function createApi(sessionId) {
			const base = `${API}/sessions/${encodeURIComponent(sessionId)}`;
			return {
				get: (signal) => fetch(base, { signal, cache: "no-store" }).then(parse),
				control: (action) => fetch(`${base}/control`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-perturbpilot": "1" },
					body: JSON.stringify({ action }),
				}).then(parse),
			};
		}

		// 每个会话一个 api 对象，保证身份稳定，轮询的 effect 不会因为重渲染而重启。
		const apis = new Map();
		function apiFor(sessionId) {
			if (!apis.has(sessionId)) apis.set(sessionId, createApi(sessionId));
			return apis.get(sessionId);
		}

		// ---- 视图（纯函数，只产出元素树） ----

		function section(title, ...children) {
			return h("section", { className: "pp-section" }, h("h4", null, title), ...children);
		}

		function table(head, rows) {
			return h("table", { className: "pp-table" },
				h("thead", null, h("tr", null, ...head.map((x) => h("th", null, x)))),
				h("tbody", null, ...rows.map((cells) => h("tr", null, ...cells.map((x) => h("td", null, x))))));
		}

		function header(view, busy, onControl) {
			const t = view.task;
			const buttons = view.controls.map((action) => h("button", {
				className: `pp-button pp-${action}`,
				disabled: busy,
				onClick: () => {
					if (action === "stop" && typeof window.confirm === "function" && !window.confirm("结束后这次任务就不能再继续了，确定吗？")) return;
					onControl(action);
				},
			}, CONTROL_TEXT[action]));
			return h("header", { className: "pp-header" },
				h("div", { className: "pp-title" }, t.title, t.synthetic ? h("span", { className: "pp-tag" }, "合成数据") : null),
				h("div", { className: "pp-meta" },
					h("span", { className: `pp-status pp-status-${view.status}` }, STATUS_TEXT[view.status] ?? view.status),
					h("span", null, view.status === "finished" ? `共 ${t.max_rounds} 轮` : `第 ${Math.min(view.round, t.max_rounds)}/${t.max_rounds} 轮`),
					h("span", null, `每轮 ${t.batch_size} 个 · 候选 ${t.n_candidates} 个`),
					h("span", null, `目标：${t.objective.name}${t.objective.direction === "minimize" ? "（越小越好）" : "（越大越好）"}`),
					h("span", null, `决策模块：${view.decision.name} ${view.decision.version}`)),
				buttons.length ? h("div", { className: "pp-controls" }, ...buttons) : null);
		}

		function auditCell(checks) {
			return h("span", { className: "pp-checks" }, ...CHECKS.map(([key, label]) => {
				const result = checks[key]?.result ?? "pending";
				return h("span", { className: `pp-check pp-${result === "n/a" ? "na" : result}`, title: `${label}：${result}` }, RESULT_MARK[result] ?? "?");
			}));
		}

		function selectionCell(round) {
			const s = round.submission;
			if (!s) return round.proposals ? "未提交" : "—";
			const parts = [`接受 ${s.accept.length}`];
			for (const r of s.replace) parts.push(`${r.out} → ${r.in}（${REASON_TEXT[r.reason_type] ?? r.reason_type}）`);
			return h("span", { title: s.replace.map((r) => `${r.out} → ${r.in}：${r.reason}`).join("\n") }, parts.join("；"));
		}

		function roundsSection(view) {
			const rows = view.rounds.map((r) => [
				String(r.round),
				r.recommendations.join(", ") || "—",
				selectionCell(r),
				r.results ? r.results.map((x) => `${x.id}=${x.value}${x.replicate ? "(复)" : ""}`).join(", ") : "—",
				auditCell(r.checks),
			]);
			const c = view.audit_counts;
			return section(`各轮（审计：${c.pass} 通过 · ${c.fail} 不通过 · ${c.pending} 待定）`,
				rows.length ? table(["轮", "推荐", "选择", "读数", "审计"], rows) : h("p", { className: "pp-empty" }, "还没有轮次"),
				h("p", { className: "pp-legend" }, CHECKS.map(([, label]) => label).join(" / ")));
		}

		function observationsSection(view) {
			const top = view.observations.slice(0, 10);
			return section(`读数排名（共 ${view.observations.length} 条，前 ${top.length}）`,
				top.length ? table(["候选", "读数", "轮"], top.map((o) => [o.id + (o.replicate ? "（复测）" : ""), String(o.value), String(o.round)]))
					: h("p", { className: "pp-empty" }, "还没有读数"));
		}

		function hypothesesSection(view) {
			return section(`假设（${view.hypotheses.length}）`,
				view.hypotheses.length ? h("ul", { className: "pp-list" }, ...view.hypotheses.map((x) => h("li", null,
					h("b", null, x.id), h("span", { className: `pp-hyp pp-hyp-${x.status}` }, HYPOTHESIS_TEXT[x.status] ?? x.status), x.text,
					x.cites?.length ? h("span", { className: "pp-cites" }, `引用 ${x.cites.join(", ")}`) : null)))
					: h("p", { className: "pp-empty" }, "还没有假设"));
		}

		function notesSection(view) {
			const notes = view.notes.slice(-5).reverse();
			return section(`笔记（${view.notes.length}）`,
				notes.length ? h("ul", { className: "pp-list" }, ...notes.map((x) => h("li", null, h("b", null, x.id), `第 ${x.round} 轮：`, x.text)))
					: h("p", { className: "pp-empty" }, "还没有笔记"));
		}

		function eventsSection(view) {
			const events = view.events.slice(-15).reverse();
			return section("最近事件",
				h("ul", { className: "pp-events" }, ...events.map((e) => h("li", null,
					h("span", { className: "pp-time" }, (e.ts ?? "").slice(11, 19)),
					h("span", { className: `pp-source pp-source-${e.source}` }, e.source),
					`第 ${e.round} 轮 ${e.type}`))));
		}

		/** 面板的全部内容。view 为 undefined 表示加载中，null 表示这个会话还没开始任务。 */
		function renderPanel({ view, error, busy, onControl }) {
			const banner = error ? h("div", { className: "pp-error" }, `出错了：${error}`) : null;
			if (view === undefined) return h("div", { className: "pp-panel" }, banner, h("p", { className: "pp-empty" }, "加载中…"));
			if (view === null) {
				return h("div", { className: "pp-panel" }, banner,
					h("p", { className: "pp-empty" }, "这个会话还没有开始任务。在对话里对 agent 说“开始任务”，它会调用 pp_start_task。"));
			}
			return h("div", { className: "pp-panel" }, banner,
				header(view, busy, onControl),
				roundsSection(view),
				observationsSection(view),
				hypothesesSection(view),
				notesSection(view),
				eventsSection(view));
		}

		// ---- 组件（只有这里有状态） ----

		function PanelBody({ useTabInfo, api }) {
			const { tab } = useTabInfo();
			const visible = tab?.visible !== false;
			const [view, setView] = react.useState(undefined);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			react.useEffect(() => {
				if (!visible) return;
				const controller = new AbortController();
				let timer;
				const tick = async () => {
					try {
						const body = await api.get(controller.signal);
						setView(body.run);
						setError(null);
					} catch (e) {
						if (!controller.signal.aborted) setError(e.message);
					}
					if (!controller.signal.aborted) timer = setTimeout(tick, POLL_MS);
				};
				tick();
				return () => {
					controller.abort();
					clearTimeout(timer);
				};
			}, [api, visible]);
			const onControl = react.useCallback(async (action) => {
				setBusy(true);
				try {
					const body = await api.control(action);
					setView(body.run);
					setError(null);
				} catch (e) {
					setError(e.message);
				} finally {
					setBusy(false);
				}
			}, [api]);
			return renderPanel({ view, error, busy, onControl });
		}

		function PanelGlyph() {
			return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": true },
				h("path", { d: "M2.5 13.5h11M4 11V8M7 11V4.5M10 11V6.5M13 11V3" }));
		}

		const STYLE = `
.pp-panel{padding:12px 14px;font-size:13px;line-height:1.5;overflow:auto;height:100%;box-sizing:border-box}
.pp-header{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.pp-title{font-weight:600;font-size:14px;display:flex;gap:8px;align-items:center}
.pp-tag{font-size:11px;font-weight:400;padding:0 6px;border-radius:8px;border:1px solid currentColor;opacity:.7}
.pp-meta{display:flex;flex-wrap:wrap;gap:4px 12px;opacity:.85}
.pp-status{font-weight:600}.pp-status-active{color:#2f8f4e}.pp-status-paused{color:#b7791f}.pp-status-stopped{color:#c53030}.pp-status-finished{color:#3867d6}
.pp-controls{display:flex;gap:8px}
.pp-button{font:inherit;padding:2px 12px;border-radius:6px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;cursor:pointer}
.pp-button:disabled{opacity:.5;cursor:default}.pp-stop{color:#c53030}
.pp-section{margin:12px 0}.pp-section h4{margin:0 0 6px;font-size:13px}
.pp-table{border-collapse:collapse;width:100%;font-size:12px}
.pp-table th,.pp-table td{border-bottom:1px solid rgba(127,127,127,.25);padding:3px 6px;text-align:left;vertical-align:top}
.pp-checks{white-space:nowrap;letter-spacing:2px}.pp-pass{color:#2f8f4e}.pp-fail{color:#c53030}.pp-pending,.pp-na{opacity:.55}
.pp-legend,.pp-empty{opacity:.6;font-size:12px;margin:4px 0}
.pp-list{margin:0;padding-left:16px}.pp-list li{margin:2px 0}.pp-list b{margin-right:6px}
.pp-hyp{font-size:11px;margin-right:6px;padding:0 5px;border-radius:6px;border:1px solid rgba(127,127,127,.4)}
.pp-cites{opacity:.6;margin-left:6px;font-size:12px}
.pp-events{list-style:none;margin:0;padding:0;font-size:12px}.pp-events li{display:flex;gap:8px}
.pp-time{opacity:.55;font-variant-numeric:tabular-nums}.pp-source{opacity:.75;min-width:72px}
.pp-error{color:#c53030;margin-bottom:8px}
`;

		// ---- 插件 ----

		const inject = ["slots", "sidebarRightTabs"];

		function apply(ctx) {
			ctx.effect(() => {
				if (typeof document === "undefined") return () => {};
				const style = document.createElement("style");
				style.dataset.perturbpilot = "panel";
				style.textContent = STYLE;
				document.head.appendChild(style);
				return () => style.remove();
			}, "perturbpilot: panel styles");
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: PANEL_ID,
				kind: PANEL_KIND,
				priority: "extension",
				title: () => "PerturbPilot",
				guide: [{
					id: "run",
					order: 50,
					title: () => "PerturbPilot 任务",
					description: () => "本会话里这次任务的轮次、读数、假设和审计；可以暂停、继续、结束",
					icon: PanelGlyph,
				}],
			}), "perturbpilot: panel type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: PANEL_ID,
				inject: (sessionId) => ({ api: apiFor(sessionId) }),
			}, PanelBody)), "perturbpilot: panel body");
		}

		exports.PANEL_ID = PANEL_ID;
		exports.PANEL_KIND = PANEL_KIND;
		exports.renderPanel = renderPanel;
		exports.PanelBody = PanelBody;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
