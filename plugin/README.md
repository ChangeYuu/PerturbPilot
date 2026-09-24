# PerturbPilot 插件（v0.1）

PerturbPilot 是一个 DSH 插件，负责把一次扰动筛选任务接进 DSH 的一个会话里：

- 一个会话跑一个任务，由用户在右侧栏的 PerturbPilot 面板上点“开始任务”发起。一轮就是一个 DSH turn；开始后框架开第 1 轮，本轮提交后再用 followup 开下一轮。
- 每轮 agent 必须先调 `pp_get_decision` 拿决策模块的推荐（带方法名和各候选的数值），再用 `pp_submit_selection` 直接交一批 `batch` 和分组理由 `groups`。批量必须正好等于任务的 `batch_size`；不许重复测时，候选不够一整批的最后一轮交剩下的全部。推荐以外的候选必须放进一个写了理由的组，`source` 取 decision / prior_knowledge / literature / analysis / hypothesis_test / exploration / data_quality，推荐以外的不能标 decision。之后由框架把这一批交给 oracle 测量，并把读数回灌给决策模块。
- 任务是通用的：扰动方式、读数字段、目标（在哪个字段上取高或取低）、预算、候选表和公开数据都来自任务包（见下面“任务包”）。读数可以有多个字段，也可以为空（空读数照常记录，决策模块在回执里拒收）。
- 查文献：“科学发现”模式挂了 DSH 的 `web_search` / `web_fetch`。插件只记录这些调用（`retrieval/`），不拦截；审计里的“文献核对”事后检查：写了 `literature` 理由的候选，本轮提交前成功的检索结果全文里有没有提到它的 id。
- 科学状态（读数、假设、笔记）存在会话之外，每一步通过 `systemPrompt.context` 注入 `<perturbpilot_state>` 简报，所以上下文压缩后也不会丢。
- 本轮快结束还没提交时，框架最多催 `maxSteers` 次；催完仍没交，就暂停等人处理。
- 浏览器面板：DSH web 端右侧栏里的 “PerturbPilot 任务” 页（点右侧栏的 “+” 打开），每 2 秒刷新本会话的任务状态、各轮推荐 / 选择 / 读数 / 审计、读数排名、假设、笔记、检索和最近事件，并有暂停 / 继续 / 结束按钮。会话还没有任务时，这一页显示服务当前载入的任务卡片和“开始任务”按钮。对话照常在 DSH 的对话区进行。
- 科学台账页：左侧栏的 “科学台账” 入口打开一个占满主区的页面。左边列出 `runs/` 下所有任务（最近更新的在前，默认选第一个；早期格式的记录标“旧格式”，只列出、点不开），右边是选中任务的记录，从上往下：总览（目标、当前最佳、已测多少、推荐以外的有多少、审计，加一张每轮读数和至今最佳的进展图）；当前结论（每条假设的最新状态，可展开看历次更新）；逐轮记录（每轮一张卡片，按“决策模块推荐 → 分析与判断（含检索） → 本轮测的和分组理由 → 读数 → 审计和回执”排）；最后折叠着全部读数排名和最近事件。也有暂停 / 继续 / 结束按钮。
- 设置里的 “PerturbPilot” 一页：oracle 和决策模块连不连得上、服务令牌设了没有、插件当前的配置。这一页只读。
- 数据分析：agent 可以调 `pp_run_python(code, purpose)`，在这次分析自己的目录里跑一段 Python（numpy 可用）。目录里事先导出了 `observations.csv`（id, round, replicate, 再加每个读数字段一列，空读数留空）、`candidates.csv`（任务包的候选表原样）、`data/`（任务包里公开的数据文件）和 `decision.csv`（本轮决策模块给的全候选池：id, measured, 再加方法给的数值列）。这个工具不能测量新候选：两个服务都要求 `x-perturbpilot-token` 头，令牌只有框架有，Python 子进程拿到的环境变量是白名单里的那几项，不含令牌和模型密钥。
  - **Windows 上没有沙箱。** 子进程能读写本机文件，包括 oracle 的源码；令牌只防它直接调服务测量。所有代码和输出都记录下来，可以事后查。
- 对话区里每个 `pp_*` 工具调用显示成卡片：推荐表（按方法给的数值列显示）、本轮提交的批次和分组理由、读数表、假设和笔记，不再是原始 JSON。
- 专用模式：插件的 bundle patch（`cordis.patch.yml`）只留一个“科学发现”模式。这个模式只有 `pp_*` 工具、`web_search` / `web_fetch` 和上下文压缩，没有 shell、文件读写、子 agent、计划模式、技能，也不读工作区里的 AGENTS.md / CLAUDE.md。web 端自带的 4 个模式、模式选择器、计划模式开关、预设设置页和插件设置页都关掉了。

