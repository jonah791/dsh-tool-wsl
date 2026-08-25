/**
 * dsh-tool-wsl — WSL 命令行工具插件
 *
 * 模仿 @deepseek-ai/dsh-tool-bash：模型可见的 `wsl` 工具，在 WSL 发行版里执行
 * bash 命令（wsl.exe -d <distro> -- bash -c <command>），提供前台/后台执行、
 * 退出码标记、超时/取消、输出截断+溢出落盘、terminal 卡片展示。
 *
 * 与 dsh-tool-bash 的差异：
 *  - 执行边界是 WSL，不依赖宿主 `shell` seam 的 bash provider（Windows 无原生 bash）；
 *  - 不接入 Windows 文件沙箱（WSL 进程运行在 Linux VM，Windows 沙箱提供方无法限制），
 *    工具描述中明示此边界；因此也不声明 sandbox_permissions 升级参数。
 *
 * 运行面：host。挂载形态：agent 预设行（tool-wsl），Windows 平台启用。
 */
import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { TOOL_ABORTED, defineTool, type ToolCallView, type ToolResultView } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import type { Context } from '@deepseek-ai/cordis'
import { WslExecutor, type WslExecutorConfig, type WslProcess, type WslRunResult } from './executor.ts'

export const name = 'tool-wsl'
export const inject = ['tools', 'subprocess', 'systemPrompt'] as const

export interface Config extends WslExecutorConfig {
  /** 后台执行开关（run_in_background 参数） */
  enableRunInBackground: boolean
}
export const Config = z.object({
  distro: z.string().default('Ubuntu'),
  wslExe: z.string().default('wsl.exe'),
  loginShell: z.boolean().default(false),
  cwd: z.string().required(false),
  timeoutMs: z.number().default(12e4),
  maxTimeoutMs: z.number().default(6e5),
  maxOutputBytes: z.number().default(64e3),
  maxSpillBytes: z.number().default(64 * 1024 * 1024),
  graceMs: z.number().default(3e3),
  enableRunInBackground: z.boolean().default(true),
})

// ---------- 渲染（与 dsh-tool-bash 同构，仅命名差异） ----------

function streamText(output: { text: string; truncated: boolean; spillPath?: string }): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

function renderResult(result: WslRunResult): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

function renderProcessRead(read: { delta: string; lossy: boolean; stdoutSpillPath?: string; stderrSpillPath?: string }): string {
  const notices: string[] = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((p): p is string => p !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

function processOutcome(proc: WslProcess): { status: 'killed' | 'completed'; detail: string } {
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

// ---------- 工具契约 ----------

interface WslArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  stdin?: string
  run_in_background?: boolean
}

function validateWslArgs(args: WslArgs): void {
  if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
}

function wslDescription(backgroundEnabled: boolean, distro: string): string {
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  return `Execute a command in the WSL (${distro}) environment via \`wsl.exe -d ${distro} -- bash -c\` and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass \`workdir\` instead of using \`cd\`. Paths are Windows paths (e.g. E:\\\\alice); the command runs in the corresponding WSL directory. Non-zero exits are reported as \`[exit code: N]\`. Commands run inside the WSL Linux environment and are NOT confined by the Windows file sandbox. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. The command is passed via a base64 channel (wsl.exe re-parses argv and would corrupt \`$\`/quotes/multiline), so any complex bash — variables, quotes, heredocs, pipes — is transmitted verbatim. ` + background
}

function presentWslCall(args: WslArgs): ToolCallView | undefined {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
  }
}

function presentWslResult(args: WslArgs | null, result: { content?: { type: string; text?: string }[]; isError?: boolean }): ToolResultView | undefined {
  const block = Array.isArray(result.content) && result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text' || block.text === undefined) return undefined
  const raw = block.text
  if ((typeof args === 'object' && args !== null && args.run_in_background === true) || result.isError) {
    return {
      card: 'generic',
      content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }],
    }
  }
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

