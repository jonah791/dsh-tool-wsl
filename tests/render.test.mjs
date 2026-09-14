/**
 * render.ts 纯函数套件（离线、零 IO、零进程）。
 * 覆盖：正常路径 + 失败/退化路径（空输出、截断无落盘路径、kill 无 signal、参数非法）。
 * 不变量（S6 判据）：标记优先级（超时 > 信号 > 退出码）、截断提示不得静默丢失、
 * 参数非法必须 throw（fail-loud）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  streamText, renderResult, renderProcessRead, processOutcome, validateWslArgs,
  wslDescription, presentWslCall, presentWslResult, resolveWorkdir, canonicalWslResult,
} from '../lib/render.js'

const stream = (text, truncated = false, spillPath) => ({ text, truncated, ...(spillPath !== undefined ? { spillPath } : {}) })
const result = (over = {}) => ({
  exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 120000,
  stdout: stream(''), stderr: stream(''), ...over,
})

// ---------- streamText ----------

test('streamText: 未截断原样；截断带落盘路径提示', () => {
  assert.equal(streamText(stream('abc')), 'abc')
  assert.equal(streamText(stream('abc', true, '/tmp/spill.txt')), 'abc\n[output truncated; full output: /tmp/spill.txt]')
})

test('streamText: 退化路径——截断但拿不到落盘路径时不得静默丢提示', () => {
  assert.equal(streamText(stream('abc', true)), 'abc\n[output truncated; full output: (unavailable)]')
})

// ---------- renderResult ----------

test('renderResult: 仅 stdout / stdout+stderr 拼接 / 空输出占位', () => {
  assert.equal(renderResult(result({ stdout: stream('hello') })), 'hello')
  assert.equal(renderResult(result({ stdout: stream('out'), stderr: stream('err') })), 'out\n[stderr]\nerr')
  assert.equal(renderResult(result({ stdout: stream('out\n'), stderr: stream('err') })), 'out\n[stderr]\nerr')
  assert.equal(renderResult(result()), '(no output)')
})

test('renderResult: 标记优先级——超时 > 信号 > 退出码；exit code 0 不产生标记', () => {
  assert.equal(renderResult(result({ stdout: stream('x'), exitCode: 0 })), 'x')
  assert.equal(renderResult(result({ stdout: stream('x'), exitCode: 3 })), 'x\n[exit code: 3]')
  assert.equal(renderResult(result({ stdout: stream('x'), exitCode: 3, signal: 'SIGKILL' })), 'x\n[killed by signal: SIGKILL]')
  assert.equal(renderResult(result({ stdout: stream('x'), timedOut: true, timeoutMs: 5000, signal: 'SIGKILL' })),
    'x\n[timed out after 5000ms]\n[killed by signal: SIGKILL]')
})

test('renderResult: 退化路径——空 stdout + 失败标记（body 占位后仍带标记）', () => {
  assert.equal(renderResult(result({ timedOut: true, timeoutMs: 1000 })), '(no output)\n[timed out after 1000ms]')
})

// ---------- renderProcessRead ----------

test('renderProcessRead: 无丢失时原样返回 delta', () => {
  assert.equal(renderProcessRead({ delta: 'chunk', lossy: false }), 'chunk')
})

test('renderProcessRead: lossy 时附落盘路径（双路/单路/无路）', () => {
  assert.equal(renderProcessRead({ delta: 'd', lossy: true, stdoutSpillPath: '/a', stderrSpillPath: '/b' }),
    'd\n[some output was dropped from memory; full output: /a, /b]')
  assert.equal(renderProcessRead({ delta: 'd', lossy: true, stdoutSpillPath: '/a' }),
    'd\n[some output was dropped from memory; full output: /a]')
  assert.match(renderProcessRead({ delta: 'd', lossy: true }), /full output: \(unavailable\)\]$/)
})

test('renderProcessRead: 边界——delta 已以换行结尾不重复补；空 delta 不产生前导换行', () => {
  assert.equal(renderProcessRead({ delta: 'd\n', lossy: true, stdoutSpillPath: '/a' }),
    'd\n[some output was dropped from memory; full output: /a]')
  assert.equal(renderProcessRead({ delta: '', lossy: true, stdoutSpillPath: '/a' }),
    '[some output was dropped from memory; full output: /a]')
})

// ---------- processOutcome ----------

test('processOutcome: killed（有/无 signal）与 completed（有/无 exitCode）四态', () => {
  assert.deepEqual(processOutcome({ status: 'killed', signal: 'SIGKILL' }), { status: 'killed', detail: 'signal: SIGKILL' })
  assert.deepEqual(processOutcome({ status: 'killed', signal: null }), { status: 'killed', detail: 'killed before exit' })
  assert.deepEqual(processOutcome({ status: 'running', exitCode: 2 }), { status: 'completed', detail: 'exit code: 2' })
  assert.deepEqual(processOutcome({ status: 'running' }), { status: 'completed', detail: 'exit code: 0' })
})

// ---------- validateWslArgs ----------

test('validateWslArgs: 合法参数放行（含省略 timeoutMs）', () => {
  assert.equal(validateWslArgs({ command: 'ls', description: 'List files' }), undefined)
  assert.equal(validateWslArgs({ command: 'ls', description: 'd', timeoutMs: 1 }), undefined)
})

test('validateWslArgs: 失败路径——空/空白命令、空描述、非法超时一律 throw（fail-loud）', () => {
  assert.throws(() => validateWslArgs({ command: '', description: 'd' }), /invalid command/)
  assert.throws(() => validateWslArgs({ command: '   ', description: 'd' }), /invalid command/)
  assert.throws(() => validateWslArgs({ command: 'ls', description: '  ' }), /invalid description/)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateWslArgs({ command: 'ls', description: 'd', timeoutMs: bad }), /invalid timeoutMs/, `timeoutMs=${bad} 应被拒`)
  }
})

// ---------- wslDescription ----------

test('wslDescription: 含发行版名与执行通道说明；后台开关改变尾句', () => {
  const on = wslDescription(true, 'Ubuntu')
  const off = wslDescription(false, 'Debian')
  assert.match(on, /WSL \(Ubuntu\) environment via `wsl\.exe -d Ubuntu -- bash -c`/)
  assert.match(on, /base64 channel/)
  assert.match(on, /job_kill/)
  assert.match(off, /WSL \(Debian\)/)
  assert.match(off, /Background execution is not available/)
  assert.equal(off.includes('job_kill'), false)
})

// ---------- presentWslCall ----------

test('presentWslCall: 前台 → terminal 卡片（有/无 workdir）', () => {
  const a = presentWslCall({ command: 'ls', description: 'List' })
  assert.deepEqual(a, { card: 'terminal', title: 'ls', description: 'List' })
  const b = presentWslCall({ command: 'ls', description: 'List', workdir: '/w' })
  assert.equal(b.cwd, '/w')
})

test('presentWslCall: 后台 → generic 卡片（kind=execute + rawInput）', () => {
  const c = presentWslCall({ command: 'sleep 1', description: 'Wait', run_in_background: true })
  assert.equal(c.card, 'generic')
  assert.equal(c.kind, 'execute')
  assert.equal(c.rawInput, 'sleep 1')
  assert.deepEqual(c.content, [{ type: 'text', text: 'Wait' }])
})

// ---------- presentWslResult ----------

test('presentWslResult: 退化路径——content 非单块/非文本一律返回 undefined（不崩）', () => {
  assert.equal(presentWslResult(null, {}), undefined)
  assert.equal(presentWslResult(null, { content: [] }), undefined)
  assert.equal(presentWslResult(null, { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), undefined)
  assert.equal(presentWslResult(null, { content: [{ type: 'image' }] }), undefined)
})

test('presentWslResult: 前台成功 → terminal 卡片且 exitCode 从文本解析', () => {
  const r = presentWslResult({ command: 'ls', description: 'd' }, { content: [{ type: 'text', text: 'out\n[exit code: 3]' }] })
  assert.equal(r.card, 'terminal')
  assert.equal(r.output, 'out')
  assert.equal(r.exitCode, 3)
})

test('presentWslResult: 出错/后台 → generic 卡片 + 反引号围栏（去掉尾部换行）', () => {
  const err = presentWslResult(null, { content: [{ type: 'text', text: 'boom\n\n' }], isError: true })
  assert.equal(err.card, 'generic')
  assert.equal(err.content[0].text, '```console\nboom\n```')
  const bg = presentWslResult({ command: 'c', description: 'd', run_in_background: true }, { content: [{ type: 'text', text: 'ok' }] })
  assert.equal(bg.card, 'generic')
})

// ---------- resolveWorkdir ----------

test('resolveWorkdir: 未给 workdir 回落会话 cwd；相对路径按 cwd 解析；绝对路径原样', () => {
  const exec = { agent: { session: { header: { cwd: 'E:\\alice' } } } }
  assert.equal(resolveWorkdir(undefined, exec), 'E:\\alice')
  assert.equal(resolveWorkdir(undefined, {}), undefined)
  assert.equal(resolveWorkdir('/abs/path', exec), '/abs/path')
  assert.equal(resolveWorkdir('sub/dir', {}), 'sub/dir', '无 cwd 可依时原样透传')
})

// ---------- canonicalWslResult ----------

test('canonicalWslResult: 字段透传；spillPath 仅在存在时出现（JSON 无损）', () => {
  const withSpill = canonicalWslResult(result({ stdout: stream('o', true, '/s.txt'), exitCode: 7, signal: 'SIGTERM' }))
  assert.equal(withSpill.exitCode, 7)
  assert.equal(withSpill.signal, 'SIGTERM')
  assert.deepEqual(withSpill.stdout, { text: 'o', truncated: true, spillPath: '/s.txt' })
  const noSpill = canonicalWslResult(result())
  assert.equal('spillPath' in noSpill.stdout, false)
  assert.deepEqual(Object.keys(noSpill).sort(), ['aborted', 'exitCode', 'signal', 'stderr', 'stdout', 'timedOut', 'timeoutMs'])
})