## 运行记录 `runs/<会话 id>/`

| 文件 | 内容 |
|---|---|
| `events.jsonl` | 事件流：`seq, ts, run_id, round, type, source, data`。source 取值为 framework / model / environment / human / decision |
| `llm_calls.jsonl` | 发往模型服务的原始请求体和响应体，挂在最近一次 `agent/request` 的 turn/step 上。**不存请求头和响应头**，URL 去掉 query |
| `decision/NN-propose-K.json`、`NN-observe.json`、`NN-snapshot.json` | 决策模块的原始往返：推荐（含全候选池）、回执、可恢复快照 |
| `oracle/NN-run.json` | oracle 的原始读数 |
| `state.json` / `memory.json` | 完整运行状态（`format: 2`；没有这个字段的是早期格式，面板标“旧格式”，插件不再打开）/ 假设和笔记 |
| `retrieval/R<N>.json` | 第 N 次 `web_search` / `web_fetch`：参数、结果全文、所在轮。每次对应一条 `retrieval/searched` 或 `retrieval/fetched` 事件 |
| `analysis/A<N>/` | 第 N 次 `pp_run_python`：`code.py`、导出的 `observations.csv`、`candidates.csv`、`data/`、`decision.csv`、`stdout.txt`、`stderr.txt`，以及脚本自己写出的文件。每次对应一条 `analysis/executed` 事件（`id, purpose, exit_code, timed_out, duration_ms, dir, files`） |
| `audit.json` | 配对审计，每轮检查：调用了决策模块 → 提交了选择 → 文献核对（literature 组里的候选 id 按整词、不分大小写，在本轮提交前成功的检索结果全文里找；没找到的列在 `unbacked`，有一个就不通过；本批里没标 literature、但检索里提到了的列在 `unlabelled`，只作参考；本轮既没有 literature 组也没有成功的检索时为 n/a）→ 回执完整（收下的加拒收的对得上本轮读数）且版本号 +1 → 下一轮用的状态版本对得上。另外还查后面是否有假设或笔记引用了本轮的读数 |

## 启动

需要满足：

- **Node ≥ 22.19**。DSH 0.1.7-rc.1 的入口用了 `import.meta.main`，Node 22.14 上 `dsh` 什么都不做就退出。本机 `C:\Program Files\nodejs` 是 22.14；`D:\DeepSeek\npm-global\node.exe` 是 22.23.2，下面的命令都用它。
- 用插件目录里装的 DSH 0.1.7-rc.1（`plugin\node_modules\@deepseek-ai\dsh`），不要用全局的 `dsh`（全局那个是 0.1.0-rc.6）。
- 不需要 pnpm：第 3 步用 `scripts/link-profile.js` 代替 `dsh plugin add`（后者会转发给 pnpm）。

在 PowerShell 里依次执行：

```powershell
# 1. 起 oracle 和决策模块（另开一个窗口，常驻）。令牌随便取一个随机串，这个窗口和第 4 步的窗口要设成同一个值
#    不加 --task 就用合成任务；--task 指向任务包目录，--hidden 指向它的隐藏数据目录（在任务包外面，两个要一起给）。--decision 选方法（auto / gp-ucb / coverage，auto 按任务包里有没有嵌入特征决定）
$env:PERTURBPILOT_SERVICE_TOKEN = '<随机串>'
cd D:\internwork\科学发现智能体系统\services
..\.venv\Scripts\python -m ppsvc --seed 0
# 或：..\.venv\Scripts\python -m ppsvc --task D:\internwork\pp-tasks\il2 --hidden D:\internwork\pp-tasks-hidden\il2

# 2. 密钥只放进环境变量，不写进任何文件；DSH_HOME 用单独的目录，不和日常用的 DSH 共用会话、工作区和设置
$env:DEEPSEEK_API_KEY = (Get-Content <密钥文件> -Raw).Trim()
$env:DSH_HOME = 'D:\DeepSeek\pp-home'

# 3. 第一次用时：建空 profile，再把插件挂进去（不经过 pnpm）
$node = 'D:\DeepSeek\npm-global\node.exe'
$dsh = 'D:\internwork\科学发现智能体系统\plugin\node_modules\@deepseek-ai\dsh\lib\bin.js'
& $node $dsh plugin --profile perturbpilot version-exemptions
& $node D:\internwork\科学发现智能体系统\plugin\scripts\link-profile.js perturbpilot
& $node $dsh --profile perturbpilot --dump-config    # 应当有 perturbpilot 和 preset-perturbpilot 两行，preset-standard 等 4 个预设是 disabled: true

# 4. 启动，在浏览器里打开它打印的地址（这个窗口也要先设同一个 $env:PERTURBPILOT_SERVICE_TOKEN）
cd D:\internwork\科学发现智能体系统
& $node $dsh --profile perturbpilot
```

