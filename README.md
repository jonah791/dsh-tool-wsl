<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: WSL 命令行工具：在 WSL（Ubuntu）环境执行 bash 命令（wsl.exe -d <distro> -- bash -c），Windows 上取代 dsh-tool-bash；v0.2 命令走 base64 通道，v0.3 新增 stdin/wsl_path/wsl_env + 自证轨迹
  inject: 'tools','subprocess','systemPrompt'
  tools: wsl,wsl_path,wsl_env
  runtime: host-only
  envDeps: WSL Ubuntu 发行版
  boundary: WSL 进程不受 Windows 文件沙箱约束（见「安全边界」节）
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-tool-wsl

<p align="center">
  <a href="https://github.com/jonah791/dsh-tool-wsl"><img src="https://img.shields.io/badge/version-0.3.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-41%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一个在 WSL（默认 Ubuntu）里执行 bash 命令的工具面——Windows 上取代 `dsh-tool-bash`（Windows 无原生 bash，官方 bash 工具按平台禁用）。

**为什么值得用**：命令经 **base64 通道**传递，绕开 `wsl.exe` 对 `--` 之后 argv 的二次 join（那会静默吃掉 `$`、引号与换行）；每次执行**落一行自证轨迹**，出问题一条 `tail` 就能答完「跑的是哪个构建 / 谁发起 / 断在哪一段 / 输出被截了多少 / 耗时多久」。

## 能力

| 工具 | 用途 |
|------|------|
| `wsl` | 在 WSL 执行 bash 命令。前台：stdout/stderr 收集、输出截断+溢出落盘、超时/取消、`[exit code: N]` 标记；后台：`run_in_background: true` → job id（配 `job_output` / `job_kill`）；支持 `stdin` 喂数据 |
| `wsl_path` | Windows ↔ WSL 路径转换（纯逻辑，零 `wsl.exe` 调用）：`C:\foo` ↔ `/mnt/c/foo`，`auto` 按前缀自动判方向，支持中文/空格路径 |
| `wsl_env` | WSL 环境快照：发行版/内核/磁盘/内存/常用工具清单/代理/shell；`section` 可只看 `system`/`disk`/`tools` |

工作目录传 **Windows 路径**（如 `E:\alice`），`wsl.exe` 自动映射到 WSL 对应目录。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-tool-wsl": "link:E:/alice/self-plugins/dsh-tool-wsl"
```

**2) 挂组合**（agent 预设行，如 `alice` 预设）：

```yaml
- id: tool-wsl
  name: dsh-tool-wsl
  config:
    distro: Ubuntu
```

**3) 关掉官方 bash 工具**（Windows 上默认已禁用，显式写上更清晰）：

```yaml
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true
```

**4) 30 秒验证**：调 `wsl` 执行 `pwd` → 从 `E:\alice` 调用应返回 `/mnt/e/alice`；再执行 `exit 42` → 返回体应带 `[exit code: 42]`。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `distro` | `Ubuntu` | WSL 发行版名（`wsl.exe -l -q` 查看） |
| `wslExe` | `wsl.exe` | wsl 可执行文件 |
| `loginShell` | `false` | `true` 用 `bash -lc`（登录 shell），`false` 用 `bash -c` |
| `cwd` | 未设 | 默认工作目录（不传则用调用方给的 `workdir`） |
| `timeoutMs` | `120000` | 前台默认超时 |
| `maxTimeoutMs` | `600000` | 单次超时上限 |
| `maxOutputBytes` | `64000` | 每流内存输出上限（溢出落盘） |
| `maxSpillBytes` | `64MB` | 溢出落盘上限 |
| `graceMs` | `3000` | SIGTERM→SIGKILL 宽限 |
| `enableRunInBackground` | `true` | 后台执行开关 |

## 落盘与自证（出问题时先看这里）

每次执行落一行 JSONL 到 **`<DSH_HOME>/wsl-trace.jsonl`**（`DSH_HOME` 缺省 `~/.dsh`）：

| 阶段 | 含义 |
|------|------|
| `boot` | 插件装载（含配置快照） |
| `exec/start` | 收到执行请求（`callId` / `distro` / `workdir` / `command`） |
| `exec/end` | 执行结束（`exitCode` / `signal` / `timedOut` / `aborted` / **`stdoutDropped`** / `spill` / `durationMs`） |
| `exec/error` | 启动失败（如 `wsl.exe` 不可用） |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/wsl-trace.jsonl"
# ① 跑的是哪个构建  → build = "<版本>@<模块 mtime ms>"
# ② 谁发起 / 调了什么 → caller + callId + command
# ③ 断在哪一段      → phase 枚举（exec/error 即启动失败）
# ④ 输出质量        → stdoutBytes / stdoutKept / stdoutDropped（被截掉多少字节，不再是布尔值）
# ⑤ 耗时与预算      → durationMs vs timeoutMs
```

