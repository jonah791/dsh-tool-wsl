/**
 * dsh-tool-wsl 执行轨迹（可维护性 S4 证据层 · 2026-09-14）。
 *
 * 动机：本插件是模型唯一的 WSL 执行入口，却在执行后**什么都不落盘**——每次执行的事实
 * （跑了什么命令、退出码、输出被砍掉多少、耗时多少、有没有被超时杀掉）只活在返回值与
 * 宿主 logger 里，而宿主 logger 不落盘（AGENTS.md §5.22 规则 1）。后果：
 *  - 「命令结果看起来少了半截」时，**被截断了多少不可见**（`truncated: true` 不告诉你丢了多少字节）；
 *  - 超时/取消/被杀三种结局在会话事件流里都是一个空结果，无法区分；
 *  - 排障只能靠外部脚本反解源码。
 *
 * 修法：每次执行把自己的阶段落成可 `tail`/`grep` 的 JSONL 侧车——
 * `<DSH_HOME>/wsl-trace.jsonl`（一行一阶段，`atMs` 单调）。
 * 阶段枚举：`boot`（生效配置自报）→ `exec/start` → `exec/end`（正常收尾，含被杀/超时）
 * 或 `exec/error`（spawn 抛错，执行器内唯一未捕获路径）。
 *
 * 轨迹回答的五问（技能 plugin-maintainability 判据）：
 *   Q1 线上跑的是哪个构建 → `build`（`<version>@<模块 mtime ms>`）+ `cfg`（生效配置）
 *   Q2 谁发起             → `caller`（`wsl:foreground` / `wsl:background` / `wsl_env`）+ `callId`（可 join 会话事件流）
 *   Q3 断在哪一段         → `phase` 枚举 + `error` / `status`（completed|killed）
 *   Q4 结果质量           → `exitCode` + `stdoutBytes/stdoutKept/stdoutDropped`（**被截断了多少**）+ `spill`
 *   Q5 耗时与预算         → `durationMs` vs `timeoutMs`（判「超时被杀」还是「正常慢」）
 *
 * 隐私红线（AGENTS.md §5.22 + 派发纪律）：命令摘要先脱敏（密钥/口令/token/Bearer/URL userinfo）
 * 并把用户主目录前缀折叠成 `<home>`——用户名一个字都不落盘；`stdin` 正文**从不记录**。
 *
 * 观测绝不反噬主流程（技能 C4）：全部 IO 失败吞错并返回 `false`，执行结果不受影响。
 *
 * @module dsh-tool-wsl/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 阶段枚举（`boot` 一次装载一行；一次执行从 `exec/start` 到 `exec/end`|`exec/error`）。 */
export type WslTracePhase = 'boot' | 'exec/start' | 'exec/end' | 'exec/error'

/** 脱敏占位符（测试与文档共用这一常量，避免判据漂移）。 */
export const REDACTED = '<redacted>'

/** 用户主目录前缀的折叠占位符。 */
export const HOME_TOKEN = '<home>'

/** boot 阶段自报的生效配置（不含任何凭据）。 */
export interface WslTraceConfig {
  distro: string
  wslExe: string
  loginShell: boolean
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
  maxSpillBytes: number
  enableRunInBackground: boolean
}

/** 一行 WSL 轨迹。 */
export interface WslTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: WslTracePhase
  /** 本插件构建标识 `<version>@<trace 模块 mtime ms>`（取不到为 `unknown@0`）。 */
  build: string
  /** 进程 pid（web / watch 两侧都可能执行，pid 用于区分进程）。 */
  pid: number
  /** 发起方标签（`apply` / `wsl:foreground` / `wsl:background` / `wsl_env`）。 */
  caller: string
  /** 工具调用 id（可与会话事件流 join；取不到则省略）。 */
  callId?: string
  distro?: string
  /** 工作目录（主目录前缀已折叠为 `<home>`）。 */
  workdir?: string
  /** 脱敏后的命令摘要（换行折成 ` ; `，超长截断）。 */
  command?: string
  /** 命令原始字符数（摘要被裁剪时可判「摘要 ≠ 全文」）。 */
  commandChars?: number
  /** 本次执行的时间预算（ms）。 */
  timeoutMs?: number
  /** 阶段耗时（`exec/start` = 0；`exec/end`/`exec/error` = 实耗）。 */
  durationMs: number
  /** 生效配置（仅 `boot`）。 */
  cfg?: WslTraceConfig
  /** 进程退出码；null = 死于信号。 */
  exitCode?: number | null
  /** 终止信号（正常退出为 null）。 */
  signal?: string | null
  /** 是否因超时被杀（`timeoutMs` 预算耗尽）。 */
  timedOut?: boolean
  /** 是否被调用方取消（非超时）。 */
  aborted?: boolean
  /** 后台执行终态。 */
  status?: 'running' | 'completed' | 'killed'
  /** stdout 总字节数（= 流偏移；**未裁剪前**的产量）。 */
  stdoutBytes?: number
  /** stdout 实际保留字节数（内存窗口）。 */
  stdoutKept?: number
  /** stdout 被丢弃字节数（= bytes - kept，**「被截断了多少」的答案**）。 */
  stdoutDropped?: number
  stdoutTruncated?: boolean
  stderrBytes?: number
  stderrKept?: number
  stderrDropped?: number
  stderrTruncated?: boolean
  /** 后台执行：输出由 job 增量读取，本轨迹不消费（字节统计不可得）。 */
  streamsDeferred?: boolean
  /** 是否产生了溢出落盘文件（完整输出所在）。 */
  spill?: boolean
  /** 失败原因（spawn 抛错）。 */
  error?: string
}

