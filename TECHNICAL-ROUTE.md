# 技术路线：DSH 内核 + 能做科学发现的 Agent

> 2026-09-23 · 状态：**待拍板**
> 范围：`D:\internwork\科学发现智能体系统\`（已清空重来，git 已建）
> 依据：归档 `D:\_archive\科学发现智能体系统-20260923\`（含 DSH 完整源码 checkout）

---

## 一、结论先行

**1. DSH 不是一个 harness，是一套"能力缝 + 官方插件层"。**
`packages/` 下 50+ 个能力组，架构上区分 **Service Definition / Service Provider / Consumer** 三种角色，
扩展方式是"实现一个 Provider，通过 `bundle` 的 patch layer 挂进 profile"。
`dsh-agent-loop` 本身都是可替换的。

**2. 上一轮（B 套）失败的主因不是实现质量，是"在 DSH 旁边平行实现"。**
B 套用 Python 重写了审批、durable workflow、告警、存储、session 索引、训练接口——
而 DSH 自带 `interaction/user-approval`、`jobs`、`storage`、`session-query`、`credentials`。
这直接违背它自己 `plan.md` §2.1 写的"不要重新实现已经由 DSH 解决的通用执行能力"。
**结果：1.2 MB 的 Python 代码只换来一个"薄 adapter + 1 个工具插件"，而 DSH 只被用到皮毛。**

**3. 但 DSH 确实有真缺口，不能全指望它。**
`workflow/` 是**进程内**的 subagent fan-out，不是跨天 durable execution；
`webhook/` 的 README 明确写着"no delivery database, queue, retry, deduplication, or Agent-completion state"。
所以 durable 层要自己补——**但补的范围必须先论证，这正是 B 套没做的。**

---

## 二、已验事实（有归档证据，勿重查）

### A. DSH 基线

| 项 | 值 | 证据位置 |
|---|---|---|
| 仓库 | `github.com/deepseek-ai/deepseek-harness` | 归档 `research/upstream-dsh/dsh/.git` |
| 许可证 | MIT（Copyright DeepSeek 2026） | 同上 `LICENSE` |
| 锁定 commit | `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`（= 0.1.7-alpha.1 merge） | `git rev-parse HEAD` |
| **完整源码 checkout** | **161 MB / 13176 文件，工作树干净** | 归档 `research/upstream-dsh/dsh/` |
| 版本 | `@deepseek-ai/dsh-root@0.1.7-alpha.1`，pnpm 11.7.0 | 根 `package.json` |
| Node | `^22.19.0 \|\| >=24.0.0` | 同上 |

> ⚠️ **上一轮 Phase 0 从未验收**，理由是"完整浅克隆在代理不可用时卡住"。
> **但归档里现在有一份完整的、HEAD 正好是锁定 commit 的 checkout。**
> 这意味着 Phase 0 的源码核对门槛**可以离线补上**——这是本次最省力的起手。

### B. 集成边界

- **Python SDK 走 stdio newline-delimited JSON-RPC**，启动 `dsh --profile sdk`。
  **必须显式传 `dsh_home`**——SDK 故意不发现 `~/.dsh`。（`python/sdk/README.md`）
- **StreamChunk 七种块**：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` /
  `block-end` / `usage` / `finish`。**tool arguments 保持原始 JSON 字符串**。
  （`packages/llm/llm/src/types.ts`，526 行）
- `LlmAdapter` / `LlmRuntime` / `PreparedAdapterCall` 定义在
  `packages/llm/llm/src/index.ts`（1153 行），通过 `llm/stream` waterfall 注册。
- **实测运行时事件序列**（无凭证，finish reason = `error` / `MISSING_CREDENTIAL`）：
  ```
  agent/inbox/spliced → turn/start → step/start → user/message → request/header
  → request/context → assistant/chunk → step/end → turn/end → session.status(idle)
  ```
