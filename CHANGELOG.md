# PerturbPilot 更新日志

## v0.1.0 — 2026-10-13

PerturbPilot v0.1 完成一次 18 个真实任务包的正式闭环运行，并开始把运行记录、工具调用、分析和文献证据纳入可审计范围。

### 已完成

- 18 个任务全部完成 10 轮；每轮提交、oracle 读数和决策模块回执在运行记录中逐轮对应。
- 运行记录落盘到 `runs/<session id>/`，包含事件、模型调用、oracle 往返、决策模块快照、检索、Python 分析和配对审计。
- 任务互斥、面板暂停/继续/结束、候选批次校验、引用已测候选校验和文献依据审计。
- 模型流式响应记录使用不干扰调用方的 pass-through reader，避免把成功请求误记成 `This operation was aborted`。
- DSH 驱动轮次在工具失败后仍能进入有限催交路径，不依赖内部 `user/message` 事件是否被回放。
- 最后一轮决策模块观测失败时保持暂停，不再错误写成完成。
- `pp_run_python` 使用 analysis-ready 环境，预装 `numpy`、`pandas`、`scipy`、`scikit-learn` 和 `statsmodels`；分析子进程不继承服务令牌和模型密钥。
- `web_fetch` 继续使用官方工具名和 PerturbPilot 检索记录；抓取后端接入 `dsh-web-access`，支持跨源重定向、页面提取和 PDF 提取，并保留 SSRF 防护配置。
- 增加重启后重新初始化服务、恢复 oracle 重复计数和恢复决策模块快照的路径。
- 启动新任务前同时检查内存中的任务和磁盘上仍处于 active/paused 的任务。

### 真实运行审计结果

- 正式任务：18 个。
- 完整轮次：180 轮。
- Python 分析调用：524 次，其中 82 次返回失败；失败分析不会写入 oracle 或决策模块状态。
- 检索调用：正式任务主要使用 `web_search`；`web_fetch` 失败会记录错误并回到任务驱动流程。
- 详细汇总：`outputs/audit_summary_20261013.tsv`。

### 环境与依赖

- DSH 基线：`@deepseek-ai/dsh` `0.1.7-rc.1`。
- web 抓取增强：`dsh-web-access` `0.2.4`。
- Python 分析依赖：见 `requirements-analysis.txt`。
- 服务端仍只使用 Python 标准库和 `numpy`；analysis-ready 依赖只供 `pp_run_python` 使用。

### 已知限制

- DSH 官方 `web-fetch-http` 本身仍然只支持文本类响应；PerturbPilot 通过独立 web provider 增强 PDF 和页面提取。不同网站的登录墙、反爬、robots 或动态渲染仍可能失败。
- oracle HTTP 提交尚未引入跨进程请求幂等键；如果进程在 oracle 已完成但响应丢失的窗口崩溃，仍需要后续补充“结果未知”状态。
- 模型调用记录已按 agent/request 异步上下文关联；仍需在真实多进程环境继续观察 DSH provider 是否把同一请求拆成多个异步阶段。
- 文献审计保持候选 ID 的严格原样匹配；别名、蛋白名和基因名映射不会自动放宽证据标准。

## v0.1.1 计划

- oracle 提交幂等和未知结果恢复。
- LLM 请求精确关联与 retrieval 调用生命周期事件。
- 更稳定的文献候选 ID 证据片段记录。
- 真实模型小规模回归：成功页面、跨源重定向、PDF、超时、失败后继续提交。
## 2026-10-13 — v0.1 收口审计补充

- DSH 运行时确认使用 `@deepseek-ai/dsh 0.1.7-rc.1`；全局旧 launcher `0.1.0-rc.6` 与本 profile 不兼容，不能混用。
- 真实 smoke test：Nature HTML 返回 HTTP 200；Nature PDF 在 8 秒内返回可处理的重定向错误并结束本轮请求，没有卡住会话。受 Nature IDP/订阅保护的 PDF 仍需要公开版本或用户权限。
- 18 个正式任务重新解析 DSH 原生 session trace：57 个真实工具错误，其中 `pp_submit_selection` 32 次、假设/证据引用 23 次、参数/schema 2 次；原先的 56 次启发式统计基本正确，但现在有原始 trace 依据。
- 524 次 Python 分析中 442 次成功、82 次失败；失败包括 22 次超时和 60 次模型生成的脚本错误。442 次成功分析中，209 次直接出现在选择理由，236 次对应 `analysis` 分组，189 次进入假设或笔记，91 次没有可持久的后续关联。
- 调整 agent 指引：提交前自检候选、减少依赖工具报错纠错；明确 H 编号、空 cites、Python 字符串 ID、避免全候选 O(n²) 扫描和必须填写 purpose。
- `pp_run_python` 默认超时从 60 秒提高到 120 秒，profile 明确使用仓库 `.venv\Scripts\python.exe`。
- 文献审计仍有 13 个 `literature_backed` 失败和 4 个 `cited_later` 失败。前者主要是搜索结果没有原样出现候选 ID，后者是最后几轮没有后续假设/笔记可供引用；这两类不能用放宽审计规则来伪装成通过。
- 模型调用 trace 关联从全局最近请求改为异步请求上下文，补充了并发 agent 回归测试。