面板的数据走同源路由 `/perturbpilot/api`：`GET /sessions` 列出所有任务，`GET /status` 返回配置和服务是否连得上（不返回令牌本身），`GET /task` 返回服务当前载入的任务卡片（开始任务前预览，不含 `package_dir`），`/sessions/<会话 id>`（GET 读视图，`POST .../start` 带 `{}` 开始任务，`POST .../control` 带 `{"action": "pause"|"resume"|"stop"}` 控制；POST 要求 `content-type: application/json` 和 `x-perturbpilot: 1` 头）。只有带 web 服务的组合（web 模板）才挂这个路由。

新建一个会话，在右侧栏打开 “PerturbPilot 任务” 页，确认任务卡片后点“开始任务”：框架把任务包交给决策模块、清空 oracle 的状态、建好 `runs/<会话 id>/`，然后自动开第 1 轮，之后按轮推进。会话正忙时，第 1 轮等它空下来再开。随时可以在对话里插话；暂停 / 继续 / 结束可以点面板上的按钮，也可以对 agent 说，由它调用 `pp_control`。

### 任务包

任务包是仓库外的一个目录，oracle 和决策模块共同读取。agent 能看到任务包里的所有文件（分析工具会把公开数据拷进分析目录，脚本也能列出任务包），所以隐藏读数单独放在任务包外面的另一个目录，只有 oracle 读：

```
<任务包>/
  task.json        公开的任务卡片：task_id, title, synthetic, brief, action, readout.fields, objective{kind, field, direction, description}, budget{rounds, batch_size, allow_repeats}, data_cards
  candidates.csv   id + 公开属性列
  data/            data_cards 里列出的公开数据文件

<隐藏数据目录>/     服务启动时用 --hidden 指定
  scores.csv       id + 各读数字段
  hits.txt         命中名单，可选；运行时不读，事后评估用
```

任务包里还有 `hidden/` 目录（早期布局）时，服务拒绝启动；隐藏数据目录在任务包里面时也拒绝。

PerturbTrace（ptbench）的任务可以转换过来（转换器用到 pyyaml，只有它用）：

```powershell
cd D:\internwork\科学发现智能体系统\services
..\.venv\Scripts\python -m ppsvc.import_ptbench <ptbench 任务目录> D:\internwork\pp-tasks\<名字> D:\internwork\pp-tasks-hidden\<名字>
```

转换只搬可以给 agent 看的字段；数据集来源、原始列名、命中名单都不进 `task.json`，读数表和命中名单写进第三个参数给的隐藏数据目录。任务包和隐藏数据目录都不要提交进仓库。

### 配置

要改配置，就在 `$DSH_HOME/profiles/perturbpilot/cordis.patch.yml` 里按 id 覆盖 `perturbpilot` 这一行的 `config`：

| 键 | 默认值 | 含义 |
|---|---|---|
| `oracleUrl` | `http://127.0.0.1:8701` | oracle 服务 |
| `decisionUrl` | `http://127.0.0.1:8702` | 决策模块服务 |
| `runsDir` | `runs` | 运行目录，相对于启动 dsh 的目录 |
| `llmUrlPattern` | `deepseek` | URL 命中这个正则的 fetch 调用记为模型调用 |
| `maxSteers` | `2` | 一轮里最多催几次 |
| `pythonPath` | `python` | `pp_run_python` 用的 Python。只写名字就从 PATH 找；带目录的相对路径按启动 dsh 的目录解析。建议设成 `.venv\Scripts\python.exe`（有 numpy） |
| `pythonTimeoutMs` | `60000` | 一次分析最长跑多久，超时杀掉 |
| `serviceTokenEnv` | `PERTURBPILOT_SERVICE_TOKEN` | 服务令牌所在的环境变量名。没设这个变量时服务不查令牌（ppsvc 启动时会警告），分析用的 Python 就能直接调服务 |

## 测试

```powershell
cd D:\internwork\科学发现智能体系统\plugin
node --test "test/*.test.js"
cd ..
.venv\Scripts\python -m pytest -q
```

测试不联网、不需要密钥。分析工具的测试会真的起 Python 子进程（优先用仓库的 `.venv`）。oracle 和决策模块用本地替身，DSH 宿主用最小替身；被测的插件代码照常运行。