- **插件注册**：`ctx.tools.register(defineTool(...))`，通过 `cordis.patch.yml` 挂载。
- **profile patch 机制**（官方扩展入口）：包声明 `dsh.bundle.patch`，
  launcher 按顺序叠加 patch 文档组成命名 profile。**"Domain packages can declare additional layers outside this directory"** ——
  即领域层可以在 `packages/` 之外自带 patch layer。（`packages/bundle/README.md`）
- `RunResult(session_id, final_response, finish_reason, events, notifications)`；
  `Session.run()` 的 activity interval = prompt 的 durable inbox receipt → 下一个 whole-agent idle。
  `events` 只含 root session，`notifications` 含 root + 已知 descendants。

### C. 已跑通的证据（不是推演）

| 结论 | 证据 |
|---|---|
| 真实 provider 调用成功 | `outputs/runs_contracts/model-probe-userkey-20260923.json`，返回 `READY` + usage + 正常 finish |
| 真实 tool-call 成功 | `outputs/runs_contracts/model-toolcall-userkey-20260923.json`，`tool/call` → `tool/result` |
| 工具注册成功 | `dsh-plugin-probe-20260923-v7.json`，`request/header.tools` 含 `scientific_summary`，工具总数 3 |
| web profile 可启动 | 独立 web home + `patchReload=startup`；**复用 SDK profile 的 `.jsonl` session 存储会失败** |
| 同端口科研页 | DSH `webServer.register` 注册 `/scientific`，8882 端口验证 200 |

---

## 三、DSH 已有什么 / 缺什么（路线图的骨架）

### ✅ 直接复用（不要再自己写）

| 科研系统需要 | DSH 对应 | ctx key |
|---|---|---|
| LLM 调用 + 流式 + **CoT 保留** | `llm/`（`reasoning-delta` 是一等块） | `ctx.llm` |
| Agent loop | `core/`（**可替换**） | — |
| 工具注册 | `defineTool` + `ctx.tools.register` | `ctx.tools` |
| **审批 / 人工确认** | `interaction/user-approval`（一次性 allow/reject，**无审批则 fail closed**） | `ctx.approval` |
| 权限预设（沙箱+审批联动） | `interaction/permission-preset` | — |
| 斜杠命令 | `interaction/commands` | `ctx.commands` |
| 后台任务 | `jobs/`（generic background-job runtime + 模型可调用的 job 控制） | — |
| Session 持久化 + 投影 | `session/`（persistence seam + backends、projection、checkpoint policy） | — |
| Session 检索（SQLite FTS） | `session-query/` | — |
| 非 session 存储 | `storage/` | — |
| 凭证（含"问人"授权流） | `credentials/` | — |
| 沙箱 | `sandbox/`（bwrap / Landlock / Seatbelt） | — |
| 技能（模型可加载） | `skill/`（provider registry + catalog/loader） | — |
| 子代理 | `subagent/` | — |
| 外部 MCP | `mcp/` | — |
| 会话内目标 / 计划 / 待办 | `goal/`、`plan/`、`todo/` | — |
| 运行时可自省与自改 | `extensions/`（`tool-cordis` 只读 API 发现 + Plugin Manager） | — |
| **领域插件层** | `bundle/`（`dsh.bundle.patch`，profile 叠加） | — |
| 上下文压缩 | `compaction/`、`context/` | — |
| Hook 桥 | `hooks/`（含 Claude Code / Codex wire-protocol 库） | — |

### ⚠️ 部分覆盖（要论证范围，不要整块重写）

| 能力 | DSH 现状 | 缺口 |
|---|---|---|
| 外部事件入口 | `webhook/` 接收签名事件 + 可信规则 → 创建 Session | README 明说**无投递库、队列、重试、去重、Agent 完成状态**。要幂等投递得自己补，但只补这一层 |
| 编排 | `workflow/` 跑模型写的编排脚本 fan-out 子代理；`ralph` 跑固定序列的新 agent | **进程内**，不是跨天 durable。跨小时/跨天等待要自己补 |
| 循环卫生 | `guard/`（重复调用提醒 + `tools/execute` deadline） | 不是策略级治理 |

