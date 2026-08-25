# dsh-tool-wsl

WSL 命令行工具插件——在 WSL（默认 Ubuntu）发行版里执行 bash 命令，Windows 上取代 `dsh-tool-bash`（Windows 无原生 bash，官方 bash 工具按平台禁用）。

## 用途

- 为 agent 提供 `wsl` 工具：`wsl.exe -d <distro> -- bash -c <command>`
- 前台执行：stdout/stderr 收集、输出截断+溢出落盘、超时/取消、`[exit code: N]` 标记
- 后台执行：`run_in_background: true` → job id（`job_output` / `job_kill`）
- 工作目录：Windows 路径（如 `E:\alice`），wsl.exe 自动映射到 WSL 对应目录

## v0.2 核心增强：base64 命令通道（修复传参破坏）

**问题**：wsl.exe 会把 `--` 之后的 argv 重新 join 成命令行字符串再交给 Linux 侧执行，期间 `$`、引号、转义、换行会被破坏。实测 `for t in git curl; do echo "$t"; done` 的 `$t` 静默丢失（输出空），复杂命令（变量/嵌套引号/heredoc/管道）不可靠。

**修复**：命令先 base64 编码，外层只传 `echo <b64> | base64 -d | bash`。base64 字符集 `[A-Za-z0-9+/=]` 不含空格/引号/`$`/换行，命令正文完全不接触 Windows 侧二次解析——任意复杂 bash 逐字传递。

**验证**（base64 通道实测全过）：
- for 循环变量、环境变量、嵌套引号+变量：解码还原 100% 一致
- heredoc、管道链、多行命令、Unicode（中文/日文/emoji）：逐字可靠
- 退出码透传：`exit 7` → `[exit code: 7]`
- 算术、命令替换、反引号：正常

## 设计要点

- **执行器**：镜像 `@deepseek-ai/dsh-bash-local` 的 `LocalBashExecutor` 机制（deadline / 输出收集 / 进程组终止 / 超时分类），执行边界替换为 WSL argv。
- **命令传递**：base64 通道（v0.2），外层 `bash -c` 只承载解码管道，命令本身不直传。
- **不依赖宿主 `shell` seam**：直接走 `ctx.subprocess`，绕开 Windows 无 bash 的问题。
- **沙箱边界（重要）**：WSL 进程运行在 Linux VM 内，Windows 文件沙箱提供方（`dsh-pwsh-sandbox` 等）无法限制其文件访问。因此本工具**不接入 Windows 文件沙箱**，也不声明 `sandbox_permissions` 升级参数；工具描述中明示此边界。若部署需要严格沙箱，请勿在受限会话中暴露此工具。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `distro` | `Ubuntu` | WSL 发行版名（`wsl.exe -l -q` 查看） |
| `wslExe` | `wsl.exe` | wsl 可执行文件 |
| `loginShell` | `false` | `true` 用 `bash -lc`（登录 shell），`false` 用 `bash -c` |
| `timeoutMs` | `120000` | 前台默认超时 |
| `maxTimeoutMs` | `600000` | 单次超时上限 |
| `maxOutputBytes` | `64000` | 每流内存输出上限（溢出落盘） |
| `maxSpillBytes` | `64MB` | 溢出落盘上限 |
| `graceMs` | `3000` | SIGTERM→SIGKILL 宽限 |
| `enableRunInBackground` | `true` | 后台执行开关 |

## 挂载形态

agent 预设行（如 `alice` 预设）：

```yaml
- id: tool-wsl
  name: dsh-tool-wsl
  config:
    distro: Ubuntu
```

同时在预设里禁用 `tool-bash`（Windows 上默认已禁用）：

```yaml
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true
```

## 安装

自研插件家园 `self-plugins/`。在目标 profile 的 package.json 添加 link 依赖：

```jsonc
"dsh-tool-wsl": "link:E:/alice/self-plugins/dsh-tool-wsl"
```

然后在预设组合（`agent.cordis.yml`）加 `tool-wsl` 行即可。

## 验证

- `wsl.exe -l -q` 确认发行版名
- 单命令退出码透传：`wsl.exe -d Ubuntu -- bash -c "exit 42"` → `[exit code: 42]`
- 工作目录映射：从 `E:\alice` 调用 → WSL 内 `pwd` = `/mnt/e/alice`

## 生态

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）DSH 插件生态——21 个自研插件按生命/认知/感知/行动/通信/治理/呈现七层组织。

