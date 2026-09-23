# 语义文档：WSL 命令行工具（dsh-tool-wsl）

> 版本 v0.1（对应 `package.json` version **0.3.0**）· 2026-09-14 · 作者：爱丽丝 · 状态：**draft** · 开发方式：语义文档优先
> 能力名：WSL 命令行工具 · 插件名 `dsh-tool-wsl`（插件内 `name = 'tool-wsl'`，`inject = ['tools', 'subprocess', 'systemPrompt']`）
> 主副本路径：`self-plugins/dsh-tool-wsl/docs/semantic.md`
> 实现落点：`self-plugins/dsh-tool-wsl/src/index.ts`、`src/executor.ts`（产物 `lib/index.js`、`lib/executor.js`）

## 1 · 定位与反定位

**定位**：在 **WSL（默认 `Ubuntu`）** 里执行 bash 命令，为 Windows 上的 agent 补上「命令行面」——执行边界 `wsl.exe -d <distro> -- bash -c <外层解码管道>`，命令正文经 **base64 通道**逐字传递（绕开 wsl.exe 对 argv 的二次解析）。三个工具：`wsl`（执行，前台/后台）、`wsl_path`（纯逻辑路径换算）、`wsl_env`（WSL 环境快照）。

**反定位（本文不管什么）**：
- 不管 **Windows 原生命令**（属 `@deepseek-ai/dsh-tool-pwsh`；预设中 pwsh 保留为「Windows 权限墙」后备）。
- 不管**文件沙箱**：本插件**不接入** Windows 文件沙箱，也不声明 `sandbox_permissions` 升级参数（见 §5）。
- **不是** `@deepseek-ai/dsh-tool-bash` 的包装：不依赖宿主 `shell` seam 的 bash provider（Windows 无原生 bash），直接走 `ctx.subprocess`；执行器「镜像 `@deepseek-ai/dsh-bash-local` 的 `LocalBashExecutor` 机制（deadline / 输出收集+溢出落盘 / 进程组终止 / 超时分类）」，但**不注册 settings section**（预设行插件，避免跨会话 settings 冲突）。
- **不是**交互式终端：每次调用都是**全新 shell**，`cwd`/变量/函数不跨调用保留（要目录就用 `workdir`）。

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| distro | WSL 发行版名，默认 `Ubuntu`（配置项 `distro`；`wsl.exe -l -q` 可列） |
| base64 通道 | `Buffer.from(body,'utf8').toString('base64')`，外层只传 `echo <b64> \| base64 -d \| bash`；命令正文不接触 Windows 侧二次解析 |
| 执行器 `WslExecutor` | `src/executor.ts` 的类：`resolve`（填缺省）/`run`（前台）/`start`（后台）/`argvFor`（拼 argv + base64）/`spawnSpec` |
| workdir | 传 `subprocess.spawn` 的 `cwd`，必须是 **Windows 路径**；wsl.exe 自动映射到 WSL 对应目录（`E:\alice` → `/mnt/e/alice`） |
| 溢出落盘（spill） | 每流内存上限 `maxOutputBytes`（64000B）之外的内容落 spill 文件，路径由宿主 `subprocess` 接缝回传 |
| job | 后台执行句柄：`jobs.start(...)` 返回 `jobId`；读增量用 `job_output`、停止用 `job_kill` |
| `dshEnv` | 宿主 `shellEnv` 接缝收集的环境变量（`ctx.get('shellEnv').collect(exec)`），逐调用注入 |

## 3 · 概念模型

```
agent loop ──tool call: wsl { command, description, workdir?, timeoutMs?, stdin?, run_in_background? }
  ▼ src/index.ts: defineTool.execute
    ├ validateWslArgs()            空命令/空描述/非正 timeoutMs → 抛错
    ├ resolveWorkdir(workdir, exec)  headerCwd = exec.agent?.session?.header?.cwd（相对路径按它 resolve；未传则用它）
    ├ dshEnv = ctx.get('shellEnv')?.collect(exec)
    ├ 前台: executor.run(executor.resolve(req))          ← signal 来自 tool call
    └ 后台: jobs.start({ kind:'wsl', label, owner, run }) → { kind:'background', jobId }
  ▼ executor.resolve: timeoutMs = clampTimeout(req, 120000, 600000, 'wsl: request.timeoutMs')
                      workdir = req.workdir ?? config.cwd ?? process.cwd()；stdoutMaxBytes = req.stdoutMaxBytes ?? maxOutputBytes
  ▼ argvFor: body = stdin ? `echo <stdin_b64> | base64 -d | <command>` : <command>
             argv = [wslExe, '-d', distro, '--', 'bash', '-c', `echo <b64(body)> | base64 -d | bash[-lc]`]
  ▼ subprocess.spawn({ argv, cwd: workdir, stdio:{ stdin:'ignore', stdout/stderr: collect(预算+spill) },
                       graceMs: 3000, signal, env: { NO_COLOR, TERM=dumb, PAGER=cat, GIT_PAGER=cat, ...env, ...dshEnv } })
  ▼ deadline(signal, timeoutMs, 'WSL_TIMEOUT') → { exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr }
  ▼ renderResult → 正文 + [stderr] + 标记行 [timed out after Nms] / [killed by signal: X] / [exit code: N]
```