### ❌ 真空白（这才是要写的东西）

| 能力 | 说明 |
|---|---|
| **科学领域状态** | 假设、证据、候选动作、观测、不确定性、资源约束——DSH 完全没有这一层 |
| **多组学 DataHandle / manifest** | 数据在哪、什么格式、什么访问策略；只传引用不传本体 |
| **Decision module 接口** | 可替换、可版本化的决策层协议（C1 的落点） |
| **实验执行器** | 湿实验 / 模拟器 / 外部实验协议，含不可重放语义 |
| **跨天 durable execution** | 真实实验要等数小时到数天 |

---

## 三·五、DSH 的 interception surface（本次最关键的技术发现）

> 来源：`packages/hooks/README.md` + `.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md`
> 这份 Agent Note 的状态是 **implemented**，且有集成测试
> `packages/core/agent-loop/tests/interception.spec.ts` 在真实 loop 上验证。

**核心 reframe（原文）**：
> "native hooks" **不是**一个包——native hook 就是一个普通的 Cordis 插件，
> 订阅规范生命周期事件。CC/Codex 桥只是把外部 shell-hook 协议翻译到同一个 API 的翻译器。
> **Anything a bridge can do, a plain plugin can do directly — more powerfully
> (no serialization boundary, full `ctx`, typed returns).**

### 生命周期扩展点

| 事件 | 语义 | 关键能力 |
|---|---|---|
| `agent/created` | 每个 agent 首次 turn 前的串行初始化 | 监听者可 **安装工具**、通过 `agent.inject()` 播种上下文 |
| `agent/pre-step` | **每个** proposed step 前的 waterfall | `enter` 返回完整 message batch（可注入上下文）；`reject` 关闭该 turn |
| `agent/turn-stopping` | 自然停止边界上的 awaited notification | **需要再来一步的监听者调用 `agent.steer()`，loop 会重新读取 outbox 并继续** |

### 工具五阶段流水线

```
tools/pre-execute → guards → tools/execute → dispatch → tools/post-execute
                  → finalizeContent → tools/result
```

| 阶段 | 决策类型 | 能做 |
|---|---|---|
| `tools/pre-execute` | `PreToolDecision` | **allow / deny / ask**。deny 直接跳过 dispatch；ask 走 `ctx.approval`，**只有 `allowed-once` 才继续**；审批服务缺失 → 归一化为拒绝 |
| `ctx.tools.guard()` | 同步作用域策略 | 只能 **deny 或弃权，永不 force-allow**（所以监听器顺序不能复活被最终不变量禁止的操作） |
| `tools/execute` | around-dispatch | timeout / retry / metrics 包装，可替换并恢复 `exec.signal` |
| `tools/post-execute` | `PostToolDecision` | **accept / 带 feedback 阻断 / 替换内容或值 / 附加 `additionalContexts`** |
| `ToolDefinition.finalizeContent` | 同步、全量、只碰 content | 工具自己的最后一公里内容不变量 |
| `tools/result` | 只读通知 | 观察者失败被隔离，不能改变结果 |

**这条缝直接回答了一个原本以为要 fork 才能解决的问题**：
"agent 每一轮**必须**调用 decision making" —— 用 `agent/turn-stopping` 监听者检查本轮是否调用了
decision 工具，没调用就 `agent.steer()` 带模型可见内容 → loop 继续。
**不需要改 DSH 源码。** 若还要更硬的约束，`core/agent-loop` 本身是**可替换**的
（"extension plugins depend on `agent` and the driver stays swappable"）。

---

## 四、未决问题（B 套没解决的）

1. **Phase 0 从未验收** —— 但现在源码 checkout 在归档里，**可以离线补**（逐符号核对
   `LlmAdapter` / StreamChunk / session persistence / plugin registration）。