function resolveWorkdir(modelWorkdir: string | undefined, exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  const headerCwd = exec.agent?.session?.header?.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir)
  return modelWorkdir
}

function canonicalWslResult(result: WslRunResult) {
  const output = (stream: { text: string; truncated: boolean; spillPath?: string }) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {}),
  })
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
  }
}

const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
} as const

interface ShellEnvLike {
  collect(exec: unknown): Record<string, string> | undefined
}

export function apply(ctx: Context, config: Config): void {
  const backgroundEnabled = config.enableRunInBackground
  const executor = new WslExecutor(ctx, config)

  ctx.systemPrompt.section({
    name: 'tool:wsl',
    order: 105,
    text: 'Check the [exit code: N] marker on every wsl result; investigate failures before moving on.',
  })

  ctx.tools.register(defineTool({
    name: 'wsl',
    description: wslDescription(backgroundEnabled, config.distro),
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The bash command to execute inside WSL.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
      },
      workdir: {
        type: 'string',
        description: 'Windows working directory for this command (e.g. E:\\alice). Defaults to the session workspace; a relative path is resolved against it. wsl.exe maps it to the corresponding WSL directory.',
      },
      stdin: {
        type: 'string',
        description: 'Optional text to write to the command\'s stdin (e.g. piping data into a program that reads from stdin).',
      },
      ...(backgroundEnabled ? {
        run_in_background: {
          type: 'boolean',
          description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
        },
      } : {}),
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: BACKGROUND_OUTPUT_PROPERTIES },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              timeoutMs: { type: 'number', required: true },
              stdout: {
                type: 'object', additionalProperties: false, required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              stderr: {
                type: 'object', additionalProperties: false, required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
            },
          },
        ],
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: value.kind === 'background' ? `started background job ${value.jobId}` : renderResult(value),
      }],
    },
    async execute(args: WslArgs, exec: { agent?: { session?: { header?: { cwd?: string } } }; signal: AbortSignal; callId?: unknown }) {
      validateWslArgs(args)
      const shellEnv = ctx.get('shellEnv') as ShellEnvLike | undefined
      const dshEnv = shellEnv?.collect(exec)
      const workdir = resolveWorkdir(args.workdir, exec)
      const request = {
        command: args.command,
        ...(workdir !== undefined ? { workdir } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
        ...(dshEnv !== undefined ? { dshEnv } : {}),
      }
      if (args.run_in_background === true) {
        if (!backgroundEnabled) throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        const jobs = ctx.get('jobs') as { start(opts: unknown): string } | undefined
        if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        if (exec.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        return {
          kind: 'background' as const,
          jobId: jobs.start({
            kind: 'wsl',
            label: args.command,
            ...(exec.agent ? { owner: exec.agent } : {}),
            run: () => {
              const proc = executor.start(executor.resolve(request))
              return {
                cancel: () => void proc.kill(),
                done: proc.done.then(() => processOutcome(proc)),
                readOutput: () => renderProcessRead(proc.readOutput()),
              }
            },
          }),
        }
      }
      const result = await executor.run(executor.resolve({ ...request, signal: exec.signal }))
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return { kind: 'foreground' as const, ...canonicalWslResult(result) }
    },
    presentCall: presentWslCall,
    presentResult: presentWslResult,
  }))

  // ---------- wsl_path：Windows ↔ WSL 路径转换（纯逻辑，零 wsl.exe 调用） ----------

  ctx.tools.register(defineTool({
    name: 'wsl_path',
    description: `Convert a path between Windows and WSL (${config.distro}) forms. Use \`to-wsl\` for "C:\\\\foo" → "/mnt/c/foo", \`to-windows\` for "/mnt/c/foo" → "C:\\\\foo". With \`auto\` the direction is guessed from the input prefix. Pure conversion (no wsl.exe call) — fast and reliable. Useful when you need the Linux-side path for a Windows file, or the Windows-side path for a WSL file.`,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'The path to convert (Windows form like C:\\foo\\bar or WSL form like /mnt/c/foo/bar).',
      },
      direction: {
        type: 'string',
        enum: ['auto', 'to-wsl', 'to-windows'],
        description: 'Conversion direction. auto (default) guesses from the path prefix (/mnt → to-windows, drive letter → to-wsl).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          converted: { type: 'string', required: true },
          direction: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: value.converted,
      }],
    },
    async execute(args: { path: string; direction?: string }) {
      const input = args.path
      const direction = args.direction ?? 'auto'
      const isWindows = /^[A-Za-z]:[\\/]/.test(input)
      const isWsl = input.startsWith('/mnt/')
      const dir = direction === 'auto'
        ? isWindows ? 'to-wsl' : isWsl ? 'to-windows' : null
        : direction
      if (dir === null) throw new Error(`cannot guess direction for path ${JSON.stringify(input)}: specify direction explicitly`)
      let converted: string
      if (dir === 'to-wsl') {
        // C:\foo\bar → /mnt/c/foo/bar
        const m = /^([A-Za-z]):[\\/](.*)$/.exec(input)
        if (!m) throw new Error(`invalid Windows path: ${JSON.stringify(input)}`)
        const drive = m[1]!.toLowerCase()
        const rest = m[2]!.replace(/\\/g, '/')
        converted = `/mnt/${drive}${rest.length > 0 ? `/${rest}` : ''}`
      } else {
        // /mnt/c/foo/bar → C:\foo\bar
        const m = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(input)
        if (!m) throw new Error(`invalid WSL /mnt path: ${JSON.stringify(input)}`)
        const drive = m[1]!.toUpperCase()
        const rest = m[2] !== undefined ? m[2]!.replace(/\//g, '\\') : ''
        converted = `${drive}:\\${rest}`
      }
      return { converted, direction: dir }
    },
  }))

  // ---------- wsl_env：WSL 环境快照 ----------

  ctx.tools.register(defineTool({
    name: 'wsl_env',
    description: `Survey the WSL (${config.distro}) environment: distro info, kernel, disk/memory usage, proxy settings, default shell, and availability of common tools. Use when you need a quick picture of the WSL side before running commands (e.g. what's installed, how much disk is free, whether a tool exists).`,
    parameters: {
      section: {
        type: 'string',
        enum: ['all', 'system', 'disk', 'tools'],
        description: 'Which section to survey. all (default) returns everything.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: value.exitCode === 0 ? value.text : `[exit code: ${value.exitCode}]`,
      }],
    },
    async execute(args: { section?: string }, exec: { signal: AbortSignal }) {
      const section = args.section ?? 'all'
      const probes = [
        'git', 'curl', 'wget', 'python3', 'pip3', 'node', 'npm', 'docker',
        'tmux', 'zsh', 'htop', 'ripgrep', 'rg', 'fzf', 'jq', 'sqlite3',
        'gcc', 'make', 'openssl', 'vim', 'nvim', 'ncdu', 'aria2c', 'cargo', 'go',
      ]
      const commands: string[] = []
      if (section === 'all' || section === 'system') {
        commands.push(`echo '## system'; head -2 /etc/os-release | tail -1; uname -r; echo; echo '## disk'; df -h / | tail -1; echo; echo '## memory'; free -h | head -2`)
      }
      if (section === 'all' || section === 'tools') {
        const names = probes.join(' ')
        commands.push(`echo '## tools'; for t in ${names}; do if command -v "$t" >/dev/null 2>&1; then echo "OK  $t"; else echo "MISS $t"; fi; done`)
      }
      if (section === 'all') {
        commands.push(`echo; echo '## proxy'; env | grep -iE '^(http|https|no)_proxy=' | sed 's/=[^@]*@/=<redacted>@/' || echo '(no proxy set)'; echo; echo '## shell'; echo "$SHELL"`)
      }
      const command = commands.join('\n')
      const result = await executor.run(executor.resolve({ command, signal: exec.signal }))
      return { text: result.stdout.text, exitCode: result.exitCode }
    },
  }))
}