不变量（invariants）：
1. **I1 命令逐字传递**：命令正文只出现在 base64 载荷里，`argv` 中不含命令原文（`argvFor` 是唯一拼 argv 处）。
2. **I2 进程 stdin 恒 `ignore`**：stdin 数据总是嵌进命令脚本（管道），避免「双 stdin」冲突。
3. **I3 超时双夹**：单次 `timeoutMs` 被 `clampTimeout(…)` 夹在 `config.timeoutMs`(120000) 与 `config.maxTimeoutMs`(600000) 之间；超时信号名固定 `'WSL_TIMEOUT'`。
4. **I4 每次调用新 shell**：不保留 `cwd`/变量/函数，`cwd` 只由 `workdir`（经 header cwd 解析）决定。
5. **I5 输出有界且可追**：每流内存 ≤ `maxOutputBytes`、溢出落盘 ≤ `maxSpillBytes`（默认 `64 * 1024 * 1024`）；被截断时正文追加落盘路径提示。
6. **I6 退出状态不吞**：`exitCode !== 0` 且未超时、未被信号杀死时输出必含 `[exit code: N]`；被信号杀则改为 `[killed by signal: X]`。

## 4 · 契约

### 4.1 工具与配置契约

| 工具 | 参数 | 输出（`output.schema`） |
|------|------|------------------------|
| `wsl` | `command`(必填)、`description`(必填)、`timeoutMs?`、`workdir?`、`stdin?`、`run_in_background?`（仅 `enableRunInBackground=true` 时暴露） | `oneOf`：后台 `{ kind:'background', jobId }`；前台 `{ kind:'foreground', exitCode, signal, timedOut, aborted, timeoutMs, stdout:{text,truncated,spillPath?}, stderr:{…} }`（`additionalProperties: false`） |
| `wsl_path` | `path`(必填)、`direction?` = `auto`/`to-wsl`/`to-windows` | `{ converted, direction }` |
| `wsl_env` | `section?` = `all`/`system`/`disk`/`tools` | `{ text, exitCode }`（`exitCode !== 0` 时 render 改为 `[exit code: N]`） |

配置（`Config` = `WslExecutorConfig` + `enableRunInBackground`）：`distro`(Ubuntu) / `wslExe`(wsl.exe) / `loginShell`(false → `bash -c`；true → `bash -lc`) / `cwd?` / `timeoutMs`(12e4) / `maxTimeoutMs`(6e5) / `maxOutputBytes`(64e3) / `maxSpillBytes`(64MB) / `graceMs`(3e3) / `enableRunInBackground`(true)。
裁决细节：`wsl_path` 的 `auto`——`/^[A-Za-z]:[\\/]/` → `to-wsl`；`startsWith('/mnt/')` → `to-windows`；**都不匹配则抛错**（`cannot guess direction for path …: specify direction explicitly`），不猜。`wsl_env` 的 `all` = system+disk+memory、tools 探测、proxy（`sed 's/=[^@]*@/=<redacted>@/'` 脱敏）、shell；`probes` = `git curl wget python3 pip3 node npm docker tmux zsh htop rg fzf jq sqlite3 gcc make openssl vim nvim ncdu aria2c go`，另单独探测 `cargo`（`~/.cargo/bin`）。
后台可用性：`enableRunInBackground=false` → 参数不暴露且执行时抛 `run_in_background is disabled for this deployment (enableRunInBackground: false)`；`ctx.get('jobs')` 缺失 → 抛 `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`。被取消（`exec.signal.aborted` 或 `result.aborted`）→ 抛 `HarnessError('tool call aborted', TOOL_ABORTED)`（`name = 'AbortError'`）。