/** 一次流读取的窄结构契约（与 subprocess `SubprocessOutputRead` 形状一致）。 */
export interface StreamRead {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

/** 流统计（Q4：产量 / 保留 / 丢弃）。 */
export interface StreamStats {
  bytes: number
  keptBytes: number
  droppedBytes: number
  truncated: boolean
  spill: boolean
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（与既有插件同约定，单一真源）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数，便于测试与文档化）。 */
export function wslTracePath(home: string): string {
  return join(home, 'wsl-trace.jsonl')
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串——尽力而为，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识：`<version>@<模块 mtime ms>`（版本缺失退化为 `unknown@<mtime>`）。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

let cachedSelfBuild: string | undefined

/**
 * 本模块自身的构建标识（Q1：进程级自报）。
 * 取 `lib/trace.js` 的 mtime（版本会说谎，mtime 不会）+ 同包 package.json 的 version。
 * 文件不可得时退化为 `unknown@0`，进程内缓存一次。
 */
export function selfBuild(): string {
  if (cachedSelfBuild !== undefined) return cachedSelfBuild
  try {
    const file = fileURLToPath(import.meta.url)
    cachedSelfBuild = buildStamp(file, readPackageVersion(file))
  } catch {
    cachedSelfBuild = 'unknown@0'
  }
  return cachedSelfBuild
}

/** 用户主目录的等价写法（Windows / POSIX / WSL `/mnt/<drive>` 三种形态，长的优先替换）。 */
export function homePathVariants(home: string): string[] {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (trimmed === '') return []
  const variants = new Set<string>([trimmed, trimmed.replace(/\\/g, '/')])
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed)
  if (drive !== null) {
    variants.add(`/mnt/${(drive[1] ?? '').toLowerCase()}/${(drive[2] ?? '').replace(/\\/g, '/')}`)
  }
  return [...variants].filter((v) => v !== '').sort((a, b) => b.length - a.length)
}

/** 折叠用户主目录前缀为 `<home>`（用户名不落盘）。 */
export function redactHome(text: string, home = homedir()): string {
  let out = text
  for (const variant of homePathVariants(home)) out = out.split(variant).join(HOME_TOKEN)
  return out
}

/** 凭据类键名判定（键名命中即脱敏其值）。 */
const SECRET_KEY = /(pass(word|wd)?|pwd|secret|token|credential|api[-_]?key|auth(orization)?|private[-_]?key|access[-_]?key)/i

/**
 * 脱敏（纯函数，幂等）：Bearer/Basic 头 → URL userinfo → `KEY=value`/`KEY: value`（键名像凭据）
 * → `--token=…` 类命令行旗标。**只减不加**：任何一处漏脱敏都是隐私事故，宁可过度脱敏。
 */
export function redactSecrets(text: string): string {
  let out = text
  out = out.replace(
    /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi,
    (_match, scheme: string) => `${scheme} ${REDACTED}`,
  )
  out = out.replace(
    /([a-zA-Z][\w+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/g,
    (_match, head: string) => `${head}:${REDACTED}@`,
  )
  out = out.replace(
    /([A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/g,
    (match, key: string, sep: string) =>
      SECRET_KEY.test(key) ? `${key}${sep}${REDACTED}` : match,
  )
  out = out.replace(
    /(--?[A-Za-z0-9-]*(?:password|passwd|pwd|token|secret|key|credential)[A-Za-z0-9-]*)(=|\s+)(\S+)/gi,
    (_match, flag: string, sep: string) => `${flag}${sep}${REDACTED}`,
  )
  return out
}

/**
 * 命令摘要（纯函数）：折平换行 → 脱敏 → 折叠主目录 → 截断（带「砍了多少字符」标记）。
 * 摘要长度上限是**观测预算**，不是命令本身的限制。
 */
export function summarizeCommand(command: string, maxLen = 240, home = homedir()): string {
  const flat = command
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, ' ; ')
    .trim()
  const safe = redactHome(redactSecrets(flat), home)
  if (safe.length <= maxLen) return safe
  return `${safe.slice(0, maxLen)}...(+${String(safe.length - maxLen)} chars)`
}

/**
 * 流统计（纯函数，Q4）：`nextOffset` 是**整流字节偏移**（可继续读的位置 = 已产量），
 * `text` 是内存里保留的尾巴——差值就是「被截断了多少」。negative 不可能，钳到 0。
 */
export function streamStatsOf(read: StreamRead): StreamStats {
  const bytes = Math.max(0, read.nextOffset)
  const keptBytes = Buffer.byteLength(read.text, 'utf8')
  return {
    bytes,
    keptBytes,
    droppedBytes: Math.max(0, bytes - keptBytes),
    truncated: read.lossy,
    spill: read.spillPath !== undefined,
  }
}

/** 稳定序列化（键序固定 + 单行 JSON，便于 `tail`/`grep`）。 */
export function serializeTraceEntry(entry: WslTraceEntry): string {
  const ordered: WslTraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    pid: entry.pid,
    caller: entry.caller,
    ...(entry.callId !== undefined ? { callId: entry.callId } : {}),
    ...(entry.distro !== undefined ? { distro: entry.distro } : {}),
    ...(entry.workdir !== undefined ? { workdir: entry.workdir } : {}),
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.commandChars !== undefined ? { commandChars: entry.commandChars } : {}),
    ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    durationMs: entry.durationMs,
    ...(entry.cfg !== undefined ? { cfg: entry.cfg } : {}),
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
    ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
    ...(entry.timedOut !== undefined ? { timedOut: entry.timedOut } : {}),
    ...(entry.aborted !== undefined ? { aborted: entry.aborted } : {}),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.stdoutBytes !== undefined ? { stdoutBytes: entry.stdoutBytes } : {}),
    ...(entry.stdoutKept !== undefined ? { stdoutKept: entry.stdoutKept } : {}),
    ...(entry.stdoutDropped !== undefined ? { stdoutDropped: entry.stdoutDropped } : {}),
    ...(entry.stdoutTruncated !== undefined ? { stdoutTruncated: entry.stdoutTruncated } : {}),
    ...(entry.stderrBytes !== undefined ? { stderrBytes: entry.stderrBytes } : {}),
    ...(entry.stderrKept !== undefined ? { stderrKept: entry.stderrKept } : {}),
    ...(entry.stderrDropped !== undefined ? { stderrDropped: entry.stderrDropped } : {}),
    ...(entry.stderrTruncated !== undefined ? { stderrTruncated: entry.stderrTruncated } : {}),
    ...(entry.streamsDeferred !== undefined ? { streamsDeferred: entry.streamsDeferred } : {}),
    ...(entry.spill !== undefined ? { spill: entry.spill } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛（轨迹是证据，不是契约校验器）。 */
export function parseTraceEntries(text: string): WslTraceEntry[] {
  const out: WslTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as WslTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断工具的安全入口）。 */
export function readTraceEntries(path: string): WslTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 false：轨迹是观测，绝不因写不进去而影响执行结果）。 */
export function appendTraceEntry(path: string, entry: WslTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔执行轨迹（薄接线：补 atMs/pid/build，路径缺省 `<DSH_HOME>/wsl-trace.jsonl`）。 */
export function wslTrace(
  entry: Omit<WslTraceEntry, 'atMs' | 'pid' | 'build'>,
  opts: { path?: string; home?: string; now?: number; pid?: number; build?: string } = {},
): boolean {
  const path = opts.path ?? wslTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, {
    atMs: opts.now ?? Date.now(),
    pid: opts.pid ?? process.pid,
    build: opts.build ?? selfBuild(),
    ...entry,
  })
}

/** 装载自报（`apply` 调用一次）：Q1 = 跑的是哪个构建 + 哪套配置。 */
export function wslTraceBoot(
  cfg: WslTraceConfig,
  opts: { path?: string; home?: string; now?: number; pid?: number; build?: string } = {},
): boolean {
  return wslTrace({ phase: 'boot', caller: 'apply', durationMs: 0, cfg }, opts)
}

/** 是否启用轨迹（`DSH_WSL_TRACE=0` 关闭；缺省开启——证据层是默认行为，不是可选项）。 */
export function traceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['DSH_WSL_TRACE'] !== '0'
}
