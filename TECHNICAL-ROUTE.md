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

### 分叉 1（最关键）：DSH 怎么引入？

| 选项 | 含义 | 代价 |
|---|---|---|
| **A. fork 源码进工作区** | 把归档的 checkout 恢复进来，可以直接改 DSH 本身 | 161 MB；要跟上游 merge；升级成本高 |
| **B. 只写插件（bundle）** | DSH 作为依赖装在 `DSH_HOME`，我们只提供 patch layer + Provider | 不改 DSH 源码；受 Service Definition 约束 |
| **C. Python SDK 子进程** | 只通过 JSON-RPC 交互，完全不进 DSH 内部 | 最省事；但拿不到进程内能力（无法注册 in-process 工具） |

**判断依据：你要不要改 DSH 的源码？**
如果科研能力全都能做成 Provider / tool / command / hook，**B 就够，而且是最优解**。
A 只在"DSH 的某个缝不够用、必须改缝"时才需要。

> B 套走的是 **C + 一个工具插件**，这也是它"只用到 DSH 皮毛"的原因——
> C 只能拿 JSON-RPC 暴露的东西，拿不到 `ctx.approval`、`ctx.tools` 之外的 50 个能力组。

### 分叉 2：**"能做科学发现"的定义是什么？**

| 选项 | 含义 | 是否需要 decision module |
|---|---|---|
| **A. 真闭环** | agent 自主提假设 → 设计扰动 → 执行 → 读结果 → 改下一步 | 需要（C1） |
| **B. 工具增强** | agent 能调用科研工具完成一个给定任务 | 不需要 |

这决定要不要留 C1 的接口，以及 trace 要不要保到 CoT 级。

### 分叉 3：实验端是**真湿实验**还是 in-silico？

真湿实验 → durable execution 和审批是**第一优先级**，必须先做。
in-silico → 这两样可以推后，先做领域状态和决策闭环。

### 分叉 4：后端只用 `deepseek-official` 吗？

DSH 默认注册 `deepseek-official`。**职责③（trace 保真要 CoT）只在 Claude / DeepSeek 后端可行**——
OpenAI 托管模型不返回原始 CoT，Gemini 的 `-o json` 会剥掉思考内容。
只用 DeepSeek 的话这条天然满足，不用额外设计。

---

## 六、建议的起手式（等你确认分叉点后再定）

按性价比排序：

1. **补 Phase 0**：用归档里的 checkout 做逐符号核对，产出 `LlmAdapter`/StreamChunk/
   session persistence/plugin registration 的源码核对表 + 一份可运行的二次开发样例。
   **零网络依赖、零凭证需求**，且能立刻消掉上一轮最大的未验收项。
2. **画能力缝边界图**：把第三节的表做成 DSH 源码级证据（每个结论落到具体包和符号），
   确定"我们只写哪些 Provider"。
3. **定领域层的挂载方式**：一个 `bundle` patch layer + 一组 Provider，
   还是独立的 npm 包。这一步定了，代码结构就定了。