### 4.2 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| agent 预设（`alice` / `alice-v2`） | `E:\alice\.dsh\.agent-presets\alice\agent.cordis.yml:85`（`- id: tool-wsl` / `name: 'dsh-tool-wsl'` / `disabled: !!js process.platform !== 'win32'` / `config: { distro: Ubuntu }`；`alice-v2` 同形在 `:121`） | 会话创建装载预设行时（仅 win32 启用） |
| profile 依赖 | `E:\alice\.dsh\profiles\web\package.json`: `"dsh-tool-wsl": "link:E:/alice/self-plugins/dsh-tool-wsl"` | `pnpm install` / profile 解析期 |
| 爱丽丝（模型） | `wsl` → `src/index.ts:defineTool.execute` → `src/executor.ts:WslExecutor.resolve` → `run`/`start` → `subprocess.spawn` | 需要命令行时的**默认通道**（§5.1：命令行默认走 WSL2） |
| 爱丽丝（模型） | `wsl_path` → `src/index.ts:defineTool.execute`（内联纯逻辑，不 spawn） | Windows↔WSL 路径换算（零进程开销） |
| 爱丽丝（模型） | `wsl_env` → `src/index.ts:defineTool.execute` → `executor.run(executor.resolve({ command, signal }))` | 探查 WSL 侧环境（发行版/内核/磁盘/内存/工具/代理/shell）前 |
| 系统提示词烘焙 | `src/index.ts:ctx.systemPrompt.section({ name: 'tool:wsl', order: 105, text: 'Check the [exit code: N] marker on every wsl result; …' })` | apply 期注册一次（每轮进 system prompt） |
| 后台任务接缝 | `src/index.ts`：`jobs.start({ kind: 'wsl', label: args.command, owner: exec.agent.id, run })`；`run()` 内 `executor.start(...)` → `{ cancel, done, readOutput }` | `run_in_background: true` 时；读/停走宿主 `job_output` / `job_kill`。⚠ **`owner` 必须是 `SessionId`（= `Agent.id`）**——**不是** Agent 对象，**也不是** `Agent.session`（那是 `Session` 对象）。2026-09-23 实测缺陷：原先传 `exec.agent` ⇒ jobs-local 的 `resolveOwner` 做 `agents.get(对象)` 恒 undefined ⇒ 抛 `session "[object Object]" has no live agent`，**后台作业每次都失败**；改成 `exec.agent.session` **仍然失败**（Session 也是对象，错误串一模一样）；根因是本地 `exec` 类型只窄化了 `session.header.cwd`、**没有 `id`**，而 `jobs` 被断言成 `{ start(opts: unknown) }` ⇒ 类型错误被无类型转换掩盖，tsc 全绿 |
| 环境接缝 | `src/index.ts`：`ctx.get('shellEnv')?.collect(exec)` → `request.dshEnv` → `spawnSpec.env` | 每次调用（可选服务，缺失则跳过） |
| 宿主 subprocess 接缝 | `src/executor.ts:spawnSpec` → `this.subprocess.spawn({ argv, cwd, stdio:{stdin:'ignore',stdout:collect(...),stderr:collect(...)}, graceMs, signal, env })` | 前/后台执行期（`inject` 声明 `subprocess`） |
| 宿主 shell 契约 | `src/index.ts:import { parseExitStatus } from '@deepseek-ai/dsh-shell'` → `presentWslResult` | 渲染 terminal 卡片时（正文与 exit 状态拆开） |

### 4.3 观测轨迹契约（S4 证据层 · 2026-09-14）

**落盘路径（单一真源）**：`<DSH_HOME>/wsl-trace.jsonl`——`DSH_HOME` 由 `src/trace.ts:resolveHome()`（`DSH_HOME` 环境变量 → 回退 `<homedir>/.dsh`）解析，`wslTracePath(home)` 是唯一的文件名来源；本机解析为 `E:\alice\.dsh\wsl-trace.jsonl`。**一行一阶段**（单行 JSON，可 `tail`/`grep`），追加写，进程内不轮转。开关：`DSH_WSL_TRACE=0` 关闭（缺省开启——证据层是默认行为，不是可选项）。

**阶段枚举**（`phase`）：`boot`（`apply` 时一行，自报生效配置）｜`exec/start`（执行前一行，**先落笔再 spawn**，故「试过执行」本身可证）｜`exec/end`（正常收尾，含超时/被杀）｜`exec/error`（`spawn` 抛错——执行器内唯一未捕获路径）。

**行 schema**（键序固定，可选字段按序前插，缺省字段不写）：

| 字段 | 语义 | 五问 |
|------|------|------|
| `atMs` / `pid` / `build` | 写入时刻（ms）/ 进程 pid / `<version>@<lib/trace.js mtime ms>` | Q1 |
| `caller` / `callId?` | 发起方标签（`apply`/`wsl`/`wsl:background`/`wsl_env`）/ 工具调用 id（可 join 会话事件流） | Q2 |
| `phase` / `error?` / `status?` | 阶段枚举 / spawn 错误串 / 后台终态（`running`\|`completed`\|`killed`） | Q3 |
| `distro` / `workdir` / `command` / `commandChars` | 发行版 / 工作目录（主目录折叠为 `<home>`）/ **脱敏后**命令摘要（换行折成 ` ; `，超 240 字符带 `...(+N chars)`）/ 命令原始字符数 | Q2/Q4 |
| `timeoutMs` / `durationMs` | 本次时间预算 / 阶段实耗（`exec/start` = 0） | Q5 |
| `exitCode?` / `signal?` / `timedOut?` / `aborted?` | 退出码（null = 死于信号）/ 终止信号 / 超时被杀 / 被调用方取消 | Q4 |
| `stdoutBytes?` / `stdoutKept?` / `stdoutDropped?` / `stdoutTruncated?` / `spill?` | 产量（整流字节偏移）/ 内存保留量 / **被截断了多少**（= bytes − kept）/ 是否截断 / 是否产生溢出落盘文件；`stderr*` 同形 | Q4 |
| `streamsDeferred?` | 后台执行：输出归 job 增量 reader，轨迹不消费流（字节统计不可得，**显式标注而非填 0**） | Q4 |
| `cfg?` | 仅 `boot`：`distro/wslExe/loginShell/timeoutMs/maxTimeoutMs/maxOutputBytes/maxSpillBytes/enableRunInBackground` | Q1 |