2. **真实 provider credential 是长期瓶颈** —— 默认状态是 `MISSING_CREDENTIAL`。
   归档证明能跑通，但依赖用户级环境变量，**不能把离线 fixture 当成真实模型证据**。
3. **native build scripts 被跳过** —— npm 安装时跳过了 `koffi`、`node-pty` 等，
   这个环境**从没被当作最终 runtime 验证过**。
4. **"工具注册成功 ≠ 模型执行了工具"** —— 有一次真实 tool-call 证据，但是探针级的，不是 run 级的。
5. **版本混用坑** —— 全局 CLI `0.1.0-rc.6` **不能**与 `0.1.2-alpha.2` SDK 插件混用。

---

## 五、必须你拍板的分叉点

### 分叉 1：DSH 以什么形式引入？—— 四选项的区别

**先说结论：结合分叉 2 的要求，只有 A 和 B 可选，fork 不需要。**

真正的轴只有一条：**我们的科研能力写在哪一侧、用什么语言。**

| | **A. 只写插件（bundle）** | **B. DSH 内核 + Python 决策服务** | **C. fork DSH 源码** | **D. Python SDK 子进程** |
|---|---|---|---|---|
| 代码语言 | TypeScript / npm 包 | TS 插件 + Python 服务 | TypeScript（改 DSH 自身） | Python |
| 改 DSH 源码 | 否 | 否 | **是** | 否 |
| 能碰到的 DSH 内部 | **全部 `ctx.*`** | 同 A | 全部 + 能改能力缝 | 只有 JSON-RPC 表面 |
| 每轮强制调 decision | ✅ `agent/turn-stopping` + `agent.steer()` | ✅ 同 A | ✅（但不必需） | ❌ 只能靠 prompt 求 |
| 换 decision 模块 | 换 Provider / 插件 | **换 Python 服务，DSH 侧不动** | 改源码 | 换 HTTP 服务 |
| C1（多组学 / PyTorch） | 要重写成 TS 或走服务边界 | **原生 Python** | 要重写 | 原生 Python |
| DSH 升级成本 | 中（跟 patch layer） | 中 | **高**（跟上游 merge） | 低 |
| 主要风险 | 决策层跨语言 | 多一个进程边界（超时/版本/幂等要设计） | DSH 是 alpha，格式变得勤 | **拿不到能力缝 = B 套的老路** |

**A. 只写插件（bundle）**
DSH 的官方扩展方式。我们写一个 npm 包，声明 `dsh.bundle.patch`，launcher 按顺序叠加进 profile。
`packages/bundle/README.md` 明确说 "Domain packages can declare additional layers outside this directory"，
所以领域层**不必**放进 DSH 仓库里。安装用 `dsh plugin --profile sdk add file:<bundle>`。
**优点**：用到全部 `ctx.*`（tools / approval / commands / session / storage / credentials / llm），
零序列化边界、强类型返回。**缺点**：C1 若要用 PyTorch / scanpy，得用 TS 重写，
或在插件内部再调外部服务——那就变成 B 了。

**B. DSH 内核 + Python 决策服务**
= A + 把决策层放到独立 Python 进程，插件通过稳定服务边界调用它。
**这正好命中"后续只需要换 tool 就行"**：decision 是注册进 `ctx.tools` 的工具，
背后是 `DecisionService` 这个 Service Definition，C1 提供 Service Provider。
换决策方法 = 换 Provider，DSH 侧和工具 schema 都不用动。
B 套的 `RemoteDecisionModule`（versioned JSON HTTP，版本不匹配 fail closed）就是这个思路，可借鉴。
**代价**：多一个进程边界，超时 / 版本 / 幂等必须显式设计。

**C. fork DSH 源码**
把归档的 checkout 恢复进工作区，直接改 `packages/`。
**只在"能力缝不够用、必须改缝"时才值得**——现在看不需要，第三·五节的 interception surface
已覆盖"每轮强制调用"这类硬约束。
另外 **DSH 是 alpha 预览版**：`packages/session/` 下有 `session-format-v0-to-v1`、`v1-to-v2`、
`v2-to-v3`、`v3-to-v4` **四个**迁移包，说明 session 格式变得很勤——fork 就要一直跟。