隐私：命令与工作目录会经过脱敏（凭据模式擦除、`C:\Users\<你>` 折叠为 `<home>`）；写盘失败一律吞错返回 `false`，**绝不影响命令执行**。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. `tail -1 "$DSH_HOME/wsl-trace.jsonl"` 里 `build` 的 mtime **等于** `lib/index.js` 的 mtime ⇒ 进程在跑当前构建；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回 `liveNow` 含本插件 ⇒ 同上；
3. 行为级：调 `wsl_env` 能返回快照、`wsl` 出现在工具面。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。

**回退**：
- 源码级：`git -C self-plugins/dsh-tool-wsl revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `tool-wsl` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：无需回退（本插件无持久业务状态；轨迹文件可随时删除）。

## 测试

```bash
npm test        # = tsc -p tsconfig.json && node --test "tests/*.test.mjs"
```

**41 例离线测试**，跑 `lib/` 产物（与运行时同源）：
- `tests/trace.test.mjs` — 轨迹层：路径解析、序列化稳定、容错解析（坏行/半行跳过）、**尸体测试**（不可写路径 → 返回 `false` 且不抛）、端到端接线（`DSH_HOME` 不可写时执行照常返回）
- `tests/render.test.mjs` — 输出渲染与截断语义

无网络、无真实 WSL 依赖（子进程以桩替代）。

## 设计要点

- **base64 命令通道**：`wsl.exe` 会把 `--` 之后的 argv 重新 join 成命令行字符串，期间 `$`/引号/转义/换行会被破坏（实测 `for t in git curl; do echo "$t"; done` 的 `$t` 静默丢失）。命令先 base64 编码，外层只传 `echo <b64> | base64 -d | bash`；base64 字符集不含空格/引号/`$`/换行，命令正文不接触 Windows 侧二次解析。**跨层不变量不得下移**——这是本插件的核心约束，改动执行链路时不得绕过它。
- **stdin 同通道**：base64 管道会消费进程 stdin，故有 `stdin` 时一并编码进脚本（`echo <stdin_b64> | base64 -d | <command>`），进程 stdin 保持 `ignore`。
- **执行器**：镜像 `@deepseek-ai/dsh-bash-local` 的 `LocalBashExecutor` 机制（deadline / 输出收集 / 进程组终止 / 超时分类），边界替换为 WSL argv。
- **不依赖宿主 `shell` seam**：直接走 `ctx.subprocess`，绕开 Windows 无 bash 的问题。

### 安全边界（重要）

WSL 进程运行在 Linux VM 内，**Windows 文件沙箱提供方（`dsh-pwsh-sandbox` 等）无法限制其文件访问**。因此本工具不接入 Windows 文件沙箱，也不声明 `sandbox_permissions` 升级参数；工具描述中已明示此边界。**若部署需要严格沙箱，请勿在受限会话中暴露此工具。**

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `dsh-plugin-development` / `plugin-maintainability` | 插件开发与可维护性工程的方法论 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
