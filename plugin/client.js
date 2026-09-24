// PerturbPilot 的浏览器端：
// - DSH web 端右侧栏的一个页面型 tab：还没开始任务时选任务包、决策方法和预算（或确认 agent 的提议）后开始；
//   开始后显示这次任务的状态，并提供暂停 / 继续 / 结束。
// - 主区的"科学台账"页（左侧栏有入口）：列出所有任务，选一个看全部轮次、读数、假设历史、笔记、分析和审计。
// - 设置里的 PerturbPilot 一页：只读显示插件配置、服务连不连得上、服务令牌设没设。
//   数据都来自宿主侧挂在同源 web 服务上的 /perturbpilot/api（见 lib/panel.js）。
// - 左上角和新会话中间的 logo（占 DSH 的品牌插槽，图由 /perturbpilot/api/logo 给）。
// - 对话区里每个 pp_* 工具调用的卡片（推荐表、分组理由和读数、假设、笔记、分析），代替通用的参数/结果行。
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
		const LEDGER_ID = "perturbpilot/ledger";
		const SETTINGS_ID = "perturbpilot";
		const API = "/perturbpilot/api";
		const POLL_MS = 2000;

		const STATUS_TEXT = { active: "进行中", paused: "已暂停", stopped: "已结束", finished: "已完成" };
		const CONTROL_TEXT = { pause: "暂停", resume: "继续", stop: "结束任务" };
		const CHECKS = [
			["decision_called", "调用决策模块"],
			["selection_submitted", "提交选择"],
			["literature_backed", "文献核对"],
			["receipt_complete", "回执完整"],
			["state_carried", "状态衔接"],
			["cited_later", "后续引用"],
		];
		const RESULT_MARK = { pass: "✓", fail: "✗", pending: "…", "n/a": "–" };
		const SOURCE_TEXT = {
			decision: "照推荐",
			prior_knowledge: "已有知识",
			literature: "文献",
			analysis: "分析",
			hypothesis_test: "检验假设",
			exploration: "探索",
			data_quality: "复测",
		};
		const SCORE_TEXT = { mu: "预测均值", sigma: "不确定度", score: "得分" };
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

		function post(url, body) {
			return fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", "x-perturbpilot": "1" },
				body: JSON.stringify(body),
			}).then(parse);
		}

		function createApi(sessionId) {
			const base = `${API}/sessions/${encodeURIComponent(sessionId)}`;
			return {
				get: (signal) => fetch(base, { signal, cache: "no-store" }).then(parse),
				start: (setup) => post(`${base}/start`, setup ?? {}),
				control: (action) => post(`${base}/control`, { action }),
			};
		}

		// 每个会话一个 api 对象，保证身份稳定，轮询的 effect 不会因为重渲染而重启。
		const apis = new Map();
		function apiFor(sessionId) {
			if (!apis.has(sessionId)) apis.set(sessionId, createApi(sessionId));
			return apis.get(sessionId);
		}

		// 科学台账页和设置页不绑会话：先列出所有任务，再按任务 id 取视图。
		const globalApi = {
			list: (signal) => fetch(`${API}/sessions`, { signal, cache: "no-store" }).then(parse),
			status: (signal) => fetch(`${API}/status`, { signal, cache: "no-store" }).then(parse),
			tasks: (signal) => fetch(`${API}/tasks`, { signal, cache: "no-store" }).then(parse),
			run: apiFor,
		};

		// ---- 视图（纯函数，只产出元素树） ----

		/** 目标值；空读数显示成“空”。 */
		function fmt(v) {
			return v === null || v === undefined ? "空" : String(v);
		}

		/** 一条读数的全部字段，比如 “score=-1.2, absolute_effect=1.2”。 */
		function readoutText(readout) {
			if (!readout) return "空";
			return Object.entries(readout).map(([k, v]) => `${k}=${v === null ? "空" : v}`).join(", ");
		}

		function sourceText(source) {
			return SOURCE_TEXT[source] ?? source;
		}

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
					h("span", null, view.status === "finished" ? `共 ${t.budget.rounds} 轮` : `第 ${Math.min(view.round, t.budget.rounds)}/${t.budget.rounds} 轮`),
					h("span", null, `每轮 ${t.budget.batch_size} 个 · 候选 ${t.n_candidates} 个`),
					h("span", null, `目标：${t.objective_text}`),
					h("span", null, `决策模块：${view.decision.name} ${view.decision.version} · ${view.decision.method}`)),
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
			const parts = [`照推荐 ${s.from_recommendation}`];
			for (const g of s.groups) if (g.source !== "decision") parts.push(`${sourceText(g.source)} ${g.ids.join(", ")}`);
			return h("span", { title: s.groups.map((g) => `${sourceText(g.source)}（${g.ids.join(", ")}）：${g.reason}`).join("\n") }, parts.join("；"));
		}

		function roundsSection(view) {
			const rows = view.rounds.map((r) => [
				String(r.round),
				r.recommendations.join(", ") || "—",
				selectionCell(r),
				r.results ? r.results.map((x) => `${x.id}=${fmt(x.value)}${x.replicate ? "(复)" : ""}`).join(", ") : "—",
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
				top.length ? table(["候选", "读数", "轮"], top.map((o) => [o.id + (o.replicate ? "（复测）" : ""), fmt(o.value), String(o.round)]))
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

		/** 任务包里有没有方法要的全部输入（requires 是 [{role, modality}]）。 */
		function methodFits(task, needs) {
			const cards = task?.data_cards ?? [];
			return (needs ?? []).every((n) => cards.some((dc) => dc.role === n.role && dc.modality === n.modality));
		}

		/** 按任务包的预算（或 agent 的提议）填好的表单：字段都是字符串，method 为空表示用决策模块的默认方法。 */
		function initialForm(catalog, proposal) {
			const tasks = catalog?.tasks ?? [];
			const task = tasks.find((t) => t.task_id === proposal?.task_id) ?? tasks[0];
			if (!task) return null;
			const fromProposal = proposal?.task_id === task.task_id;
			return {
				task_id: task.task_id,
				method: (fromProposal && proposal.method) || "",
				rounds: String((fromProposal && proposal.rounds) || task.budget.rounds),
				batch_size: String((fromProposal && proposal.batch_size) || task.budget.batch_size),
			};
		}

		/** 表单 → POST /start 的请求体；数字格式不对的原样交给宿主去检查和报错。 */
		function setupFromForm(form) {
			const n = (x) => (/^\d+$/.test(x.trim()) ? Number(x) : x);
			const setup = { task_id: form.task_id, rounds: n(form.rounds), batch_size: n(form.batch_size) };
			if (form.method) setup.method = form.method;
			return setup;
		}

		function field(label, control) {
			return h("label", { className: "pp-field" }, h("span", { className: "pp-field-label" }, label), control);
		}

		/**
		 * 还没开始任务时：选任务包、决策方法和预算，然后开始。
		 * catalog 是宿主 /tasks 的结果，undefined 表示还在读，null 表示读不到；
		 * proposal 是 agent 用 pp_propose_task 提的设置（没有为 null）；form 来自 initialForm，改动经 onForm 交回。
		 */
		function startCard({ catalog, proposal, form, onForm, busy, onStart }) {
			if (catalog === undefined) return section("开始任务", h("p", { className: "pp-empty" }, "正在读取任务列表…"));
			if (catalog === null) return section("开始任务", h("p", { className: "pp-empty" }, "读不到任务列表，先确认服务在运行（设置页可以检查）"));
			if (!catalog.tasks.length || !form) return section("开始任务", h("p", { className: "pp-empty" }, "服务里没有任务包"));
			const task = catalog.tasks.find((t) => t.task_id === form.task_id) ?? catalog.tasks[0];
			const { decision, limits } = catalog;
			const set = (key) => (e) => onForm({ ...form, [key]: e.target.value });
			const pickTask = (e) => onForm(initialForm(catalog, { task_id: e.target.value }));
			const proposed = proposal ? h("div", { className: "pp-proposal" },
				h("div", { className: "pp-sub" }, "agent 的提议（已填进下面，可以改）"),
				h("p", null, proposal.rationale)) : null;
			return section(proposal ? "确认开始任务" : "开始任务",
				proposed,
				h("div", { className: "pp-form" },
					field("任务", h("select", { className: "pp-input", value: task.task_id, onChange: pickTask, disabled: busy },
						...catalog.tasks.map((t) => h("option", { key: t.task_id, value: t.task_id }, `${t.title}（${t.task_id}）`)))),
					h("div", { className: "pp-task" },
						task.synthetic ? h("span", { className: "pp-tag" }, "合成数据") : null,
						h("ul", { className: "pp-list" },
							h("li", null, `扰动：${task.action?.type ?? "—"}${task.action?.description ? `，${task.action.description}` : ""}`),
							h("li", null, `目标：${task.objective_text}`),
							h("li", null, `任务包原定 ${task.budget.rounds} 轮，每轮 ${task.budget.batch_size} 个；候选 ${task.n_candidates} 个${task.budget.allow_repeats ? "，可以重复测" : ""}`))),
					field("决策方法", h("select", { className: "pp-input", value: form.method, onChange: set("method"), disabled: busy },
						h("option", { value: "" }, `默认（${decision.default_method}）`),
						...Object.entries(decision.methods ?? {}).map(([m, text]) => {
							const fits = methodFits(task, decision.requires?.[m]);
							return h("option", { key: m, value: m, disabled: !fits }, `${m}${text ? ` · ${text}` : ""}${fits ? "" : "（任务包缺它要的特征）"}`);
						}))),
					h("div", { className: "pp-form-row" },
						field(`轮数（${limits.rounds[0]}–${limits.rounds[1]}）`, h("input", { className: "pp-input", type: "number", min: limits.rounds[0], max: limits.rounds[1], value: form.rounds, onChange: set("rounds"), disabled: busy })),
						field(`每轮个数（1–${task.n_candidates}）`, h("input", { className: "pp-input", type: "number", min: 1, max: task.n_candidates, value: form.batch_size, onChange: set("batch_size"), disabled: busy })))),
				h("button", { className: "pp-button pp-start", disabled: busy, onClick: () => onStart(setupFromForm(form)) }, busy ? "正在开始…" : proposal ? "确认开始" : "开始任务"),
				h("p", { className: "pp-legend" }, "也可以直接在对话里说想发现什么，agent 会问清楚后提议一个任务。开始后第 1 轮自动进行；随时可以插话，或在这里暂停、结束。"));
		}

		/** 面板的全部内容。view 为 undefined 表示加载中，null 表示这个会话还没开始任务（这时显示 startCard，参数见那里）。 */
		function renderPanel({ view, catalog, proposal = null, form = null, onForm = () => {}, error, busy, onControl, onStart }) {
			const banner = error ? h("div", { className: "pp-error" }, `出错了：${error}`) : null;
			if (view === undefined) return h("div", { className: "pp-panel" }, banner, h("p", { className: "pp-empty" }, "加载中…"));
			if (view === null) {
				return h("div", { className: "pp-panel" }, banner,
					h("p", { className: "pp-empty" }, "这个会话还没有开始任务。"),
					startCard({ catalog, proposal, form, onForm, busy, onStart }));
			}
			return h("div", { className: "pp-panel" }, banner,
				header(view, busy, onControl),
				roundsSection(view),
				observationsSection(view),
				hypothesesSection(view),
				notesSection(view),
				eventsSection(view));
		}

		// ---- 主区的科学台账页：一个任务从头到尾的记录 ----
		// 顶部是任务目标和进展，接着是当前结论（假设），然后每轮一张卡片，按
		// “推荐 → 分析与判断 → 本轮测的 → 读数 → 审计”的顺序讲这一轮发生了什么。全部读数和事件日志折叠在最后。

		/** 从视图里算出台账页要用的派生数据：每轮的至今最佳、每轮的思考记录、总览数字。 */
		function ledgerModel(view) {
			const minimize = view.task.goal === "low";
			const better = (a, b) => (minimize ? a < b : a > b);
			const values = view.observations.map((o) => o.value).filter((v) => v !== null);
			const range = values.length ? [Math.min(...values), Math.max(...values)] : [0, 1];
			let best = null;
			let replaced = 0;
			let measured = 0;
			const rounds = view.rounds.map((r) => {
				let newBest = null;
				for (const x of r.results ?? []) {
					if (x.value !== null && (!best || better(x.value, best.value))) {
						best = { id: x.id, value: x.value, round: r.round };
						newBest = x.id;
					}
				}
				if (r.submission) {
					replaced += r.submission.outside.length;
					measured += r.submission.batch.length;
				}
				const thoughts = [
					...(view.analyses ?? []).filter((a) => a.round === r.round).map((a) => ({ kind: "analysis", ts: a.ts, item: a })),
					...view.hypotheses.flatMap((hyp) => (hyp.history ?? [])
						.map((e, i) => ({ kind: "hypothesis", item: { ...e, id: hyp.id, first: i === 0 } }))
						.filter((x) => x.item.round === r.round)),
					...view.notes.filter((n) => n.round === r.round).map((n) => ({ kind: "note", item: n })),
					...(view.retrievals ?? []).filter((x) => x.round === r.round).map((x) => ({ kind: "retrieval", item: x })),
				];
				return { ...r, best, newBest, thoughts };
			});
			const unique = new Set(view.observations.map((o) => o.id)).size;
			return { minimize, better, range, best, replaced, measured, unique, rounds };
		}

		function chip(id, kind) {
			return h("span", { className: `pp-chip${kind ? ` pp-chip-${kind}` : ""}` }, id);
		}

		function stat(label, value, sub) {
			return h("div", { className: "pp-stat" },
				h("div", { className: "pp-stat-label" }, label),
				h("div", { className: "pp-stat-value" }, value),
				sub ? h("div", { className: "pp-sub" }, sub) : null);
		}

		/** 进展图：每个读数一个点，线是至今最佳。纯 SVG。 */
		function progressChart(view, model) {
			const W = 560, H = 170, L = 44, R = 12, T = 12, B = 26;
			const n = view.task.budget.rounds;
			const [lo, hi] = model.range;
			const span = hi - lo || 1;
			const x = (round) => L + (n <= 1 ? 0.5 : (round - 1) / (n - 1)) * (W - L - R);
			const y = (v) => T + (1 - (v - lo) / span) * (H - T - B);
			const dots = [];
			const line = [];
			for (const r of model.rounds) {
				for (const o of r.results ?? []) {
					if (o.value === null) continue;
					dots.push(h("circle", { cx: x(r.round), cy: y(o.value), r: 3, className: `pp-dot${o.id === r.newBest ? " pp-dot-best" : ""}` },
						h("title", null, `第 ${r.round} 轮 ${o.id} = ${o.value}`)));
				}
				if (r.best && r.results) line.push(`${x(r.round)},${y(r.best.value)}`);
			}
			const ticks = [];
			for (let i = 1; i <= n; i++) ticks.push(h("text", { x: x(i), y: H - 8, className: "pp-axis", textAnchor: "middle" }, String(i)));
			return h("figure", { className: "pp-chart" },
				h("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": "每轮读数和至今最佳" },
					h("line", { x1: L, x2: W - R, y1: H - B, y2: H - B, className: "pp-grid" }),
					h("line", { x1: L, x2: W - R, y1: T, y2: T, className: "pp-grid" }),
					h("text", { x: L - 6, y: T + 4, className: "pp-axis", textAnchor: "end" }, String(hi)),
					h("text", { x: L - 6, y: H - B + 4, className: "pp-axis", textAnchor: "end" }, String(lo)),
					...ticks,
					line.length ? h("polyline", { points: line.join(" "), className: "pp-best-line" }) : null,
					...dots),
				h("figcaption", { className: "pp-sub" }, `横轴是轮次，每个点是一个读数的 ${view.task.objective.field}（空读数不画）；线是到这一轮为止的最佳（${model.minimize ? "越低越好" : "越高越好"}）。`));
		}

		function overview(view, model, busy, onControl) {
			const t = view.task;
			const rounds = t.budget.rounds;
			const round = view.status === "finished" ? rounds : Math.min(view.round, rounds);
			const c = view.audit_counts;
			return h("div", null,
				header(view, busy, onControl),
				h("p", { className: "pp-goal" },
					`目标：${t.objective_text}，候选 ${t.n_candidates} 个。`,
					`每轮测 ${t.budget.batch_size} 个，共 ${rounds} 轮。每轮决策模块先推荐一批，agent 可以照推荐，也可以按生物学推理、文献或分析换成别的候选，并分组写明依据；框架把这一批交给 oracle 测量。`),
				h("div", { className: "pp-overview" },
					h("div", { className: "pp-stats" },
						stat("当前最佳", model.best ? `${model.best.id} = ${model.best.value}` : "—", model.best ? `第 ${model.best.round} 轮测到` : "还没有读数"),
						stat("已测", `${model.unique} / ${t.n_candidates}`, `共 ${view.observations.length} 个读数`),
						stat("进度", `第 ${round} / ${rounds} 轮`, STATUS_TEXT[view.status] ?? view.status),
						stat("推荐以外的",`${model.replaced} / ${model.measured}`, model.measured ? `占 ${Math.round((100 * model.replaced) / model.measured)}%` : "还没提交过"),
						stat("审计", c.fail ? `${c.fail} 项不通过` : "全部通过", `${c.pass} 通过 · ${c.pending} 待定`)),
					progressChart(view, model)));
		}

		function conclusionsSection(view) {
			if (!view.hypotheses.length) return section("当前结论", h("p", { className: "pp-empty" }, "agent 还没有提出假设"));
			return section(`当前结论（${view.hypotheses.length} 条假设）`,
				h("div", { className: "pp-hyps" }, ...view.hypotheses.map((x) => h("div", { className: `pp-card pp-hyp-card pp-hyp-card-${x.status}` },
					h("div", { className: "pp-card-head" },
						h("b", null, x.id),
						h("span", { className: `pp-hyp pp-hyp-${x.status}` }, HYPOTHESIS_TEXT[x.status] ?? x.status),
						h("span", { className: "pp-sub" }, `第 ${x.created_round} 轮提出 · 更新 ${Math.max(0, (x.history?.length ?? 1) - 1)} 次 · 依据 ${x.cites?.length ?? 0} 个读数`)),
					h("p", { className: "pp-text" }, x.text),
					x.history?.length > 1 ? h("details", null,
						h("summary", { className: "pp-sub" }, "看它是怎么变过来的"),
						h("ol", { className: "pp-history" }, ...x.history.map((e) => h("li", null,
							h("span", { className: "pp-sub" }, `第 ${e.round} 轮 `),
							h("span", { className: `pp-hyp pp-hyp-${e.status}` }, HYPOTHESIS_TEXT[e.status] ?? e.status),
							e.rationale ?? "")))) : null))));
		}

		function thoughtItem({ kind, item }) {
			if (kind === "analysis") {
				const status = item.timed_out ? "超时" : item.exit_code === 0 ? "完成" : item.exit_code === null ? "没启动" : "出错";
				return h("li", { className: "pp-thought" },
					h("span", { className: "pp-kind pp-kind-analysis" }, "分析"),
					h("div", null,
						h("b", null, item.id), " ", item.purpose,
						h("span", { className: `pp-sub${item.exit_code === 0 ? "" : " pp-fail"}` }, ` · ${status}`),
						h("span", { className: "pp-sub" }, ` · ${item.dir}${item.files?.length ? ` · 写出 ${item.files.join(", ")}` : ""}`)));
			}
			if (kind === "retrieval") {
				const what = item.tool === "web_search"
					? `搜索 ${(item.queries ?? []).join("；")} · ${item.results?.length ?? 0} 条结果`
					: `读取 ${item.url ?? ""}${item.status ? `（${item.status}）` : ""}`;
				return h("li", { className: "pp-thought" },
					h("span", { className: "pp-kind pp-kind-retrieval" }, "检索"),
					h("div", null,
						h("b", null, item.id), " ", what,
						item.is_error ? h("span", { className: "pp-sub pp-fail" }, " · 出错") : null,
						item.results?.length ? h("details", null,
							h("summary", { className: "pp-sub" }, "结果"),
							h("ul", { className: "pp-list" }, ...item.results.map((x) => h("li", null, x.title || x.url, " ", h("span", { className: "pp-sub" }, x.url))))) : null));
			}
			if (kind === "hypothesis") {
				return h("li", { className: "pp-thought" },
					h("span", { className: "pp-kind pp-kind-hypothesis" }, item.first ? "提出假设" : "更新假设"),
					h("div", null,
						h("b", null, item.id), " ",
						h("span", { className: `pp-hyp pp-hyp-${item.status}` }, HYPOTHESIS_TEXT[item.status] ?? item.status),
						item.first ? item.text : item.rationale ?? item.text,
						!item.first && item.rationale && item.text ? h("details", null, h("summary", { className: "pp-sub" }, "更新后的说法"), h("p", { className: "pp-text" }, item.text)) : null));
			}
			return h("li", { className: "pp-thought" },
				h("span", { className: "pp-kind pp-kind-note" }, "笔记"),
				h("div", null, h("b", null, item.id), " ", item.text));
		}

		function readingBars(r, model) {
			const [lo, hi] = model.range;
			const span = hi - lo || 1;
			// 空读数排最后，条长为 0。
			const rows = [...r.results].sort((a, b) => (a.value === null) - (b.value === null) || (model.minimize ? a.value - b.value : b.value - a.value));
			return h("div", { className: "pp-bars" }, ...rows.map((x) => {
				const share = x.value === null ? 0 : model.minimize ? (hi - x.value) / span : (x.value - lo) / span;
				const replacedIn = r.submission?.outside.includes(x.id);
				return h("div", { className: "pp-bar-row" },
					h("span", { className: "pp-bar-id" }, x.id, x.replicate ? h("span", { className: "pp-sub" }, " 复测") : null),
					h("span", { className: "pp-bar-track" }, h("span", { className: `pp-bar${replacedIn ? " pp-bar-in" : ""}`, style: { width: `${Math.max(2, Math.round(share * 100))}%` } })),
					h("span", { className: "pp-bar-value", title: readoutText(x.readout) }, fmt(x.value)),
					x.id === r.newBest ? h("span", { className: "pp-new-best" }, "新的最佳") : h("span", null));
			}));
		}

		function roundCard(r, model) {
			const s = r.submission;
			// 推荐里没进这一批的划掉，推荐以外进来的高亮。
			const out = new Set(s ? r.recommendations.filter((id) => !s.batch.includes(id)) : []);
			const ins = new Set(s?.outside ?? []);
			const state = r.results ? "已测" : s ? "已提交" : r.proposals ? "在选" : "刚开始";
			const step = (label, ...body) => h("div", { className: "pp-step" }, h("div", { className: "pp-step-label" }, label), h("div", { className: "pp-step-body" }, ...body));
			const receipt = r.receipt
				? `决策模块收下 ${r.receipt.accepted} 条读数${r.receipt.rejected ? `、拒收 ${r.receipt.rejected} 条` : ""}，状态版本 ${r.receipt.state_version_before} → ${r.receipt.state_version_after}`
				: null;
			return h("article", { className: "pp-round" },
				h("div", { className: "pp-round-head" },
					h("span", { className: "pp-round-no" }, `第 ${r.round} 轮`),
					h("span", { className: "pp-sub" }, state),
					s ? h("span", { className: "pp-sub" }, s.outside.length ? `推荐以外 ${s.outside.length} 个` : "全部照推荐") : null,
					r.proposals > 1 ? h("span", { className: "pp-sub" }, `要了 ${r.proposals} 次推荐`) : null,
					r.steers ? h("span", { className: "pp-sub pp-fail" }, `框架催了 ${r.steers} 次`) : null,
					r.best && r.results ? h("span", { className: "pp-round-best" }, `至今最佳 ${r.best.id} = ${r.best.value}`) : null),
				step("决策模块推荐",
					r.recommendations.length
						? h("div", { className: "pp-chips" }, ...r.recommendations.map((id) => chip(id, out.has(id) ? "out" : null)))
						: h("span", { className: "pp-empty" }, "还没有向决策模块要推荐")),
				step("分析与判断",
					r.thoughts.length ? h("ul", { className: "pp-thoughts" }, ...r.thoughts.map(thoughtItem)) : h("span", { className: "pp-empty" }, "这一轮没有记录分析、假设或笔记")),
				step("本轮测的",
					s ? h("div", null,
						h("div", { className: "pp-chips" }, ...s.batch.map((id) => chip(id, ins.has(id) ? "in" : null))),
						s.groups.length ? h("ul", { className: "pp-swaps" }, ...s.groups.map((g) => h("li", null,
							h("span", { className: "pp-swap" }, ...g.ids.map((id) => chip(id, ins.has(id) ? "in" : null))),
							h("span", { className: "pp-hyp" }, sourceText(g.source)),
							h("span", null, g.reason)))) : null)
						: h("span", { className: "pp-empty" }, "还没提交")),
				step("读数", r.results?.length ? readingBars(r, model) : h("span", { className: "pp-empty" }, "还没有读数")),
				h("footer", { className: "pp-round-foot" },
					...CHECKS.map(([key, label]) => {
						const result = r.checks[key]?.result ?? "pending";
						return h("span", { className: `pp-check pp-${result === "n/a" ? "na" : result}`, title: `${label}：${result}` }, `${RESULT_MARK[result] ?? "?"} ${label}`);
					}),
					receipt ? h("span", { className: "pp-sub" }, receipt) : null,
					literatureNote(r.checks.literature_backed)));
		}

		/** 文献核对的细节：写了文献理由但检索里没提到的，和检索里提到了但没标文献的。 */
		function literatureNote(check) {
			const parts = [];
			if (check?.unbacked?.length) parts.push(`标了文献、检索里没提到：${check.unbacked.join(", ")}`);
			if (check?.unlabelled?.length) parts.push(`检索里提到、没标文献：${check.unlabelled.join(", ")}`);
			return parts.length ? h("span", { className: "pp-sub" }, parts.join("；")) : null;
		}

		function allReadingsSection(view) {
			return h("details", { className: "pp-fold" },
				h("summary", null, `全部读数排名（${view.observations.length} 条）`),
				view.observations.length
					? table(["名次", "候选", "读数", "轮"], view.observations.map((o, i) => [String(i + 1), o.id + (o.replicate ? `（第 ${o.replicate + 1} 次测）` : ""), readoutText(o.readout), String(o.round)]))
					: h("p", { className: "pp-empty" }, "还没有读数"));
		}

		function eventLogSection(view) {
			return h("details", { className: "pp-fold" },
				h("summary", null, `事件日志（最近 ${view.events.length} 条）`),
				h("ul", { className: "pp-events" }, ...[...view.events].reverse().map((e) => h("li", null,
					h("span", { className: "pp-time" }, (e.ts ?? "").slice(11, 19)),
					h("span", { className: `pp-source pp-source-${e.source}` }, e.source),
					`第 ${e.round} 轮 ${e.type}`))));
		}

		function runListItem(item, selected, onSelect) {
			// 旧格式的记录只列出来，不能展开。
			return h("button", {
				className: `pp-run${item.run_id === selected ? " pp-run-active" : ""}${item.legacy ? " pp-run-legacy" : ""}`,
				disabled: Boolean(item.legacy),
				title: item.legacy ? "早期版本的记录，格式不同，不再展开" : undefined,
				onClick: () => onSelect(item.run_id),
			},
				h("div", { className: "pp-run-title" }, item.title,
					item.legacy ? h("span", { className: "pp-tag" }, "旧格式") : null,
					item.synthetic ? h("span", { className: "pp-tag" }, "合成") : null),
				h("div", { className: "pp-sub" },
					h("span", { className: `pp-status pp-status-${item.status}` }, STATUS_TEXT[item.status] ?? item.status),
					` · 第 ${Math.min(item.round, item.max_rounds ?? item.round)}/${item.max_rounds ?? "?"} 轮 · ${(item.updated ?? "").slice(0, 16).replace("T", " ")}`),
				h("div", { className: "pp-sub pp-run-id" }, item.run_id));
		}

		/** 科学台账页。runs 为 undefined 表示加载中；selected 是选中的任务 id；view 同 renderPanel。 */
		function renderLedger({ runs, selected, view, error, busy, onSelect, onControl }) {
			const banner = error ? h("div", { className: "pp-error" }, `出错了：${error}`) : null;
			const list = runs === undefined ? h("p", { className: "pp-empty" }, "加载中…")
				: runs.length === 0 ? h("p", { className: "pp-empty" }, "还没有任务。新建一个会话，在右侧栏的 PerturbPilot 面板上点“开始任务”。")
					: h("div", { className: "pp-runs" }, ...runs.map((x) => runListItem(x, selected, onSelect)));
			let body;
			if (!selected) body = h("p", { className: "pp-empty" }, runs?.length === 0 ? "" : "选一个任务");
			else if (view === undefined) body = h("p", { className: "pp-empty" }, "加载中…");
			else if (view === null) body = h("p", { className: "pp-empty" }, "这个任务的记录读不到了");
			else {
				const model = ledgerModel(view);
				body = h("div", { className: "pp-doc" },
					overview(view, model, busy, onControl),
					conclusionsSection(view),
					section("逐轮记录", h("div", { className: "pp-rounds" }, ...model.rounds.map((r) => roundCard(r, model)))),
					allReadingsSection(view),
					eventLogSection(view));
			}
			return h("div", { className: "pp-ledger" },
				h("aside", { className: "pp-ledger-side" }, h("h3", null, "科学台账"), list),
				h("main", { className: "pp-ledger-main" }, banner, body));
		}

		// ---- 设置里的 PerturbPilot 一页：只读，改配置要改 profile 的 cordis.patch.yml ----

		const CONFIG_TEXT = [
			["oracleUrl", "oracle 服务地址"],
			["decisionUrl", "决策模块服务地址"],
			["runsDir", "运行目录"],
			["pythonPath", "分析用的 Python"],
			["pythonTimeoutMs", "一次分析最长（毫秒）"],
			["maxSteers", "每轮最多催几次"],
			["llmUrlPattern", "模型调用的 URL 匹配"],
			["serviceTokenEnv", "服务令牌的环境变量"],
		];

		function serviceLine(label, s) {
			if (!s) return h("li", null, `${label}：—`);
			return h("li", null, `${label}：`, s.ok
				? h("span", { className: "pp-pass" }, `连得上 ${s.tasks ? `${s.tasks.length} 个任务包（${s.tasks.join(", ")}）${s.active ? `，当前 ${s.active}` : ""}` : ""}${s.name ? `${s.name} ${s.version}${s.method ? ` · ${s.method}` : ""}` : ""}${s.synthetic ? "（合成数据）" : ""}`)
				: h("span", { className: "pp-fail" }, `连不上：${s.error}`));
		}

		/** 设置页内容。status 为 undefined 表示加载中。 */
		function renderSettings({ status, error, onRefresh }) {
			const banner = error ? h("div", { className: "pp-error" }, `出错了：${error}`) : null;
			if (status === undefined) return h("div", { className: "pp-settings" }, banner, h("p", { className: "pp-empty" }, "加载中…"));
			const cfg = status.config ?? {};
			return h("div", { className: "pp-settings" }, banner,
				section("服务",
					h("ul", { className: "pp-list" },
						serviceLine("oracle", status.services?.oracle),
						serviceLine("决策模块", status.services?.decision),
						h("li", null, "服务令牌：", status.token_set
							? h("span", { className: "pp-pass" }, `已设（${cfg.serviceTokenEnv}）`)
							: h("span", { className: "pp-fail" }, `没设：分析用的 Python 能直接调服务。启动 dsh 和服务前都设上 ${cfg.serviceTokenEnv ?? "令牌环境变量"}`))),
					h("button", { className: "pp-button", onClick: onRefresh }, "重新检查")),
				section("配置",
					table(["项", "键", "当前值"], CONFIG_TEXT.map(([key, label]) => [label, key, cfg[key] === undefined ? "—" : String(cfg[key])])),
					h("p", { className: "pp-legend" }, "这里只读。要改，在 profile 的 cordis.patch.yml 里按 id: perturbpilot 覆盖 config，然后重启 dsh。")));
		}

		// ---- 对话区里 pp_* 工具调用的卡片（只看这次调用自己的参数和结果，回放时也一样） ----

		const TOOL_TITLE = {
			pp_list_tasks: "查看任务列表",
			pp_propose_task: "提议任务",
			pp_get_decision: "决策模块推荐",
			pp_submit_selection: "提交本轮选择",
			pp_update_hypothesis: "更新假设",
			pp_write_note: "研究笔记",
			pp_get_ledger: "读取完整账本",
			pp_run_python: "Python 分析",
			pp_control: "任务控制",
		};
		const TOOL_NAMES = Object.keys(TOOL_TITLE);

		function parseJson(raw) {
			if (typeof raw !== "string" || raw === "") return undefined;
			try {
				return JSON.parse(raw);
			} catch {
				return undefined;
			}
		}

		/** 从一次调用的块里取出参数、结果和状态；和 DSH 通用工具行对结果的拼法一致。 */
		function toolCallModel(phase, block) {
			if (phase === "preparing") return { state: "preparing", args: undefined, result: undefined, text: null };
			const settled = phase === "result";
			const args = parseJson((settled ? block.call?.argsRaw : block.argsRaw) ?? "");
			if (!settled) return { state: "running", args, result: undefined, text: null };
			const parts = [];
			for (const item of block.content ?? []) parts.push(item.type === "text" ? item.text : JSON.stringify(item));
			if (parts.length === 0 && block.error) parts.push(`${block.error.name}: ${block.error.code}`);
			const text = parts.join("\n") || null;
			const state = block.error?.code === "interrupted" ? "stopped" : block.isError ? "error" : "ok";
			return { state, args, result: state === "ok" ? parseJson(text) : undefined, text };
		}

		function num(x) {
			return typeof x === "number" ? String(x) : "—";
		}

		function cites(list) {
			return list?.length ? h("span", { className: "pp-cites" }, `依据 ${list.join(", ")}`) : null;
		}

		const TOOL_BODY = {
			pp_list_tasks: (args, r) => r && h("div", null,
				h("p", { className: "pp-sub" }, `${r.tasks.length} 个任务包 · 决策模块方法 ${Object.keys(r.decision?.methods ?? {}).join(", ") || "—"}`),
				table(["任务", "目标", "候选", "预算"], r.tasks.map((t) => [t.title, t.objective_text, num(t.n_candidates), `${t.budget.rounds} 轮 × ${t.budget.batch_size}`]))),
			pp_propose_task: (args, r) => h("div", null,
				r?.effective ? h("ul", { className: "pp-list" },
					h("li", null, `任务：${r.effective.title}（${r.effective.task_id}）`),
					h("li", null, `决策方法：${r.effective.method}`),
					h("li", null, `预算：${r.effective.budget.rounds} 轮，每轮 ${r.effective.budget.batch_size} 个；候选 ${r.effective.n_candidates} 个`)) : null,
				args?.rationale ? h("p", null, args.rationale) : null,
				r ? h("p", { className: "pp-sub" }, "到右侧 PerturbPilot 面板确认开始（可以先改设置）") : null),
			pp_get_decision: (args, r) => {
				if (!r) return null;
				// 方法不同，给的数值列也不同：有哪些列就显示哪些。
				const cols = [...new Set(r.recommendations.flatMap((x) => Object.keys(x)))].filter((k) => k !== "id" && k !== "rank");
				return h("div", null,
					h("p", { className: "pp-sub" }, `第 ${r.round}/${r.rounds} 轮 · 方法 ${r.method} · 基于 ${r.n_observations} 条读数（状态版本 ${r.state_version}）`),
					table(["推荐", ...cols.map((k) => SCORE_TEXT[k] ?? k)], r.recommendations.map((x) => [x.id, ...cols.map((k) => num(x[k]))])),
					r.alternatives?.length ? h("p", { className: "pp-sub" }, `备选：${r.alternatives.map((x) => x.id).join(", ")}`) : null);
			},
			pp_submit_selection: (args, r) => h("div", null,
				args ? h("p", null, `提交 ${args.batch?.length ?? 0} 个候选${args.groups?.length ? `，分 ${args.groups.length} 组写了依据` : ""}`) : null,
				args?.groups?.length ? h("ul", { className: "pp-list" }, ...args.groups.map((g) => h("li", null,
					h("b", null, (g.ids ?? []).join(", ")),
					h("span", { className: "pp-hyp" }, sourceText(g.source)), g.reason))) : null,
				r?.problem ? h("div", { className: "pp-error" }, r.problem) : null,
				r?.results ? table(["候选", "读数", "来源"], r.results.map((x) => [
					x.id + (x.replicate ? "（复测）" : ""), readoutText(x.readout), x.recommended ? "推荐" : "推荐以外"])) : null,
				r?.next ? h("p", { className: "pp-sub" }, r.next.finished ? "任务完成" : `下一轮：第 ${r.next.round}/${r.next.rounds} 轮`) : null),
			pp_update_hypothesis: (args, r) => h("p", null,
				h("b", null, r?.id ?? args?.id ?? "新假设"),
				args?.status ? h("span", { className: `pp-hyp pp-hyp-${args.status}` }, HYPOTHESIS_TEXT[args.status] ?? args.status) : null,
				args?.text ?? "",
				args?.rationale ? h("span", { className: "pp-sub" }, ` 理由：${args.rationale}`) : null,
				cites(args?.cites)),
			pp_write_note: (args, r) => h("p", null, r?.id ? h("b", null, r.id) : null, args?.text ?? "", cites(args?.cites)),
			pp_get_ledger: (args, r) => r && h("p", { className: "pp-sub" },
				`${r.observations?.length ?? 0} 条读数 · ${r.hypotheses?.length ?? 0} 条假设 · ${r.notes?.length ?? 0} 条笔记 · ${r.retrievals?.length ?? 0} 次检索`),
			pp_run_python: (args, r) => h("div", null,
				args?.purpose ? h("p", null, args.purpose) : null,
				args?.code ? h("details", null, h("summary", { className: "pp-sub" }, "代码"), h("pre", { className: "pp-pre" }, args.code)) : null,
				r ? h("p", { className: "pp-sub" },
					`${r.id} · `,
					r.timed_out ? "超时，已停止" : r.exit_code === 0 ? "完成" : r.exit_code === null ? "没能启动 Python" : `出错（退出码 ${r.exit_code}）`,
					r.files?.length ? ` · 写出 ${r.files.join(", ")}` : "") : null,
				r?.stdout ? h("pre", { className: "pp-pre" }, r.stdout) : null,
				r?.stderr && r.exit_code !== 0 ? h("pre", { className: "pp-pre pp-error" }, r.stderr) : null),
			pp_control: (args, r) => h("p", null, `${CONTROL_TEXT[args?.action] ?? args?.action ?? ""}${r ? ` → ${STATUS_TEXT[r.status] ?? r.status}` : ""}`),
		};

		const STATE_TEXT = { preparing: "准备中…", running: "进行中…", error: "出错", stopped: "已中断" };

		/** 一张工具卡片。model 来自 toolCallModel。 */
		function renderToolCard(toolName, model) {
			const { state, args, result, text } = model;
			const body = state === "error" || state === "stopped"
				? h("div", { className: "pp-error" }, text ?? "")
				: TOOL_BODY[toolName]?.(args, result) ?? null;
			return h("div", { className: `pp-tool pp-tool-${state}` },
				h("div", { className: "pp-tool-head" },
					h("span", { className: "pp-tool-title" }, TOOL_TITLE[toolName] ?? toolName),
					STATE_TEXT[state] ? h("span", { className: "pp-sub" }, STATE_TEXT[state]) : null),
				body);
		}

		function ToolCard(props) {
			return renderToolCard(props.toolName, toolCallModel(props.phase, props.block));
		}

		// ---- 组件（只有这里有状态） ----

		function PanelBody({ useTabInfo, api }) {
			const { tab } = useTabInfo();
			const visible = tab?.visible !== false;
			const [view, setView] = react.useState(undefined);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [proposal, setProposal] = react.useState(null);
			react.useEffect(() => {
				if (!visible) return;
				const controller = new AbortController();
				let timer;
				const tick = async () => {
					try {
						const body = await api.get(controller.signal);
						setView(body.run);
						setProposal(body.proposal ?? null);
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
			// 还没开始任务时读一次任务列表给表单；agent 的提议随会话一起轮询，提议变了就重新填表。
			const [catalog, setCatalog] = react.useState(undefined);
			const [form, setForm] = react.useState(null);
			const waiting = view === null;
			react.useEffect(() => {
				if (!waiting) return;
				const controller = new AbortController();
				globalApi.tasks(controller.signal).then(setCatalog, (e) => {
					if (controller.signal.aborted) return;
					setCatalog(null);
					setError(e.message);
				});
				return () => controller.abort();
			}, [waiting]);
			const proposalAt = proposal?.at ?? null;
			react.useEffect(() => {
				if (catalog) setForm(initialForm(catalog, proposal));
			}, [catalog, proposalAt]);
			const onStart = react.useCallback(async (setup) => {
				setBusy(true);
				try {
					const body = await api.start(setup);
					setView(body.run);
					setError(null);
				} catch (e) {
					setError(e.message);
				} finally {
					setBusy(false);
				}
			}, [api]);
			return renderPanel({ view, catalog, proposal, form, onForm: setForm, error, busy, onControl, onStart });
		}

		function PanelGlyph(props) {
			const size = props?.size ?? 16;
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": true },
				h("path", { d: "M2.5 13.5h11M4 11V8M7 11V4.5M10 11V6.5M13 11V3" }));
		}

		// ---- 品牌：左上角和新会话中间的 logo ----
		// 图是 assets/logo.png（1753×307，左边螺旋、右边 DeepAutonomy 字样），经 <API>/logo 取；
		// 两部分用背景图裁出来，下面是它们在原图里的像素范围。
		const LOGO = { url: `${API}/logo`, width: 1753, height: 307 };
		const LOGO_MARK = { x: 1, y: 11, w: 205, h: 278 };
		const LOGO_NAME = { x: 267, y: 70, w: 1478, h: 182 };
		const HERO_TAGLINE = "提出假设 · 挑选实验 · 从每一轮读数里学习";
		const HERO_GUIDE = "用自然语言说说想发现什么，说得模糊也行，比如“哪些基因敲掉后 T 细胞的 IL-2 会变少”。agent 会先问清楚，推荐任务、决策方法和预算，你在右侧面板确认后才开始。";

		/** 原图里 part 那一块，按高度 height 显示。 */
		function logoPart(part, height, className) {
			const k = height / part.h;
			return h("span", {
				className,
				"aria-hidden": true,
				style: {
					display: "inline-block",
					flex: "none",
					width: `${part.w * k}px`,
					height: `${height}px`,
					backgroundImage: `url("${LOGO.url}")`,
					backgroundRepeat: "no-repeat",
					backgroundSize: `${LOGO.width * k}px ${LOGO.height * k}px`,
					backgroundPosition: `${-part.x * k}px ${-part.y * k}px`,
				},
			});
		}

		/** 侧栏的图标位：螺旋，放在 size×size 的方框中间。 */
		function BrandMark(props) {
			const size = props?.size ?? 24;
			return h("span", { className: "pp-brand-mark", style: { width: `${size}px`, height: `${size}px` } }, logoPart(LOGO_MARK, size));
		}

		/** 侧栏的名字位：DeepAutonomy 字样。 */
		function BrandName() {
			return logoPart(LOGO_NAME, 15, "pp-brand-name");
		}

		/** 新会话中间：螺旋 + 两行字。DSH 自带的“探索未至之境”标题由样式藏起来。 */
		function HeroBrand() {
			return h("span", { className: "pp-hero" },
				logoPart(LOGO_MARK, 56),
				h("span", { className: "pp-hero-text" },
					h("span", { className: "pp-hero-title" }, "PerturbPilot"),
					h("span", { className: "pp-hero-tagline" }, HERO_TAGLINE),
					h("span", { className: "pp-hero-guide" }, HERO_GUIDE)));
		}

		/** 定时取一次数据；fetcher 变了就重新开始。返回最近一次的数据和错误。 */
		function usePoll(fetcher) {
			const [data, setData] = react.useState(undefined);
			const [error, setError] = react.useState(null);
			react.useEffect(() => {
				if (!fetcher) return;
				const controller = new AbortController();
				let timer;
				const tick = async () => {
					try {
						setData(await fetcher(controller.signal));
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
			}, [fetcher]);
			return [data, error, setData];
		}

		const listRuns = (signal) => globalApi.list(signal).then((body) => body.runs);
		const viewFetchers = new Map();
		function viewFetcher(runId) {
			if (!viewFetchers.has(runId)) viewFetchers.set(runId, (signal) => globalApi.run(runId).get(signal).then((body) => body.run));
			return viewFetchers.get(runId);
		}

		function LedgerPage() {
			const [runs, listError] = usePoll(listRuns);
			const [picked, setPicked] = react.useState(null);
			const selected = picked ?? runs?.find((x) => !x.legacy)?.run_id ?? null;
			const [view, viewError, setView] = usePoll(selected ? viewFetcher(selected) : null);
			const [busy, setBusy] = react.useState(false);
			const [controlError, setControlError] = react.useState(null);
			const onControl = react.useCallback(async (action) => {
				setBusy(true);
				try {
					setView((await globalApi.run(selected).control(action)).run);
					setControlError(null);
				} catch (e) {
					setControlError(e.message);
				} finally {
					setBusy(false);
				}
			}, [selected]);
			const shown = view && view.run_id === selected ? view : view === null ? null : undefined;
			return renderLedger({ runs, selected, view: shown, error: controlError ?? viewError ?? listError, busy, onSelect: setPicked, onControl });
		}

		function SettingsSection() {
			const [status, setStatus] = react.useState(undefined);
			const [error, setError] = react.useState(null);
			const [nonce, setNonce] = react.useState(0);
			react.useEffect(() => {
				const controller = new AbortController();
				globalApi.status(controller.signal).then((s) => {
					setStatus(s);
					setError(null);
				}, (e) => {
					if (!controller.signal.aborted) setError(e.message);
				});
				return () => controller.abort();
			}, [nonce]);
			return renderSettings({ status, error, onRefresh: () => setNonce((n) => n + 1) });
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
.pp-tool{font-size:13px;line-height:1.5;margin:4px 0;padding:8px 10px;border:1px solid rgba(127,127,127,.3);border-radius:8px}
.pp-tool p{margin:4px 0}.pp-tool .pp-table{margin:4px 0}
.pp-tool-head{display:flex;gap:8px;align-items:baseline}.pp-tool-title{font-weight:600}
.pp-tool-error,.pp-tool-stopped{border-color:rgba(197,48,48,.5)}
.pp-sub{opacity:.65;font-size:12px}
.pp-pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:4px 0;padding:6px 8px;border-radius:6px;background:rgba(127,127,127,.1);max-height:320px;overflow:auto}
.pp-ledger{display:flex;height:100%;font-size:13px;line-height:1.6;box-sizing:border-box;--pp-accent:var(--dsw-alias-brand-primary,#3867d6);--pp-line:rgba(127,127,127,.22);--pp-soft:rgba(127,127,127,.07)}
.pp-ledger-side{width:232px;flex:none;border-right:1px solid var(--pp-line);padding:14px 10px;overflow:auto}
.pp-ledger-side h3{margin:0 6px 10px;font-size:14px}
.pp-ledger-main{flex:1;min-width:0;padding:20px 28px 40px;overflow:auto}
.pp-doc{max-width:1040px;margin:0 auto}
.pp-doc .pp-section{margin:28px 0 12px}.pp-doc .pp-section>h4{font-size:15px;margin:0 0 10px}
.pp-doc .pp-header .pp-title{font-size:18px}
.pp-runs{display:flex;flex-direction:column;gap:4px}
.pp-run{font:inherit;color:inherit;text-align:left;padding:8px 10px;border-radius:8px;border:1px solid transparent;background:transparent;cursor:pointer}
.pp-run:hover{background:var(--pp-soft)}.pp-run-legacy{opacity:.5;cursor:default}.pp-run-legacy:hover{background:transparent}.pp-run-active{border-color:var(--pp-line);background:rgba(127,127,127,.12)}
.pp-run-title{font-weight:600;display:flex;gap:6px;align-items:center}.pp-run-id{font-family:var(--ds-font-family-code,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-goal{margin:4px 0 16px;opacity:.8;max-width:760px}
.pp-overview{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:16px;align-items:start}
@media (max-width:900px){.pp-overview{grid-template-columns:1fr}}
.pp-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pp-stat{padding:10px 12px;border-radius:10px;background:var(--pp-soft);border:1px solid var(--pp-line)}
.pp-stat:first-child{grid-column:1/-1}
.pp-stat-label{font-size:12px;opacity:.65}.pp-stat-value{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.pp-chart{margin:0;padding:10px 12px;border-radius:10px;border:1px solid var(--pp-line)}
.pp-chart svg{display:block;overflow:visible}.pp-chart figcaption{margin-top:4px}
.pp-grid{stroke:var(--pp-line)}.pp-axis{font-size:10px;fill:currentColor;opacity:.55}
.pp-dot{fill:currentColor;opacity:.3}.pp-dot-best{fill:var(--pp-accent);opacity:1}
.pp-best-line{fill:none;stroke:var(--pp-accent);stroke-width:2;stroke-linejoin:round}
.pp-hyps{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
.pp-card{padding:10px 14px;border-radius:10px;border:1px solid var(--pp-line)}
.pp-card-head{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}
.pp-hyp-card{border-left:3px solid rgba(127,127,127,.5)}
.pp-hyp-card-supported{border-left-color:#2f8f4e}.pp-hyp-card-weakened{border-left-color:#b7791f}.pp-hyp-card-rejected{border-left-color:#c53030;opacity:.75}
.pp-hyp-supported{color:#2f8f4e;border-color:currentColor}.pp-hyp-weakened{color:#b7791f;border-color:currentColor}.pp-hyp-rejected{color:#c53030;border-color:currentColor}
.pp-text{margin:6px 0;white-space:pre-wrap;word-break:break-word}
.pp-doc details>summary{cursor:pointer}
.pp-history{margin:6px 0;padding-left:18px;font-size:12px}.pp-history li{margin:4px 0}
.pp-rounds{display:flex;flex-direction:column;gap:14px}
.pp-round{border:1px solid var(--pp-line);border-radius:12px;overflow:hidden}
.pp-round-head{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;padding:8px 14px;background:var(--pp-soft);border-bottom:1px solid var(--pp-line)}
.pp-round-no{font-weight:700;font-size:14px}
.pp-round-best{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600}
.pp-step{display:grid;grid-template-columns:96px 1fr;gap:12px;padding:8px 14px;border-bottom:1px dashed var(--pp-line)}
.pp-step-label{font-size:12px;opacity:.6;padding-top:2px}
.pp-step-body{min-width:0}
.pp-chips{display:flex;flex-wrap:wrap;gap:4px}
.pp-chip{font-family:var(--ds-font-family-code,monospace);font-size:12px;padding:0 7px;border-radius:6px;border:1px solid var(--pp-line);background:var(--pp-soft)}
.pp-chip-out{text-decoration:line-through;opacity:.55}
.pp-chip-in{border-color:var(--pp-accent);color:var(--pp-accent)}
.pp-swaps{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.pp-swaps li{display:grid;grid-template-columns:auto auto 1fr;gap:8px;align-items:baseline}
.pp-swap{white-space:nowrap}
.pp-thoughts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pp-thought{display:grid;grid-template-columns:64px 1fr;gap:8px;align-items:baseline}
.pp-thought>div{min-width:0;word-break:break-word}
.pp-kind{font-size:11px;text-align:center;padding:0 4px;border-radius:6px;background:var(--pp-soft);border:1px solid var(--pp-line);white-space:nowrap}
.pp-kind-analysis{color:#6b46c1}.pp-kind-hypothesis{color:#2f8f4e}.pp-kind-note{color:#b7791f}.pp-kind-retrieval{color:#3182ce}
.pp-bars{display:flex;flex-direction:column;gap:3px;max-width:620px}
.pp-bar-row{display:grid;grid-template-columns:92px 1fr 64px 64px;gap:8px;align-items:center;font-variant-numeric:tabular-nums}
.pp-bar-id{font-family:var(--ds-font-family-code,monospace);font-size:12px}
.pp-bar-track{height:8px;border-radius:4px;background:var(--pp-soft);overflow:hidden}
.pp-bar{display:block;height:100%;border-radius:4px;background:rgba(127,127,127,.55)}.pp-bar-in{background:var(--pp-accent)}
.pp-bar-value{text-align:right}
.pp-new-best{font-size:11px;color:var(--pp-accent);font-weight:600}
.pp-round-foot{display:flex;flex-wrap:wrap;gap:4px 12px;padding:8px 14px;font-size:12px}
.pp-round-foot .pp-check{letter-spacing:0}
.pp-fold{margin:16px 0;padding:8px 14px;border:1px solid var(--pp-line);border-radius:10px}
.pp-fold>summary{font-weight:600}.pp-fold[open]>summary{margin-bottom:8px}
.pp-settings{font-size:13px;line-height:1.5}
.pp-brand-mark{display:inline-flex;align-items:center;justify-content:center}
.pp-brand-name{vertical-align:middle}
.pp-hero{display:inline-flex;align-items:center;gap:14px;text-align:left}
.pp-hero-text{display:flex;flex-direction:column;gap:2px}
.pp-hero-title{font-size:26px;font-weight:600;line-height:32px}
.pp-hero-tagline{font-size:14px;font-weight:400;line-height:20px;opacity:.65}
.pp-hero-guide{font-size:13px;font-weight:400;line-height:19px;opacity:.55;max-width:440px;margin-top:6px}
.pp-form{display:flex;flex-direction:column;gap:8px;margin:8px 0}
.pp-form-row{display:flex;gap:8px}
.pp-form-row>.pp-field{flex:1;min-width:0}
.pp-field{display:flex;flex-direction:column;gap:3px;font-size:12px}
.pp-field-label{opacity:.7}
.pp-input{font:inherit;font-size:13px;padding:4px 6px;border:1px solid rgba(127,127,127,.35);border-radius:6px;background:transparent;color:inherit;min-width:0}
.pp-input option{color:initial}
.pp-proposal{border-left:3px solid rgba(80,130,230,.7);padding:4px 8px;margin:6px 0;background:rgba(80,130,230,.06);border-radius:4px}
.pp-proposal p{margin:2px 0 0}
[class*="_headline"]>[class*="_titleGroup"]{display:none}
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
			for (const name of TOOL_NAMES) {
				ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: name,
				}, ToolCard)), `perturbpilot: ${name} view`);
			}
			ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: LEDGER_ID,
			}, LedgerPage)), "perturbpilot: ledger page");
			ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: LEDGER_ID,
				order: 50,
				label: () => "科学台账",
			}, PanelGlyph)), "perturbpilot: ledger entry");
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: SETTINGS_ID,
				order: 90,
				label: () => "PerturbPilot",
			}, SettingsSection)), "perturbpilot: settings section");
			// 品牌位：DSH 自带的 ui-brand-official 在 cordis.patch.yml 里关掉了，这几个插槽由我们占。
			ctx.effect(() => ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark" }, BrandMark)), "perturbpilot: brand mark");
			ctx.effect(() => ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, BrandName)), "perturbpilot: brand name");
			ctx.effect(() => ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, HeroBrand)), "perturbpilot: hero brand");
		}

		exports.PANEL_ID = PANEL_ID;
		exports.PANEL_KIND = PANEL_KIND;
		exports.LEDGER_ID = LEDGER_ID;
		exports.SETTINGS_ID = SETTINGS_ID;
		exports.renderPanel = renderPanel;
		exports.renderLedger = renderLedger;
		exports.renderSettings = renderSettings;
		exports.PanelBody = PanelBody;
		exports.LedgerPage = LedgerPage;
		exports.SettingsSection = SettingsSection;
		exports.PanelGlyph = PanelGlyph;
		exports.BrandMark = BrandMark;
		exports.BrandName = BrandName;
		exports.HeroBrand = HeroBrand;
		exports.TOOL_NAMES = TOOL_NAMES;
		exports.HERO_GUIDE = HERO_GUIDE;
		exports.ToolCard = ToolCard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