**D. Python SDK 子进程**
只用 `DeepSeekHarness.run()` / `Session.run()`，拿 `RunResult(session_id, final_response,
finish_reason, events, notifications)`。
**能拿到**：完整事件流、notifications（含子代理）、finish_reason。
**拿不到**：`ctx.approval`、`ctx.commands`、`ctx.tools.guard()`、interception 的 typed Decision——
即除了"发 prompt、收事件"之外的一切。
**B 套走的就是这条路**（Python 侧 + 一个 TS 工具插件），这是它"只用到 DSH 皮毛"的直接原因。

> **推荐 B。** 分叉 2 的三条硬约束（每轮强制调用 / 每轮强制更新 / 换 tool 就行）
> 用 `agent/turn-stopping` + `ctx.tools` + Service Definition/Provider 分离即可满足，
> 全在 A 的能力范围内；而 C1 大概率是 Python，B 让它在原生环境跑，
> 同时保持"换 Provider 就换掉 decision"。

### 分叉 2：**已定** —— 闭环是硬约束，不是选项

把原话拆成三条可验证约束：

| # | 约束 | 落在 DSH 的哪里 |
|---|---|---|
| 1 | **decision making 必须以工具形式预留位置** | `ctx.tools.register(defineTool(...))`；背后是 `DecisionService` 这个 Service Definition，C1 提供 Provider |
| 2 | **agent 每一轮执行科学发现任务都必须调用它**（其他 toolkit 由 agent 自行决定） | `agent/turn-stopping` 监听者：本轮没调 decision 工具就 `agent.steer()` 带模型可见内容 → loop 继续。要更硬就换 `agent-loop`（可替换） |
| 3 | **每轮拿到 feedback 必须更新 decision making** | `tools/post-execute` 的 `PostToolDecision`：feedback 工具返回后若未调用 update，则带 feedback 阻断或附加 `additionalContexts` |

**前期 decision 模块可以用最简单的主动学习 / 序贯决策方法，但闭环更新必须跑通。**
这意味着第一版就必须有三件事：

- 一个**可替换的 `DecisionService` Service Definition**（不是"先写死以后再抽"）；
- decision 调用与 feedback 更新的**配对校验**（可审计：这一轮的 feedback 有没有真进到下一轮决策）；
- trace 里能读出「决策输入 → 决策输出 → feedback → 下一次决策输入」的完整链。

> 第三条正好对上 harness 职责③与 **retokenization drift** 那个硬问题：
> 必须在**模型 API 边界**记录原始请求/响应，不能在节点层记摘要。

### 分叉 3：**在 agent 边界上两者一样 —— 这个判断是对的**

"agent 不负责接入湿实验仪器，一定会有实体把实验结果作为 feedback 传进来"——
在 agent 的工具边界上，in-silico 和湿实验是**同一个形状**：调工具 → 拿 feedback。

但契约里必须提前放两样东西，否则以后接湿实验要改契约：

| 差异 | in-silico | 真湿实验 | 契约上要预留 |
|---|---|---|---|
| 延迟量级 | 秒级 | 小时～天级 | 工具返回**异步句柄**（pending + 后回填），不能假设同步返回 |
| 成本 | 免费 | 每次真花钱 | 预算门 + `interaction/user-approval` 审批 |
| 可重放性 | 可重跑 | **不可重放** | **幂等键**（防重复提交不可逆实验） |

**结论**：从第一天就把实验工具设计成 **异步 + 幂等**，两者共用同一套契约，只是等待时间不同。
durable execution 的优先级取决于你近期跑不跑真湿实验——**不跑就可以推后**。

### 分叉 4：后端只用 `deepseek-official` 吗？

