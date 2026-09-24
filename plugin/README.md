# PerturbPilot 插件（v0.1）

PerturbPilot 是一个 DSH 插件，负责把一次扰动筛选任务接进 DSH 的一个会话里：

- 一个会话跑一个任务，一轮就是一个 DSH turn。本轮提交后，框架用 followup 开下一轮。
- agent 调 `pp_get_decision` 拿决策模块的推荐，再用 `pp_submit_selection` 接受或替换（替换要写理由）。之后由框架把这一批交给 oracle 测量，并把读数回灌给决策模块。
- 科学状态（读数、假设、笔记）存在会话之外，每一步通过 `systemPrompt.context` 注入 `<perturbpilot_state>` 简报，所以上下文压缩后也不会丢。
- 本轮快结束还没提交时，框架最多催 `maxSteers` 次；催完仍没交，就暂停等人处理。
- 浏览器面板：DSH web 端右侧栏里的 “PerturbPilot 任务” 页（点右侧栏的 “+” 打开），每 2 秒刷新本会话的任务状态、各轮推荐 / 选择 / 读数 / 审计、读数排名、假设、笔记和最近事件，并有暂停 / 继续 / 结束按钮。对话照常在 DSH 的对话区进行。

## 运行记录 `runs/<会话 id>/`

| 文件 | 内容 |
|---|---|
| `events.jsonl` | 事件流：`seq, ts, run_id, round, type, source, data`。source 取值为 framework / model / environment / human / decision |
| `llm_calls.jsonl` | 发往模型服务的原始请求体和响应体，挂在最近一次 `agent/request` 的 turn/step 上。**不存请求头和响应头**，URL 去掉 query |
| `decision/NN-propose-K.json`、`NN-observe.json`、`NN-snapshot.json` | 决策模块的原始往返：推荐（含全候选池）、回执、可恢复快照 |
| `oracle/NN-run.json` | oracle 的原始读数 |
| `state.json` / `memory.json` | 完整运行状态 / 假设和笔记 |
| `audit.json` | 配对审计，每轮检查四项：调用了决策模块 → 提交了选择 → 回执完整且版本号 +1 → 下一轮用的状态版本对得上。另外还查后面是否有假设或笔记引用了本轮的读数 |

## 启动

需要满足：

- **Node ≥ 22.19**。DSH 0.1.7-rc.1 的入口用了 `import.meta.main`，Node 22.14 上 `dsh` 什么都不做就退出。本机 `C:\Program Files\nodejs` 是 22.14；`D:\DeepSeek\npm-global\node.exe` 是 22.23.2，下面的命令都用它。
- 用插件目录里装的 DSH 0.1.7-rc.1（`plugin\node_modules\@deepseek-ai\dsh`），不要用全局的 `dsh`（全局那个是 0.1.0-rc.6）。
- 不需要 pnpm：第 3 步用 `scripts/link-profile.js` 代替 `dsh plugin add`（后者会转发给 pnpm）。

在 PowerShell 里依次执行：

```powershell
# 1. 起 oracle 和决策模块（另开一个窗口，常驻）
cd D:\internwork\科学发现智能体系统\services
..\.venv\Scripts\python -m ppsvc --seed 0

# 2. 密钥只放进环境变量，不写进任何文件
$env:DEEPSEEK_API_KEY = (Get-Content <密钥文件> -Raw).Trim()

# 3. 第一次用时：建空 profile，再把插件挂进去（不经过 pnpm）
$node = 'D:\DeepSeek\npm-global\node.exe'
$dsh = 'D:\internwork\科学发现智能体系统\plugin\node_modules\@deepseek-ai\dsh\lib\bin.js'
& $node $dsh plugin --profile perturbpilot version-exemptions
& $node D:\internwork\科学发现智能体系统\plugin\scripts\link-profile.js perturbpilot
& $node $dsh --profile perturbpilot --dump-config    # 输出里应当有 id: perturbpilot 这一行

# 4. 启动，在浏览器里打开它打印的地址
cd D:\internwork\科学发现智能体系统
& $node $dsh --profile perturbpilot
```

面板的数据走同源路由 `/perturbpilot/api/sessions/<会话 id>`（GET 读视图，`POST .../control` 带 `{"action": "pause"|"resume"|"stop"}` 控制；POST 要求 `content-type: application/json` 和 `x-perturbpilot: 1` 头）。只有带 web 服务的组合（web 模板）才挂这个路由。

会话里对 agent 说"开始任务"，它会调用 `pp_start_task`，之后按轮自动推进。随时可以插话；"暂停 / 继续 / 结束"由 agent 调用 `pp_control` 执行。

### 配置

要改配置，就在 `$DSH_HOME/profiles/perturbpilot/cordis.patch.yml` 里按 id 覆盖 `perturbpilot` 这一行的 `config`：

| 键 | 默认值 | 含义 |
|---|---|---|
| `oracleUrl` | `http://127.0.0.1:8701` | oracle 服务 |
| `decisionUrl` | `http://127.0.0.1:8702` | 决策模块服务 |
| `runsDir` | `runs` | 运行目录，相对于启动 dsh 的目录 |
| `llmUrlPattern` | `deepseek` | URL 命中这个正则的 fetch 调用记为模型调用 |
| `maxSteers` | `2` | 一轮里最多催几次 |

## 测试

```powershell
cd D:\internwork\科学发现智能体系统\plugin
node --test "test/*.test.js"
cd ..
.venv\Scripts\python -m pytest -q
```

测试不联网、不需要密钥。oracle 和决策模块用本地替身，DSH 宿主用最小替身；被测的插件代码照常运行。
