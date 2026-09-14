/**
 * dsh-tool-wsl — 渲染 / 校验 / 展示层（纯函数，零 IO，可离线单测）
 *
 * 2026-09-14 可维护性补课：这些都困在 index.ts 的 apply 文件作用域里、未导出，
 * 于是「超时标记怎么渲染」「kill 的进程怎么归类」「参数非法怎么报」只能靠人读源码。
 * 本次**仅搬家**（行为逐字不变），index.ts 只留 apply 接线。
 *
 * 不变量（tests/render.test.mjs 锁住）：
 *   1. `renderResult` 的标记优先级：超时 > 信号 > 退出码；`exit code: 0` 不产生标记
 *   2. 截断必带 spill 路径提示（拿不到路径时写 `(unavailable)`，不得静默丢提示）
 *   3. `validateWslArgs` 对空命令 / 空描述 / 非正超时一律 **throw**（fail-loud，不是静默放行）
 *   4. `processOutcome` 只在 status==='killed' 时判 killed；completed 时 exitCode 缺失记为 0
 */

import { isAbsolute, resolve } from 'node:path'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { WslProcess, WslRunResult } from './executor.ts'

// ---------- 渲染 ----------

export function streamText(output: { text: string; truncated: boolean; spillPath?: string }): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

export function renderResult(result: WslRunResult): string {
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

export function renderProcessRead(read: { delta: string; lossy: boolean; stdoutSpillPath?: string; stderrSpillPath?: string }): string {
  const notices: string[] = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((p): p is string => p !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

export function processOutcome(proc: WslProcess): { status: 'killed' | 'completed'; detail: string } {
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

// ---------- 工具契约 ----------

export interface WslArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  stdin?: string
  run_in_background?: boolean
}

export function validateWslArgs(args: WslArgs): void {
  if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
}

export function wslDescription(backgroundEnabled: boolean, distro: string): string {
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  return `Execute a command in the WSL (${distro}) environment via \`wsl.exe -d ${distro} -- bash -c\` and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass \`workdir\` instead of using \`cd\`. Paths are Windows paths (e.g. E:\\\\alice); the command runs in the corresponding WSL directory. Non-zero exits are reported as \`[exit code: N]\`. Commands run inside the WSL Linux environment and are NOT confined by the Windows file sandbox. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. The command is passed via a base64 channel (wsl.exe re-parses argv and would corrupt \`$\`/quotes/multiline), so any complex bash — variables, quotes, heredocs, pipes — is transmitted verbatim. ` + background
}

export function presentWslCall(args: WslArgs): ToolCallView | undefined {
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

export function presentWslResult(args: WslArgs | null, result: { content?: { type: string; text?: string }[]; isError?: boolean }): ToolResultView | undefined {
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

// ---------- 工作目录 ----------

export function resolveWorkdir(modelWorkdir: string | undefined, exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  const headerCwd = exec.agent?.session?.header?.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir)
  return modelWorkdir
}

// ---------- 结果规范化 ----------

export function canonicalWslResult(result: WslRunResult) {
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