DSH 默认注册 `deepseek-official`。**职责③（trace 保真要 CoT）只在 Claude / DeepSeek 后端可行**——
OpenAI 托管模型不返回原始 CoT，Gemini 的 `-o json` 会剥掉思考内容。
只用 DeepSeek 的话这条天然满足，不用额外设计。

---

## 六、DSH 版本策略（回答"必须 follow 最新版"）

### 6.1 现状：DSH 没有任何正式版

实测（2026-09-23，GitHub API）：

- `GET /releases/latest` → **404**。即**不存在非 prerelease 的正式版**。
- 近期 12 个 release 的 `prerelease` 字段**全部为 `true`**。
- 发版节奏：09-03、09-04、09-07、09-08、09-09、09-10×2、09-15、09-17、09-22×2、09-23
  —— **20 天 12 个版本**。
- 最新：**`dsh-v0.1.7-rc.1`**（commit `46a7f68b0922`，**今天**发布）。
- **归档里的 checkout 是 `dsh-v0.1.7-alpha.1`（`c36a83f`），落后两个版本**（alpha.2、rc.1）。

→ **"等正式版"这个选项现在不存在。** 要 follow 最新，就是跟一条 20 天 12 版的 prerelease 快车道。

### 6.2 但 DSH 对已发布数据有正式兼容义务（不是"预览版就随便变"）

`docs/session-format-status.md` 原话：

> An alpha, beta, or release-candidate product publication **establishes released
> Session-format obligations**. **GitHub's prerelease flag does not make persisted
> user data disposable.**

机制是正式的：

- `latestFinalizedVersion: 4`（= checkout 写入器）
- `latestReleasedVersion: 3`，`evidenceTag: dsh-v0.1.5-alpha.1`
- 每个整数 **0..4 都有历史格式文档**（`docs/persistence-changes/historical-formats/`）
- **迁移只允许相邻**：`v0→v1`、`v1→v2`、`v2→v3`、`v3→v4`，各一个包，不能跳
- 有机器检查：`scripts/doc-standard.spec.ts` 校验记录结构、双语一致、证据 tag 与写入器路径一致

> ⚠️ **一个要盯的坑**：checkout 写 **V4**，但最后**发布**的格式是 **V3**（`dsh-v0.1.5-alpha.1`）。
> 即 V4 已 finalized 但未记录为已发布。用这份 checkout 跑出来的 session 是 V4，
> 换到发布版可能要跑迁移。

### 6.3 抗升级的抓手：DSH 自己给了

三条都是 DSH 文档原话：

1. "Extension plugins depend on **Service Definitions, never concrete providers**."
2. "extension packages depend on `dsh-agent` events and services, **not on** `dsh-agent-loop`."
3. `docs/capability-seams.md` 是**生成**的（`scripts/gen-doc-graphs.ts`），**带完整性守卫**，
   逐条列出每个 `ctx.*` 服务的 **Role**：`core` / `seam` / `service` / `bundle`。

→ **我们依赖「`ctx.*` 服务名 + `dsh-agent` 事件签名 + Role」，不 import 具体实现包。**

我们真正会依赖的服务及其 Role（已核）：

| `ctx.*` | Role | 用途 |
|---|---|---|
| `ctx.tools` | **core** | 工具注册 + 五阶段执行流水线 |
| `ctx.approval` | **seam** | 审批（湿实验 / 付费动作） |
| `ctx.storageDomain` | **core** | **typed durable state —— decision 模块状态放这里** |
| `ctx.llm` | **seam** | 模型适配 |
| `ctx.sessions` | **core** | append-only 事件日志 |
| `ctx.sessionPersistence` | **seam** | 持久化后端 |
| `ctx.credentials` | **seam** | 凭证 |
| `ctx.commands` | **core** | 斜杠命令 |
| `ctx.skills` | **seam** | 技能 |
| `ctx.subagents` | **seam** | 子代理 |
| `ctx.jobs` | **seam** | 后台任务 |
| `ctx.agentLoop` | **bundle** | 可替换的 loop（**不要直接依赖它**） |