**隐私不变量（MUST）**：`command` 摘要先经 `redactSecrets`（Bearer/Basic/Token 头、URL userinfo、`KEY=value`/`KEY: value` 中键名像凭据者、`--token/--password/--key…` 旗标）再经 `redactHome`（`C:\Users\X`、`C:/Users/X`、`/mnt/c/Users/X` 三形态 → `<home>`）；`workdir` 同样过 `redactHome`；**`stdin` 正文从不记录**（管道语义，可能含数据/凭据）。脱敏是幂等的纯函数。

**观测不反噬主流程（MUST）**：全部落盘 IO 吞错并返回 `bool`（`appendTraceEntry` → `false`）；执行结果、异常传播、job 句柄语义**不受轨迹影响**（含「`DSH_HOME` 不可写」这一退化路径，见 A20）。

**调用点清单（MUST）**：

| 调用点（文件:符号） | 阶段 | 内容 |
|---|---|---|
| `src/index.ts:apply` → `wslTraceBoot(config)` | `boot` | 生效配置摘录（一次装载一行） |
| `src/executor.ts:WslExecutor.trace`（**唯一落笔收口**）← `runArgv` | `exec/start` / `exec/end` / `exec/error` | 前台执行（`wsl` 工具 + `wsl_env`）三阶段 |
| 同上 ← `startArgv`（含 `done` 的 two-arm 回调） | `exec/start` / `exec/end` / `exec/error` | 后台执行（`run_in_background`）三阶段 |
| `src/index.ts:defineTool(wsl).execute` → `request.traceLabel`/`traceCallId` | — | 注入 Q2 字段（**只进轨迹，不参与执行**） |
| `src/index.ts:defineTool(wsl_env).execute` → `traceLabel: 'wsl_env'` | — | 区分同执行器的第二个调用方 |

“谁发起”的判定链：`traceLabel`（调用点注入）→ 缺省按 `runArgv`/`startArgv` 落 `wsl:foreground`/`wsl:background`。

## 5 · 边界与信任

- **能力边界 ≠ 沙箱（重要）**：WSL 进程运行在 Linux VM 内，**Windows 文件沙箱提供方（`dsh-pwsh-sandbox` 等）无法限制其文件访问**——故本工具**不接入** Windows 文件沙箱、**不声明 `sandbox_permissions`**，工具描述明示该边界。若部署需要严格沙箱，**不要在受限会话中暴露此工具**。
- 不越界清单：不注册 settings section；不改宿主 `shell` seam；不自行管理持久化；不做权限提升；不 kill 非自己启动的进程（`kill()` 只对自己 `start` 的句柄生效，已结束返回 `false`）。
- 失败面（显式，不静默）：参数非法（空 `command`/空 `description`/非正 `timeoutMs`）→ 抛 `invalid command: …` / `invalid description: …` / `invalid timeoutMs: …`；后台 `spawn` 失败 → `proc.status = 'killed'` 且经下一次 `readOutput()` 的 `[stderr]` 段送出 `spawn failed: <err>`；超时 → `timedOut: true` + 回显 `timeoutMs` + 标记行 `[timed out after Nms]`（随后 SIGTERM→SIGKILL 宽限 `graceMs`）；输出溢出 → `truncated: true` + `spillPath`，前台提示 `[output truncated; full output: <path>]`、后台提示 `[some output was dropped from memory; full output: <paths>]`（无路径时 `(unavailable)`）；`wsl_path` 方向不可判/格式不合 → 抛错（不返回未转换原值）。

## 6 · 与既有机制的关系

