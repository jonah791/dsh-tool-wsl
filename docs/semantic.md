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
| 后台任务接缝 | `src/index.ts`：`jobs.start({ kind: 'wsl', label: args.command, owner: exec.agent, run })`；`run()` 内 `executor.start(...)` → `{ cancel, done, readOutput }` | `run_in_background: true` 时；读/停走宿主 `job_output` / `job_kill` |
| 环境接缝 | `src/index.ts`：`ctx.get('shellEnv')?.collect(exec)` → `request.dshEnv` → `spawnSpec.env` | 每次调用（可选服务，缺失则跳过） |
| 宿主 subprocess 接缝 | `src/executor.ts:spawnSpec` → `this.subprocess.spawn({ argv, cwd, stdio:{stdin:'ignore',stdout:collect(...),stderr:collect(...)}, graceMs, signal, env })` | 前/后台执行期（`inject` 声明 `subprocess`） |
| 宿主 shell 契约 | `src/index.ts:import { parseExitStatus } from '@deepseek-ai/dsh-shell'` → `presentWslResult` | 渲染 terminal 卡片时（正文与 exit 状态拆开） |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱（重要）**：WSL 进程运行在 Linux VM 内，**Windows 文件沙箱提供方（`dsh-pwsh-sandbox` 等）无法限制其文件访问**——故本工具**不接入** Windows 文件沙箱、**不声明 `sandbox_permissions`**，工具描述明示该边界。若部署需要严格沙箱，**不要在受限会话中暴露此工具**。
- 不越界清单：不注册 settings section；不改宿主 `shell` seam；不自行管理持久化；不做权限提升；不 kill 非自己启动的进程（`kill()` 只对自己 `start` 的句柄生效，已结束返回 `false`）。
- 失败面（显式，不静默）：参数非法（空 `command`/空 `description`/非正 `timeoutMs`）→ 抛 `invalid command: …` / `invalid description: …` / `invalid timeoutMs: …`；后台 `spawn` 失败 → `proc.status = 'killed'` 且经下一次 `readOutput()` 的 `[stderr]` 段送出 `spawn failed: <err>`；超时 → `timedOut: true` + 回显 `timeoutMs` + 标记行 `[timed out after Nms]`（随后 SIGTERM→SIGKILL 宽限 `graceMs`）；输出溢出 → `truncated: true` + `spillPath`，前台提示 `[output truncated; full output: <path>]`、后台提示 `[some output was dropped from memory; full output: <paths>]`（无路径时 `(unavailable)`）；`wsl_path` 方向不可判/格式不合 → 抛错（不返回未转换原值）。

## 6 · 与既有机制的关系

- **§5.1 命令准则**：本插件是「命令行默认走 WSL2」的**执行体**；预设里 `tool-bash` 无条件 `disabled: true`，`tool-pwsh` 保留为 Windows 权限墙后备。
- **`ctx.get(...)` 可选服务 vs `inject` 硬依赖**：`shellEnv`/`jobs` 用 `ctx.get(...)` 取（不进 `inject`），缺失时分别降级（无 `dshEnv` / 抛错）；`inject = ['tools','subprocess','systemPrompt']` 是启动即用的硬依赖（§5.11 第 2 条：`ctx.<service>` 访问必须先声明 inject——本插件用 `ctx.get` 规避可选依赖激活门）。
- **与 `dsh-jobs` / `dsh-tool-jobs`**：后台执行只是「向 jobs 接缝注册一个 job」，读/停归宿主 job 工具——本插件不自建任务队列。
- **与 spill 提供方**：落盘位置与策略由宿主 `subprocess` 接缝的 spill 实现决定（本插件只传 `{ maxBytes: maxSpillBytes }` 预算），故文档不承诺具体目录，只承诺「路径会回传并出现在提示里」。
- **§5.22 可维护性**：可观测证据是**工具返回值**与 `[exit code: N]` 标记；`ctx.logger` 未落盘 → 事故取证靠工具输出而非日志（第 2 条部分满足）。

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

## 8 · 与实现的关系