### 6.4 建议：把"版本兼容性门禁"做成一等组件

```
升级 DSH 时跑：
1. 记录新 tag / commit / SESSION_FORMAT_VERSION
2. 重新生成 capability-seams 表，diff：
   - 我们依赖的 ctx.* 是否还存在
   - Role 是否从 seam/core 变了
   - 依赖的 seam 的 implementations 是否换了
3. diff interception 事件签名（agent/pre-step、agent/turn-stopping、tools/*）
4. session format version 是否变 → 变了要跑迁移
5. 跑我们的契约测试
```

**关键设计**：**我们自己的持久化状态不要放在 DSH 的 session 格式里**，走 `ctx.storageDomain`
（"domain form as one lifecycle-bound service for **typed durable state**"）。
这样 DSH 换 session 格式不会打穿我们的状态。

**版本策略建议**：跟 **rc** 而不是 alpha（rc 是发布前最后阶段，变更面收窄）；
每次升级**必须**跑门禁，不过就不升；把 DSH tag / commit / session-format-version 作为
**构建元数据**打进我们的产物。

---

## 七、长程任务上如何用 feedback 更新 decision 模块

### 7.1 先把"长程"拆成三层（否则会把在线学习和 RL 混在一起）

| 层 | 含义 | 更新对象 | 时机 | 归谁 |
|---|---|---|---|---|
| **L0** | run 内，本轮 feedback → 下一轮 | decision 的**状态**（后验 / memory） | 每轮 | C3 保证交付 |
| **L1** | run 内，长程（几十～几百轮） | 同上，但要处理迟到 / 乱序 / 缺失 | 每轮 | C3 + 时序管理 |
| **L2** | **跨 run** | decision 的**参数 / 策略** | 每 run 或每 N run | **C2（self-evolve）** |

**L2 不能在 run 内做**，否则归因失效——这与你之前定的"self-evolve 定义在 run 之间"一致。
下面主要讲 L1，但接口要同时支撑 L2。

### 7.2 核心困难不是算法，是反馈的时序与归属

长程 + 异步实验端，feedback 会长这样：

| 情况 | 说明 |
|---|---|
| **迟到** | 第 5 轮的 feedback 在第 8 轮才到 |
| **部分到达** | 先拿到部分读数，后来补全 |
| **永久缺失** | 实验失败 / 取消，永远不会有 |
| **重复 / 修订** | 同一个 observation 被修正后重发 |
| **批量对应** | 一个 decision 选了 k 个 action，feedback 分批到 |

→ `observe()` 必须**按 `(action_id, round)` 键控**，不能是"喂最新一条"。

### 7.3 三条设计原则

**原则 1：数值反馈走结构化旁路，不经过模型文本。**
让 agent 读 feedback 再调 `update_decision(text)`，数值会被模型重述一遍——
**lossy + retokenization drift**，正是职责③要防的问题。
正确做法：experiment tool 返回时，runtime 直接把结构化 observation 交给 `DecisionService.observe()`。
模型的定性解释（"这次失败可能是剂量选错了"）走**另一条通道** `annotate()`，
与数值反馈**分开存**。

**原则 2：decision 的状态必须外置、可持久化、可快照。**
长程状态不能塞 prompt。用 `ctx.storageDomain`。
`snapshot()` / `restore()` 是必须的——run 暂停（等湿实验）后要恢复；
也是 L2 的前提（训练器需要"初始状态 + 轨迹"）。

**原则 3：增量更新，且显式区分"状态更新"与"策略更新"。**
L0 / L1 = 状态更新，可以每轮做。L2 = 策略更新，**不能在 run 内做**。
第一版用最简单的序贯决策，refit 成本可接受，但接口要能表达增量。

### 7.4 建议的接口