- **§5.1 命令准则**：本插件是「命令行默认走 WSL2」的**执行体**；预设里 `tool-bash` 无条件 `disabled: true`，`tool-pwsh` 保留为 Windows 权限墙后备。
- **`ctx.get(...)` 可选服务 vs `inject` 硬依赖**：`shellEnv`/`jobs` 用 `ctx.get(...)` 取（不进 `inject`），缺失时分别降级（无 `dshEnv` / 抛错）；`inject = ['tools','subprocess','systemPrompt']` 是启动即用的硬依赖（§5.11 第 2 条：`ctx.<service>` 访问必须先声明 inject——本插件用 `ctx.get` 规避可选依赖激活门）。
- **与 `dsh-jobs` / `dsh-tool-jobs`**：后台执行只是「向 jobs 接缝注册一个 job」，读/停归宿主 job 工具——本插件不自建任务队列。
- **与 spill 提供方**：落盘位置与策略由宿主 `subprocess` 接缝的 spill 实现决定（本插件只传 `{ maxBytes: maxSpillBytes }` 预算），故文档不承诺具体目录，只承诺「路径会回传并出现在提示里」。
- **§5.22 可维护性**：可观测证据分两层——① **工具返回值**与 `[exit code: N]` 标记（模型可见面）；② **侧车轨迹** `<DSH_HOME>/wsl-trace.jsonl`（§4.3，进程外可 `tail`/`grep`，覆盖「截断了多少 / 超时还是取消 / 跑了哪个构建」）。宿主 `ctx.logger` 仍不落盘，故轨迹是排障的唯一落盘证据源。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行） | 状态 |
|---|-----------|--------------------------|------|
| A1 | 三工具在会话工具面可见且启动时已挂载 | 本会话工具面含 `wsl`/`wsl_path`/`wsl_env`；`.dsh/plugin-boot.jsonl` 最新行 `live[]` 含 `dsh-tool-wsl`；预设行 `alice/agent.cordis.yml:85` | 已实测（工具面 + 启动账本 + 配置） |
| A2 | 命令逐字传递（base64 通道） | `src/executor.ts:argvFor` 产出 `echo <b64> \| base64 -d \| bash`，argv 不含命令原文 | 已实测（源码判据）；行为复验**待验收** |
| A3 | stdin 经管道喂给命令（进程 stdin 恒 `ignore`） | `wsl { command:'sort', stdin:'b\na\n' }` → `a\nb`；`spawnSpec.stdio.stdin === 'ignore'` | 源码判据已实测；行为复验**待验收** |
| A4 | 退出码透传 | `wsl { command: 'exit 7' }` → 结果含 `[exit code: 7]` | **待验收** |
| A5 | `workdir` 映射到对应 WSL 目录 | 从 `E:\alice` 调 `wsl { command:'pwd' }` → `/mnt/e/alice` | **待验收** |
| A6 | 超时夹在 120000–600000ms | `wsl { command:'sleep 3', timeoutMs: 999999 }` → 回显 `timeoutMs = 600000` 且标记 `[timed out after 600000ms]` | **待验收** |
| A7 | 后台执行返回 `jobId` 且可读/可停 | `wsl { command:'sleep 30', run_in_background:true }` → `started background job <id>`；`job_output` 有增量、`job_kill` 可终止 | **待验收** |
| A8 | 输出溢出落盘并给出路径 | 大输出命令 → 结果含 `[output truncated; full output: <path>]`，`stdout.spillPath` 非空且文件可读 | **待验收** |
| A9 | `wsl_path` 双向换算 + 不可判时抛错 | `C:\foo` → `/mnt/c/foo`；`/mnt/c/foo` → `C:\foo`；`relative/path` + auto → 抛 `cannot guess direction …` | **待验收** |
| A10 | 沙箱边界诚实（不声明升级参数） | `wsl` schema 无 `sandbox_permissions`；描述含 `NOT confined by the Windows file sandbox` | 已实测（源码 schema/描述） |
| A11 | 回归能力存在且绿 | `npm test`（= `node --test "tests/*.test.mjs"`，跑 `lib/` 产物）→ **19 pass / 0 fail** | ✅ 2026-09-14 |
| A12 | 渲染标记优先级 | `tests/render.test.mjs`：超时 > 信号 > 退出码；`exit code: 0` 不产生标记；`(no output)` 占位仍带标记 | ✅ 2026-09-14 |
| A13 | 截断提示不得静默丢失 | 截断而无 spill 路径 → `full output: (unavailable)`（stdout/stderr/进程读取三处） | ✅ 2026-09-14 |
| A14 | 参数非法 fail-loud | `validateWslArgs` 对空/空白命令、空描述、`0`/负数/`NaN`/`Infinity` 超时一律 `throw` | ✅ 2026-09-14 |
| A15 | 搬家零语义漂移（审计证据） | 逐函数 diff：`git show HEAD:src/index.ts` 中 10 个函数体与 `src/render.ts` **逐字相同**（仅加 `export`）——修复了搬家时误改的一个字符（工具描述 `immediately;` 被写成 `immediately,`） | ✅ 2026-09-14 |
| A16 | 展示层退化输入不崩 | `presentWslResult` 对空 content / 多块 / 非文本块返回 `undefined`（而非抛错）；`presentWslCall` 后台分支走 `generic` 卡片 | ✅ 2026-09-14 |
| A17 | **轨迹落盘且五问可答**（§4.3） | `wsl -c 'echo hi'` 后 `tail -2 "$DSH_HOME/wsl-trace.jsonl"` → 一行 `exec/start` + 一行 `exec/end`，`end` 行含 `build`/`caller`/`durationMs`/`exitCode`；`grep -c '"phase":"boot"'` ≥ 1 | ✅ 单测级已实测（`接线：前台执行落 exec/start + exec/end…`）；**线上待验收**（部署后 tail 真实文件） |
| A18 | **「被截断了多少」可见**（原缺陷面） | 大输出命令 → `exec/end` 行 `stdoutBytes` > `stdoutKept` 且 `stdoutDropped = bytes − kept` > 0、`spill: true` | ✅ 单测级已实测（`streamStatsOf` + 接线用例断言 5000−14） |
| A19 | 后台执行的两类终态可分辨 | `wsl { command:'sleep 30', run_in_background:true }` → `exec/end` 行 `caller: 'wsl:background'`、`status: 'completed'`、`streamsDeferred: true`（不假装有字节统计） | ✅ 单测级已实测 |
| A20 | **观测不反噬**（含接线级尸体测试） | `DSH_HOME` 指向「父路径是普通文件」→ `appendTraceEntry` 返回 `false` 且不抛；`WslExecutor.runArgv` 仍正常返回结果、`wslTrace` 返回 `false` | ✅ 2026-09-14（两条：`尸体测试：父路径是普通文件…` + `尸体测试（接线级）…`） |
| A21 | **隐私红线**（凭据/用户名不落盘） | 含 `GITHUB_TOKEN=…`/`Authorization: Bearer …`/`postgres://u:p@h`/`--password=…` 的命令 → 落盘行内搜不到任一凭据串；`workdir` 中的 `C:\Users\<user>` 折叠为 `<home>` | ✅ 2026-09-14（`隐私尸体测试` + `redactHome/homePathVariants` 用例） |
| A22 | 脱敏幂等且不误伤无关键名 | `redactSecrets(redactSecrets(x)) === redactSecrets(x)`；`BUILD=1`/`path=/a/b` 原样保留 | ✅ 2026-09-14 |
| A23 | 构建自报可判「线上跑哪个构建」（Q1） | `build` = `<package.json version>@<lib/trace.js mtime ms>`，可用 `node -e "import('./lib/trace.js').then(m=>console.log(m.selfBuild()))"` 现算比对 | ✅ 单测级已实测（`selfBuild` 用例）；线上比对**待验收** |
| A24 | spawn 失败留断点（Q3） | `subprocess.spawn` 抛 `ENOENT` → 轨迹 `exec/start` + `exec/error`（含 `ENOENT`），且异常照常抛出、前台/后台两路都有 | ✅ 2026-09-14 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（工具注册 + 后台接线 + systemPrompt 段 + `wsl_path`/`wsl_env` 内联实现）、`src/render.ts`（**纯层，零 IO**：`streamText`/`renderResult`/`renderProcessRead`/`processOutcome`/`validateWslArgs`/`wslDescription`/`presentWslCall`/`presentWslResult`/`resolveWorkdir`/`canonicalWslResult`——2026-09-14 从 `index.ts` 抽出，仅搬家）、`src/executor.ts`（`WslExecutor`：`resolve`/`run`/`start`/`argvFor`/`spawnSpec`/`trace` + 窄结构契约 `StreamReadLike`/`CollectReader`/`SpawnHandle`/`SubprocessLike`）、`src/trace.ts`（**观测层纯函数 + 薄 IO**，2026-09-14 新增：`resolveHome`/`wslTracePath`/`mtimeOf`/`readPackageVersion`/`buildStamp`/`selfBuild`/`homePathVariants`/`redactHome`/`redactSecrets`/`summarizeCommand`/`streamStatsOf`/`serializeTraceEntry`/`parseTraceEntries`/`readTraceEntries`/`appendTraceEntry`/`wslTrace`/`wslTraceBoot`/`traceEnabled`）。
- 测试：`tests/render.test.mjs`（19 用例）、`tests/trace.test.mjs`（**22 用例**，含正常路径 + 退化路径 + 两条尸体测试 + 隐私尸体测试 + 接线测试；离线跑 `lib/` 产物，假 subprocess 接缝，零进程/零 WSL）；`npm test` = `node --test "tests/*.test.mjs"` → **41 pass / 0 fail**（2026-09-14）。
- 构建产物：`lib/index.js`、`lib/executor.js`（`main: lib/index.js`）；`npm run build` = `tsc -p tsconfig.json`（**不带 `--noCheck`**，与 session-eject 不同——类型错误会挡构建）。
- peer 依赖（逐字）：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/schemastery ^3.18.1-rc.1`、`@deepseek-ai/dsh-tools ^0.1.0-rc.6`、`@deepseek-ai/dsh-shell ^0.1.0-rc.7`、`@deepseek-ai/dsh-llm ^0.1.0-rc.7`、`@deepseek-ai/dsh-timeout ^0.1.0-rc.7`、`@deepseek-ai/dsh-system-prompt ^0.1.0-rc.7`、`@deepseek-ai/dsh-jobs ^0.1.0-rc.7`。
- **未实现/未验证部分显式标注**：① 行为级验收（A4–A9）本轮**未实测**（任务纪律：不跑构建/测试）——标「待验收」，不得当已完成；② 溢出落盘**具体目录**不在本插件契约内（宿主 spill 决定），只承诺「路径回传 + 提示」；③ ~~**无单测**：仓库无 `tests/`，`argvFor`/`resolve`/`wsl_path` 目前只能靠源码判据与手工探测（§5.22 可测试化缺口）。~~ **部分已补（2026-09-14）**：渲染/校验/展示层 10 个纯函数已落 `tests/render.test.mjs`（19 用例）；`executor.ts` 的 `argvFor`/`resolve`/`spawnSpec` 仍无测试（见 §10 U5——它们碰 `ctx.subprocess`/`spill` 接缝，需先抽窄结构契约的纯函数版）。
- **生效判据**（改了代码后怎么证明真的生效）：① 比对 `lib/*.js` mtime 与 **web 进程启动时间**（`.dsh/plugin-boot.jsonl` 最后一行 `processStartMs`）——产物必须**早于**进程启动（§5.11「重建 ≠ 生效」）；本次核对：`lib/index.js` mtime `2026-08-25 09:33:49` 早于当前进程 `2026-09-14 10:05:47`，账本 `live[]` 含 `dsh-tool-wsl`，且 `src/index.ts`(`09:33:36`)/`src/executor.ts`(`09:19:02`) 早于 `lib` → 构建不落后于源码、跑的就是这份产物。② 行为判据：`wsl { command: 'echo $(date +%s)' }` 有输出即通道通；出现 `[exit code: N]` 即 I6 成立；`wsl_path` 换算即时可验（零进程）。③ 组合判据：新增 `ctx.<service>` 访问若忘写 `inject`，宿主抛 `cannot get property … without inject`——改完按 §5.11 先 `preflight_check`（**full**，毫秒级返回即短路无效）再重启。④ **证据层生效判据（2026-09-14 新增）**：`wsl -c 'echo trace-probe'` 后 `tail -2 "$DSH_HOME/wsl-trace.jsonl"` 出现该次执行的两行，且 `end` 行 `build` 的 mtime 段 == `stat -c %Y lib/trace.js`×1000 → 证据层与产物同源同版本。**新增源文件必须确认调用侧副本里也有 `lib/trace.js`**（pnpm 硬链接下源目录新增文件不会自动出现在 `.pnpm/<pkg>@…` 副本里）：本插件在 profile 里是 `link:E:/alice/self-plugins/dsh-tool-wsl`（符号链接，无副本），故无该风险；若哪天改成 `file:`/registry 依赖需重跑 §C7 检查。
- **回退**（出问题怎么办）：① 代码问题 → `git -C E:/alice/self-plugins/dsh-tool-wsl checkout <上个提交>` + `npm run build`，再按「生效判据」重验；② 工具不可用 → 预设里把 `tool-wsl` 行 `disabled: true`（临时）或 `plugin_unmount dsh-tool-wsl`（写 patch + 重启）；③ 需要 Windows 原生兜底 → 启用 `tool-pwsh`（预设已有行，去 `disabled`）；④ 版本级回滚 → `git revert` 后重建；⑤ 复盘用 `plugin_inspect dsh-tool-wsl` + `plugin_boot_status`（确认线上跑的是哪个构建）。

## 9 · 实践修订记录

（I3：每次事故/实践暴露的语义缺口当场回写。没有也要保留本节——D6 检查它存在）

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
  - 语义**被确认**：base64 命令通道的**动机与边界**（wsl.exe 重解析 argv 会吃掉 `$`/引号/换行）；进程 stdin 恒 `ignore`、stdin 走管道；`workdir` 必须是 Windows 路径并由 wsl.exe 映射；两类截断提示文案；沙箱边界与「不声明 `sandbox_permissions`」的自洽。
  - 语义**被补充**：`shellEnv`/`jobs` 是 `ctx.get(...)` **可选服务**（不进 `inject`），缺失时两条降级语义（无 `dshEnv` / 抛 `background jobs unavailable: …`）；超时双夹数值（120000 / 600000）与信号名 `'WSL_TIMEOUT'`；`--noCheck` 差异（本插件不带、session-eject 带）。
  - 语义**被修正**：README 只说「溢出落盘」易被读成「本插件决定落盘目录」——实际预算由本插件给、路径由宿主 spill 接缝回传，文档按后者表述。
  - 教训（同时回写技能 `semantic-doc-first`）：**「可选服务」与「inject 依赖」必须在契约里分开写**，否则下一个读文档的人会照补 `inject` 反而触发激活门问题。

- **2026-09-14 可维护性补课（批次 W3）：渲染/校验/展示层抽纯 + 19 测试**
  - 语义**被确认**：标记优先级（超时 → 信号 → 退出码，`exitCode===0` 无标记）；`processOutcome` 四态；`presentWslResult` 走宿主 `parseExitStatus` 拆分 `(body, exitCode/signal)`；`resolveWorkdir` 的「无 header cwd 则原样透传」。
  - 语义**被补充**：新增 `src/render.ts`（10 个纯函数导出），`index.ts` 只留 `apply` 接线与 `BACKGROUND_OUTPUT_PROPERTIES` schema 常量。
  - 语义**被修正（搬家事故，自查捕获）**：抽取 `wslDescription` 时把 `immediately;` 误写成 `immediately,`——**工具描述是模型可见输入**，一个标点也是行为变更。处置：逐函数与 `git show HEAD:src/index.ts` 做 diff，10/10 逐字一致后才提交（本条即审计证据）。教训：**「仅搬家」必须有机械证据**，不能靠人眼读一遍；大批量搬迁一律加「搬家后 diff 原文件」这一步。
  - 教训：纯函数困在 `apply` 所在文件的作用域时，**「它到底怎么渲染」只能靠人读源码**——而它恰恰是模型与用户直接看到的那一层（卡片/标记/截断提示），最该有离线断言。

- **2026-09-14 可维护性补课（批次 S4-C）：执行轨迹证据层 + 22 测试**
  - 语义**被补充**：新增 §4.3「观测轨迹契约」——落盘路径 `<DSH_HOME>/wsl-trace.jsonl`、阶段枚举 `boot`/`exec/start`/`exec/end`/`exec/error`、行 schema 全字段、隐私不变量（脱敏 + `<home>` 折叠 + `stdin` 不记录）、观测不反噬保证、**调用点清单**（`apply` 的 boot + `WslExecutor.trace` 唯一收口 + 两处 `traceLabel` 注入）。
  - 语义**被修正（原缺陷面）**：「输出被截断」此前只有布尔 `truncated` + `spillPath`——**被砍掉多少字节在插件外不可见**（用户只看到被砍过的结果）。修法不是改行为，而是把 `readFrom(0).nextOffset`（整流字节偏移 = 产量）与 `Buffer.byteLength(text)`（内存保留量）之差落盘为 `stdoutDropped`/`stderrDropped`。
  - 语义**被补充（零行为漂移的搬家证据）**：`finalOutput(reader)` 拆成 `streamOf(read)` + 调用点显式 `readFrom(0)`（一次读取、同序、同字段），`git diff` 逐行核对 = 无行为变更；`traceLabel`/`traceCallId` 是**只进轨迹**的透传字段，不参与 argv/spawn/结果构造。
  - 语义**被修正（原「§5.22 部分满足」的判据过松）**：此前把「工具返回值 + `[exit code: N]` 标记」当作可维护性证据——那对**调用者**可见，对**进程外排障者**不可见（宿主 logger 不落盘）。现按 §5.22 规则 1 落侧车轨迹，§6 对应条目已改写。
  - 教训：**观测层要落在一个收口**（`WslExecutor.trace`），否则前台/后台/`wsl_env` 三条路径各写一遍，漏一处就是新的静默缺口。

## 10 · 未决问题

- **U1 可测试化（§5.22）**：`argvFor`（base64 外壳）、`resolve`（clampTimeout/缺省填充）、`wsl_path`（三向判定）都是纯函数级逻辑，应抽 `tests/*.test.mjs` 离线跑——目前无测试。倾向先补 `wsl_path` 与 `argvFor`（零进程、零外部依赖）。
  → **部分闭环（2026-09-14）**：渲染/校验/展示层（10 函数）已落 19 用例（A11–A16）。`wsl_path` 的三向判定在 `index.ts` 内联实现里，属**下一步目标**（它需要先把判定抽成纯函数才能离线断言）。
- **U5 `executor.ts` 仍无离线测试**（本次新增登记）：`argvFor`（base64 外壳）与 `resolve`（clampTimeout / 缺省填充）是纯函数，但 `run`/`start` 依赖 `ctx.subprocess`/`ctx.spill` 接缝。倾向：把 `argvFor` 与 `resolve` 提为模块级 `export`（或抽 `src/spec.ts`），先给这两个零依赖函数补测试；`run`/`start` 的接线测试需要宿主桩，优先级低于 `wsl_path`。
  → **部分闭环（2026-09-14 S4-C）**：`runArgv`/`startArgv` 的接线测试已落地（`tests/trace.test.mjs` 用**假 subprocess 接缝**：`spawn()` 返回 `{done, collected:{stdout:{readFrom}}, terminate}`）——证明了「执行 → 轨迹」的接线，但**没有**断言 argv/spawnSpec 的逐字契约（`argvFor` 的 base64 外壳仍只有源码判据）。
- **U6 轨迹文件无轮转**（2026-09-14 新增）：`<DSH_HOME>/wsl-trace.jsonl` 追加写、无上限/无轮转。粗算每次执行 2 行 × ~400B；高频使用下会缓慢增长。倾向：先观察（同 `preflight-trace.jsonl`/`compaction-trace.jsonl` 的现状），若超过 ~10MB 再引入「保留末 N 行」的有界裁剪（参考 `dsh-plugin-bootreport` 的 `keepLines + 50`），**不**做外部日志轮转依赖。
- **U7 线上轨迹验收未做**（2026-09-14 新增）：A17/A23 的「线上」一半要等插件部署 + 重启后 `tail` 真实文件才能标 ✅。本批次不部署（派发纪律），故显式挂起。
- **U8 脱敏已知盲区**（2026-09-14 新增）：① 短旗标附着形式 `mysql -pSECRET`（`-p` 太通用，`mkdir -p /x` 会被误伤，故**故意不脱敏**，代价是这一形态会漏）；② base64/hex 编码后的凭据不可识别（例如 `echo <b64> | base64 -d` 通道内的命令原文——`argvFor` 的 base64 串本身**不进轨迹**，但用户命令里若自带编码凭据则漏）；③ 非 ASCII 用户名的路径变体只覆盖当前 `homedir()` 一种大小写形态。判定：以上均为**过度脱敏会伤可诊断性**所致的自觉取舍，登记为已知边界而非常态缺口。
- **U9 注册表登记**：见 U4（`semantic_register` 由主 agent 执行）。
- **U2 行为级验收归属**：A4–A9 需真跑 WSL 命令；由谁在何时统一验收（本任务纪律不跑测试）——建议主 agent 排一条验收清单任务。
- **U3 `cwd` 缺省三级回落**：`workdir ?? config.cwd ?? process.cwd()` 中 `process.cwd()` 是 web 进程目录，与「会话工作区」概念不完全等价；是否应改为「无 header cwd 时显式用会话工作区/报错」？倾向保留现状但记录语义差异。
- **U4 注册表登记**：`docs/semantics/registry.json` 尚无本条目（本任务禁改注册表）——由主 agent 用 `semantic_register` 登记（`status: draft`、`doc: self-plugins/dsh-tool-wsl/docs/semantic.md`、`impl` 取 `src/index.ts` + `src/executor.ts`）。
