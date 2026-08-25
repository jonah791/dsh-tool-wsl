/**
 * dsh-tool-wsl — WSL 执行器
 *
 * 镜像 @deepseek-ai/dsh-bash-local 的 LocalBashExecutor 机制（deadline /
 * 输出收集+溢出落盘 / 进程组终止 / 超时分类），但执行边界换成 WSL：
 *   argv = [wslExe, '-d', distro, '--', 'bash', '-c', command]
 * cwd 继承 Windows 工作目录（wsl.exe 自动映射到 WSL 对应目录）。
 *
 * 与官方执行器的差异（有意为之）：
 *  - 不注册 settings section（预设行插件，避免跨会话 settings 冲突）；
 *  - 不接入 Windows 文件沙箱（WSL 进程运行在 Linux VM，Windows 沙箱提供方
 *    无法限制其文件访问——工具描述与 README 已明示此边界）。
 */
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Context } from '@deepseek-ai/cordis'

/** Model-friendly 环境覆盖（与 bash-local 同源，避免输出被着色/分页干扰）。 */
const ENV_OVERRIDES: Record<string, string> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

export interface WslExecutorConfig {
  /** WSL 发行版名（wsl.exe -d <distro>） */
  distro: string
  /** wsl 可执行文件（默认 wsl.exe，PATH 解析） */
  wslExe: string
  /** 登录 shell（bash -lc）；默认 false → bash -c */
  loginShell: boolean
  /** 缺省工作目录（Windows 路径） */
  cwd?: string
  /** 前台默认超时（ms） */
  timeoutMs: number
  /** 单次超时上限（ms） */
  maxTimeoutMs: number
  /** 每流内存输出上限（溢出落盘） */
  maxOutputBytes: number
  /** 每流溢出落盘上限 */
  maxSpillBytes: number
  /** SIGTERM→SIGKILL 宽限期（ms） */
  graceMs: number
}

export interface WslExecRequest {
  command: string
  workdir?: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  signal?: AbortSignal
  stdin?: string
  env?: Record<string, string>
  dshEnv?: Record<string, string>
}

export interface WslExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  signal?: AbortSignal
  stdin?: string
  env?: Record<string, string>
  dshEnv?: Record<string, string>
}

export interface WslStream {
  text: string
  truncated: boolean
  spillPath?: string
}

export interface WslRunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: WslStream
  stderr: WslStream
}

export interface WslProcessRead {
  delta: string
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}

export interface WslProcess {
  status: 'running' | 'completed' | 'killed'
  exitCode: number | null
  signal: string | null
  done: Promise<void>
  readOutput(): WslProcessRead
  kill(): boolean
}

/** subprocess 接缝的窄结构契约（避免跨包类型耦合；形状与 dsh-subprocess 一致）。 */
interface CollectReader {
  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
}
interface SpawnHandle {
  done: Promise<{ exitCode: number | null; signal: string | null }>
  collected: { stdout: CollectReader; stderr: CollectReader }
  terminate(): void
}
interface SubprocessLike {
  spawn(spec: unknown): SpawnHandle
}

function finalOutput(reader: CollectReader): WslStream {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
  }
}

export class WslExecutor {
  private readonly subprocess: SubprocessLike

  constructor(ctx: Context, private readonly config: WslExecutorConfig) {
    this.subprocess = (ctx as unknown as { subprocess: SubprocessLike }).subprocess
  }

  /** 填充请求缺省：workdir / timeoutMs（夹在默认与上限之间）/ 输出预算。 */
  resolve(request: WslExecRequest): WslExecSpec {
    const timeoutMs = clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, 'wsl: request.timeoutMs')
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
    }
  }

  /** WSL 执行边界：wsl.exe -d <distro> -- bash -c "<base64 解码管道>"
   *
   * 为何走 base64 通道：wsl.exe 会把 `--` 之后的 argv 重新 join 成命令行字符串再交给
   * Linux 侧执行，期间 `$` / 引号 / 转义 / 换行会被破坏（实测 `for t in ...; echo "$t"`
   * 的 `$t` 会静默丢失）。把命令 base64 编码后只经管道解码，命令正文完全不接触 Windows
   * 侧的二次解析——任意复杂命令（变量/引号/heredoc/管道/多行）都可靠传递。
   * base64 字符集为 [A-Za-z0-9+/=]，不含空格/引号/`$`/换行，故 `echo <b64>` 无引号也安全。
   */
  private argvFor(spec: WslExecSpec): string[] {
    const b64 = Buffer.from(spec.command, 'utf8').toString('base64')
    const inner = this.config.loginShell ? 'bash -lc' : 'bash'
    const wrapper = `echo ${b64} | base64 -d | ${inner}`
    return [this.config.wslExe, '-d', this.config.distro, '--', 'bash', '-c', wrapper]
  }

  private spawnSpec(spec: WslExecSpec, argv: string[], stdoutMaxBytes: number, signal: AbortSignal | undefined): unknown {
    const collect = (maxBytes: number) => ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv,
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      env: {
        ...ENV_OVERRIDES,
        ...spec.env,
        ...spec.dshEnv,
      },
    }
  }

  /** 前台执行（带超时/取消/输出收集）。 */
  async run(spec: WslExecSpec): Promise<WslRunResult> {
    return this.runArgv(spec, this.argvFor(spec))
  }

  async runArgv(spec: WslExecSpec, argv: string[]): Promise<WslRunResult> {
    const d = deadline(spec.signal, spec.timeoutMs, 'WSL_TIMEOUT')
    try {
      const handle = this.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, d.signal))
      const outcome = await handle.done
      const collected = handle.collected
      const timedOut = timeoutOf(d.signal, 'WSL_TIMEOUT') !== undefined
      const aborted = d.signal.aborted && !timedOut
      return {
        ...outcome,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: finalOutput(collected.stdout),
        stderr: finalOutput(collected.stderr),
      }
    } finally {
      d[Symbol.dispose]()
    }
  }

  /** 后台启动（进程句柄可 kill/读增量输出）。 */
  start(spec: WslExecSpec): WslProcess {
    return this.startArgv(spec, this.argvFor(spec))
  }

  startArgv(spec: WslExecSpec, argv: string[]): WslProcess {
    const running = this.subprocess.spawn(this.spawnSpec(spec, argv, this.config.maxOutputBytes, spec.signal))
    const collected = running.collected
    let spawnFailureNote: string | undefined
    const consumeSpawnFailure = () => {
      const note = spawnFailureNote ?? ''
      spawnFailureNote = undefined
      return note
    }
    let stdoutOffset = 0
    let stderrOffset = 0
    const proc: WslProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then(
        (outcome: { exitCode: number | null; signal: string | null }) => {
          if (proc.status === 'running') {
            proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
          }
          proc.exitCode = outcome.exitCode
          proc.signal = outcome.signal
        },
        (error: unknown) => {
          proc.status = 'killed'
          spawnFailureNote = `spawn failed: ${String(error)}`
        },
      ),
      readOutput: () => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        return {
          delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: out.lossy || err.lossy,
          ...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
          ...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {}),
        }
      },
      kill: () => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }
}