```python
class DecisionService(Protocol):
    model_version: str

    # 取推荐 —— agent 每轮必须调（turn-stopping 强制）
    def propose(self, request: DecisionRequest) -> DecisionPacket: ...

    # 数值反馈 —— 结构化旁路，不经过模型
    def observe(self, observation: Observation) -> UpdateReceipt: ...

    # 模型的定性解释 —— 与数值反馈分开存
    def annotate(self, annotation: Annotation) -> None: ...

    # 长程：状态快照 / 恢复
    def snapshot(self) -> bytes: ...
    def restore(self, blob: bytes) -> None: ...

    # 长程：还有多少反馈没到
    def pending(self) -> list[ObservationRef]: ...
```

`UpdateReceipt` 必须可审计：

```
consumed:  [observation_id, ...]     # 这次消费了哪些
pending:   [observation_id, ...]     # 还没到
abandoned: [observation_id, ...]     # 超时放弃
state_revision_before / after: int
affected_rounds: [int, ...]
```

### 7.5 "闭环真的闭合"的判据（配对审计）

```
对每一轮 r：
  1. decision_r 存在                              ← turn-stopping 强制
  2. action_r = decision_r 选出的
  3. observation_r 存在，或显式标记 missing / timeout
  4. decision_{r+1}.input_refs ∋ observation_r    ← 核心
```

**第 4 条不成立，闭环就是假的。** 每次 run 都要产出这个 pairing audit artifact。

这不是形式主义：PerturbTrace 测出的"576 次转移只有 7.5% 走完四段"，
就是第 3、4 条不成立。

### 7.6 长程特有的陷阱：credit assignment

长程任务里，"这一轮命中率变高"可能来自 **3 轮前**的反馈，不是上一轮。
所以不能只做即时配对（上一轮 feedback → 这一轮决策）。

需要 **per-round gain 归因**（PerturbTraceBench 的 `round_hit_gain` 正是这个），
并且要能把 gain 追溯到**具体哪条 feedback**。

**没有这个，你在长程任务上无法回答"feedback 到底有没有用"**——而这正是 PerturbTrace 的核心问题，
也是这个项目要解决的东西。

---

## 八、起手式

### 还差两个输入

**输入 1：C1 的决策模块用什么语言？**

- 能用 TypeScript 写 → **A**（只写插件，最简单，无进程边界）
- 要用 Python（PyTorch / scanpy / 多组学 embedding）→ **B**（TS 插件 + Python 决策服务）

**输入 2：DSH 版本跟到哪一档？**

| 选项 | 含义 | 风险 |
|---|---|---|
| **跟 rc**（现在 `dsh-v0.1.7-rc.1`） | 发布前最后阶段，变更面收窄 | 低。**推荐** |
| 跟最新 tag（可能是 alpha） | 最激进，永远最新 | 中，alpha 变更面大 |
| 等 `0.1.7` 正式发布 | —— | **不可行**：`/releases/latest` 是 404，没有正式版 |

### 然后按性价比排序动手

0. **先建版本兼容性门禁**（新增，优先级最高）。一个脚本：吃 DSH tag / commit，
   产出 capability-seams diff + interception 事件签名 diff + session-format-version 变化；
   **门禁不过就不升级**。先建它，后面每次升级都省事。
1. **把 checkout 升到选定版本**。归档那份是 `0.1.7-alpha.1`，**落后两个版本**。
   升级后重跑 Phase 0 的逐符号核对（现在有源码，可离线做，零网络零凭证）。
2. **落地"每轮强制调用 decision"的骨架**：最小 `DecisionService` Service Definition +
   `agent/turn-stopping` 监听者 + feedback→update 配对校验 + **pairing audit artifact**。
   **先让闭环跑通，决策算法用最简单的主动学习即可**（分叉 2 原话）。
3. **把实验工具做成异步 + 幂等**（分叉 3）：即使现在只跑 in-silico，也按这个契约写，
   以后接湿实验不改契约。
4. **trace 保真**：在模型 API 边界记录原始请求/响应，harness 注入打标。
   对应职责③与 retokenization drift。