- 主实现：`src/index.ts`（工具注册 + 后台接线 + systemPrompt 段 + `wsl_path`/`wsl_env` 内联实现）、`src/render.ts`（**纯层，零 IO**：`streamText`/`renderResult`/`renderProcessRead`/`processOutcome`/`validateWslArgs`/`wslDescription`/`presentWslCall`/`presentWslResult`/`resolveWorkdir`/`canonicalWslResult`——2026-09-14 从 `index.ts` 抽出，仅搬家）、`src/executor.ts`（`WslExecutor`：`resolve`/`run`/`start`/`argvFor`/`spawnSpec` + 窄结构契约 `CollectReader`/`SpawnHandle`/`SubprocessLike`）。
- 测试：`tests/render.test.mjs`（19 用例，离线跑 `lib/` 产物，零进程/零 WSL）。
- 构建产物：`lib/index.js`、`lib/executor.js`（`main: lib/index.js`）；`npm run build` = `tsc -p tsconfig.json`（**不带 `--noCheck`**，与 session-eject 不同——类型错误会挡构建）。
- peer 依赖（逐字）：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/schemastery ^3.18.1-rc.1`、`@deepseek-ai/dsh-tools ^0.1.0-rc.6`、`@deepseek-ai/dsh-shell ^0.1.0-rc.7`、`@deepseek-ai/dsh-llm ^0.1.0-rc.7`、`@deepseek-ai/dsh-timeout ^0.1.0-rc.7`、`@deepseek-ai/dsh-system-prompt ^0.1.0-rc.7`、`@deepseek-ai/dsh-jobs ^0.1.0-rc.7`。
- **未实现/未验证部分显式标注**：① 行为级验收（A4–A9）本轮**未实测**（任务纪律：不跑构建/测试）——标「待验收」，不得当已完成；② 溢出落盘**具体目录**不在本插件契约内（宿主 spill 决定），只承诺「路径回传 + 提示」；③ ~~**无单测**：仓库无 `tests/`，`argvFor`/`resolve`/`wsl_path` 目前只能靠源码判据与手工探测（§5.22 可测试化缺口）。~~ **部分已补（2026-09-14）**：渲染/校验/展示层 10 个纯函数已落 `tests/render.test.mjs`（19 用例）；`executor.ts` 的 `argvFor`/`resolve`/`spawnSpec` 仍无测试（见 §10 U5——它们碰 `ctx.subprocess`/`spill` 接缝，需先抽窄结构契约的纯函数版）。
- **生效判据**（改了代码后怎么证明真的生效）：① 比对 `lib/*.js` mtime 与 **web 进程启动时间**（`.dsh/plugin-boot.jsonl` 最后一行 `processStartMs`）——产物必须**早于**进程启动（§5.11「重建 ≠ 生效」）；本次核对：`lib/index.js` mtime `2026-08-25 09:33:49` 早于当前进程 `2026-09-14 10:05:47`，账本 `live[]` 含 `dsh-tool-wsl`，且 `src/index.ts`(`09:33:36`)/`src/executor.ts`(`09:19:02`) 早于 `lib` → 构建不落后于源码、跑的就是这份产物。② 行为判据：`wsl { command: 'echo $(date +%s)' }` 有输出即通道通；出现 `[exit code: N]` 即 I6 成立；`wsl_path` 换算即时可验（零进程）。③ 组合判据：新增 `ctx.<service>` 访问若忘写 `inject`，宿主抛 `cannot get property … without inject`——改完按 §5.11 先 `preflight_check`（**full**，毫秒级返回即短路无效）再重启。
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

## 10 · 未决问题

- **U1 可测试化（§5.22）**：`argvFor`（base64 外壳）、`resolve`（clampTimeout/缺省填充）、`wsl_path`（三向判定）都是纯函数级逻辑，应抽 `tests/*.test.mjs` 离线跑——目前无测试。倾向先补 `wsl_path` 与 `argvFor`（零进程、零外部依赖）。
  → **部分闭环（2026-09-14）**：渲染/校验/展示层（10 函数）已落 19 用例（A11–A16）。`wsl_path` 的三向判定在 `index.ts` 内联实现里，属**下一步目标**（它需要先把判定抽成纯函数才能离线断言）。
- **U5 `executor.ts` 仍无离线测试**（本次新增登记）：`argvFor`（base64 外壳）与 `resolve`（clampTimeout / 缺省填充）是纯函数，但 `run`/`start` 依赖 `ctx.subprocess`/`ctx.spill` 接缝。倾向：把 `argvFor` 与 `resolve` 提为模块级 `export`（或抽 `src/spec.ts`），先给这两个零依赖函数补测试；`run`/`start` 的接线测试需要宿主桩，优先级低于 `wsl_path`。
- **U2 行为级验收归属**：A4–A9 需真跑 WSL 命令；由谁在何时统一验收（本任务纪律不跑测试）——建议主 agent 排一条验收清单任务。
- **U3 `cwd` 缺省三级回落**：`workdir ?? config.cwd ?? process.cwd()` 中 `process.cwd()` 是 web 进程目录，与「会话工作区」概念不完全等价；是否应改为「无 header cwd 时显式用会话工作区/报错」？倾向保留现状但记录语义差异。
- **U4 注册表登记**：`docs/semantics/registry.json` 尚无本条目（本任务禁改注册表）——由主 agent 用 `semantic_register` 登记（`status: draft`、`doc: self-plugins/dsh-tool-wsl/docs/semantic.md`、`impl` 取 `src/index.ts` + `src/executor.ts`）。
