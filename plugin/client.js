// PerturbPilot 的浏览器端：
// - DSH web 端右侧栏的一个页面型 tab，显示当前会话里这次任务的状态，并提供暂停 / 继续 / 结束。
// - 主区的"科学台账"页（左侧栏有入口）：列出所有任务，选一个看全部轮次、读数、假设历史、笔记、分析和审计。
// - 设置里的 PerturbPilot 一页：只读显示插件配置、服务连不连得上、服务令牌设没设。
//   数据都来自宿主侧挂在同源 web 服务上的 /perturbpilot/api（见 lib/panel.js）。
// - 对话区里每个 pp_* 工具调用的卡片（推荐表、替换理由和读数、假设、笔记、分析），代替通用的参数/结果行。
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

		// 科学台账页和设置页不绑会话：先列出所有任务，再按任务 id 取视图。
		const globalApi = {
			list: (signal) => fetch(`${API}/sessions`, { signal, cache: "no-store" }).then(parse),
			status: (signal) => fetch(`${API}/status`, { signal, cache: "no-store" }).then(parse),
			run: apiFor,
		};

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

		// ---- 主区的科学台账页：一个任务的全部记录，不截断 ----

		function fullRoundsSection(view) {
			const rows = view.rounds.map((r) => {
				const s = r.submission;
				const choice = !s ? (r.proposals ? "未提交" : "—") : h("div", null,
					h("div", null, `接受：${s.accept.join(", ") || "无"}`),
					...s.replace.map((x) => h("div", null,
						h("b", null, `${x.out} → ${x.in}`), " ",
						h("span", { className: "pp-hyp" }, REASON_TEXT[x.reason_type] ?? x.reason_type), x.reason)));
				const receipt = r.receipt
					? `收下 ${r.receipt.accepted}${r.receipt.rejected ? `，拒收 ${r.receipt.rejected}` : ""}；状态版本 ${r.receipt.state_version_before}→${r.receipt.state_version_after}`
					: "—";
				return [
					String(r.round),
					r.recommendations.join(", ") || "—",
					choice,
					r.results ? r.results.map((x) => `${x.id}=${x.value}${x.replicate ? "(复)" : ""}`).join(", ") : "—",
					receipt,
					auditCell(r.checks),
				];
			});
			const c = view.audit_counts;
			return section(`各轮（审计：${c.pass} 通过 · ${c.fail} 不通过 · ${c.pending} 待定）`,
				rows.length ? table(["轮", "推荐", "选择与替换理由", "读数", "回执", "审计"], rows) : h("p", { className: "pp-empty" }, "还没有轮次"),
				h("p", { className: "pp-legend" }, `审计五项依次是：${CHECKS.map(([, label]) => label).join(" / ")}`));
		}

		function fullObservationsSection(view) {
			return section(`读数排名（共 ${view.observations.length} 条）`,
				view.observations.length
					? table(["名次", "候选", "读数", "轮"], view.observations.map((o, i) => [String(i + 1), o.id + (o.replicate ? `（第 ${o.replicate + 1} 次测）` : ""), String(o.value), String(o.round)]))
					: h("p", { className: "pp-empty" }, "还没有读数"));
		}

		function fullHypothesesSection(view) {
			return section(`假设（${view.hypotheses.length}）`,
				view.hypotheses.length ? h("ul", { className: "pp-list" }, ...view.hypotheses.map((x) => h("li", null,
					h("div", null,
						h("b", null, x.id), h("span", { className: `pp-hyp pp-hyp-${x.status}` }, HYPOTHESIS_TEXT[x.status] ?? x.status), x.text,
						h("span", { className: "pp-cites" }, `第 ${x.created_round} 轮提出`)),
					x.history?.length ? h("ol", { className: "pp-history" }, ...x.history.map((e) => h("li", null,
						`第 ${e.round} 轮 `,
						h("span", { className: `pp-hyp pp-hyp-${e.status}` }, HYPOTHESIS_TEXT[e.status] ?? e.status),
						e.rationale ?? "",
						e.cites?.length ? h("span", { className: "pp-cites" }, `引用 ${e.cites.join(", ")}`) : null))) : null)))
					: h("p", { className: "pp-empty" }, "还没有假设"));
		}

		function fullNotesSection(view) {
			return section(`笔记（${view.notes.length}）`,
				view.notes.length ? h("ul", { className: "pp-list" }, ...view.notes.map((x) => h("li", null,
					h("b", null, x.id), `第 ${x.round} 轮：`, x.text,
					x.cites?.length ? h("span", { className: "pp-cites" }, `引用 ${x.cites.join(", ")}`) : null)))
					: h("p", { className: "pp-empty" }, "还没有笔记"));
		}

		function analysesSection(view) {
			const list = view.analyses ?? [];
			return section(`Python 分析（${list.length}）`,
				list.length ? table(["编号", "轮", "要回答什么", "结果", "输出文件", "目录"], list.map((a) => [
					a.id,
					String(a.round),
					a.purpose,
					a.timed_out ? "超时" : a.exit_code === 0 ? `完成（${a.duration_ms} ms）` : a.exit_code === null ? "没启动" : `出错（退出码 ${a.exit_code}）`,
					a.files?.join(", ") || "—",
					a.dir,
				])) : h("p", { className: "pp-empty" }, "还没有跑过分析"));
		}

		function runListItem(item, selected, onSelect) {
			return h("button", {
				className: `pp-run${item.run_id === selected ? " pp-run-active" : ""}`,
				onClick: () => onSelect(item.run_id),
			},
				h("div", { className: "pp-run-title" }, item.title, item.synthetic ? h("span", { className: "pp-tag" }, "合成") : null),
				h("div", { className: "pp-sub" },
					h("span", { className: `pp-status pp-status-${item.status}` }, STATUS_TEXT[item.status] ?? item.status),
					` · 第 ${Math.min(item.round, item.max_rounds ?? item.round)}/${item.max_rounds ?? "?"} 轮 · ${(item.updated ?? "").slice(0, 16).replace("T", " ")}`),
				h("div", { className: "pp-sub pp-run-id" }, item.run_id));
		}

		/** 科学台账页。runs 为 undefined 表示加载中；selected 是选中的任务 id；view 同 renderPanel。 */
		function renderLedger({ runs, selected, view, error, busy, onSelect, onControl }) {
			const banner = error ? h("div", { className: "pp-error" }, `出错了：${error}`) : null;
			const list = runs === undefined ? h("p", { className: "pp-empty" }, "加载中…")
				: runs.length === 0 ? h("p", { className: "pp-empty" }, "还没有任务。新建一个会话，对 agent 说“开始任务”。")
					: h("div", { className: "pp-runs" }, ...runs.map((x) => runListItem(x, selected, onSelect)));
			let body;
			if (!selected) body = h("p", { className: "pp-empty" }, runs?.length === 0 ? "" : "选一个任务");
			else if (view === undefined) body = h("p", { className: "pp-empty" }, "加载中…");
			else if (view === null) body = h("p", { className: "pp-empty" }, "这个任务的记录读不到了");
			else {
				body = h("div", null,
					header(view, busy, onControl),
					fullRoundsSection(view),
					fullObservationsSection(view),
					fullHypothesesSection(view),
					fullNotesSection(view),
					analysesSection(view),
					eventsSection(view));
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
				? h("span", { className: "pp-pass" }, `连得上 ${s.task_id ?? ""}${s.name ? `${s.name} ${s.version}` : ""}${s.synthetic ? "（合成数据）" : ""}`)
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
			pp_start_task: "开始任务",
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
			pp_start_task: (args, r) => r && h("p", null,
				r.already_started ? "任务已经开始过，" : "",
				`${r.task?.title ?? ""}：共 ${r.task?.max_rounds} 轮，每轮 ${r.task?.batch_size} 个，候选 ${r.task?.n_candidates} 个`,
				r.task?.synthetic ? h("span", { className: "pp-tag" }, "合成数据") : null),
			pp_get_decision: (args, r) => r && h("div", null,
				h("p", { className: "pp-sub" }, `第 ${r.round}/${r.max_rounds} 轮 · 基于 ${r.n_observations} 条读数（状态版本 ${r.state_version}）`),
				table(["推荐", "预测均值", "不确定度", "得分"], r.recommendations.map((x) => [x.id, num(x.mu), num(x.sigma), num(x.score)])),
				r.alternatives?.length ? h("p", { className: "pp-sub" }, `备选：${r.alternatives.map((x) => x.id).join(", ")}`) : null),
			pp_submit_selection: (args, r) => h("div", null,
				args ? h("p", null,
					`接受 ${args.accept?.length ?? 0} 个推荐`,
					args.replace?.length ? `，替换 ${args.replace.length} 个` : "，没有替换") : null,
				args?.replace?.length ? h("ul", { className: "pp-list" }, ...args.replace.map((x) => h("li", null,
					h("b", null, `${x.out} → ${x.in}`),
					h("span", { className: "pp-hyp" }, REASON_TEXT[x.reason_type] ?? x.reason_type), x.reason))) : null,
				r?.problem ? h("div", { className: "pp-error" }, r.problem) : null,
				r?.results ? table(["候选", "读数", "来源"], [...r.results].sort((a, b) => b.value - a.value).map((x) => [
					x.id + (x.replicate ? "（复测）" : ""), num(x.value), x.recommended ? "推荐" : "替换进来"])) : null,
				r?.next ? h("p", { className: "pp-sub" }, r.next.finished ? "任务完成" : `下一轮：第 ${r.next.round}/${r.next.max_rounds} 轮`) : null),
			pp_update_hypothesis: (args, r) => h("p", null,
				h("b", null, r?.id ?? args?.id ?? "新假设"),
				args?.status ? h("span", { className: `pp-hyp pp-hyp-${args.status}` }, HYPOTHESIS_TEXT[args.status] ?? args.status) : null,
				args?.text ?? "",
				args?.rationale ? h("span", { className: "pp-sub" }, ` 理由：${args.rationale}`) : null,
				cites(args?.cites)),
			pp_write_note: (args, r) => h("p", null, r?.id ? h("b", null, r.id) : null, args?.text ?? "", cites(args?.cites)),
			pp_get_ledger: (args, r) => r && h("p", { className: "pp-sub" },
				`${r.observations?.length ?? 0} 条读数 · ${r.hypotheses?.length ?? 0} 条假设 · ${r.notes?.length ?? 0} 条笔记`),
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

		function PanelGlyph(props) {
			const size = props?.size ?? 16;
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": true },
				h("path", { d: "M2.5 13.5h11M4 11V8M7 11V4.5M10 11V6.5M13 11V3" }));
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
			const selected = picked ?? runs?.[0]?.run_id ?? null;
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
.pp-ledger{display:flex;height:100%;font-size:13px;line-height:1.5;box-sizing:border-box}
.pp-ledger-side{width:240px;flex:none;border-right:1px solid rgba(127,127,127,.25);padding:12px;overflow:auto}
.pp-ledger-side h3{margin:0 0 8px;font-size:14px}
.pp-ledger-main{flex:1;min-width:0;padding:16px 24px;overflow:auto}
.pp-runs{display:flex;flex-direction:column;gap:4px}
.pp-run{font:inherit;color:inherit;text-align:left;padding:6px 8px;border-radius:6px;border:1px solid transparent;background:transparent;cursor:pointer}
.pp-run:hover{background:rgba(127,127,127,.1)}.pp-run-active{border-color:rgba(127,127,127,.45);background:rgba(127,127,127,.12)}
.pp-run-title{font-weight:600;display:flex;gap:6px;align-items:center}.pp-run-id{font-family:monospace;overflow:hidden;text-overflow:ellipsis}
.pp-history{margin:2px 0 6px;padding-left:18px;font-size:12px;opacity:.85}
.pp-settings{font-size:13px;line-height:1.5}
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
		exports.TOOL_NAMES = TOOL_NAMES;
		exports.ToolCard = ToolCard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
