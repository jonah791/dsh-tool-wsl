/**
 * dsh-tool-wsl 执行轨迹单测（跑 lib 产物，不拉 cordis 依赖树）。
 *
 * 覆盖：正常路径（路径解析/脱敏/摘要/流统计/序列化/落盘/回读）+ 退化路径
 * （坏行/半行/空文件/缺失文件/目录当文件）+ **尸体测试**（父路径是普通文件 → 返回 false
 * 且不抛；且**执行结果照常返回**——观测绝不反噬主流程）+ 隐私尸体测试（凭据一个字不落盘）
 * + 接线测试（真实 WslExecutor 跑假 subprocess 接缝 → 轨迹落到 `<DSH_HOME>/wsl-trace.jsonl`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOME_TOKEN,
  REDACTED,
  appendTraceEntry,
  buildStamp,
  homePathVariants,
  parseTraceEntries,
  readPackageVersion,
  readTraceEntries,
  redactHome,
  redactSecrets,
  resolveHome,
  selfBuild,
  serializeTraceEntry,
  streamStatsOf,
  summarizeCommand,
  traceEnabled,
  wslTrace,
  wslTraceBoot,
  wslTracePath,
} from '../lib/trace.js'
import { WslExecutor } from '../lib/executor.js'

const tmp = mkdtempSync(join(tmpdir(), 'wsl-trace-test-'))
process.env['DSH_HOME'] = join(tmp, 'home')

const base = (entry) => ({
  atMs: 1_700_000_000_000,
  phase: 'exec/end',
  build: '0.3.0@12345',
  pid: 4242,
  caller: 'wsl:foreground',
  durationMs: 812,
  ...entry,
})

// ---------- 路径与构建自报（Q1） ----------

test('resolveHome：DSH_HOME 优先，空白/缺失回退 <homedir>/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: '   ' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'))
})

test('wslTracePath：锚定 DSH_HOME 下的单一文件名', () => {
  assert.equal(wslTracePath('/h/.dsh'), join('/h/.dsh', 'wsl-trace.jsonl'))
})

test('selfBuild：<version>@<mtime ms> 形态，且 mtime 来自产物文件（非 0）', () => {
  const build = selfBuild()
  assert.match(build, /^[^@]+@\d+$/)
  const [version, mtime] = build.split('@')
  assert.equal(version, readPackageVersion(fileURLToPath(new URL('../lib/trace.js', import.meta.url))))
  assert.ok(Number(mtime) > 0)
  assert.equal(selfBuild(), build) // 进程内缓存：同一构建串
  assert.equal(buildStamp('/nope/missing.js', ''), 'unknown@0') // 不可得退化
})

test('traceEnabled：DSH_WSL_TRACE=0 关闭，其余（含缺失）开启', () => {
  assert.equal(traceEnabled({ DSH_WSL_TRACE: '0' }), false)
  assert.equal(traceEnabled({}), true)
  assert.equal(traceEnabled({ DSH_WSL_TRACE: '1' }), true)
})

// ---------- 脱敏与摘要（隐私红线 + 摘要可读） ----------

test('redactSecrets：Bearer / URL userinfo / KEY=value / 命令行旗标全部命中', () => {
  const out = redactSecrets(
    'curl -H "Authorization: Bearer sk-abc123def456" --token=ghp_zzz9 '
    + 'mysql://root:hunter2@db.internal/x PASSWORD="a b c" GITHUB_TOKEN=ghp_xxx; ./deploy --password s3cret',
  )
  for (const secret of ['sk-abc123def456', 'ghp_zzz9', 'hunter2', 'a b c', 'ghp_xxx', 's3cret']) {
    assert.equal(out.includes(secret), false, `泄露：${secret}`)
  }
  assert.ok(out.includes(REDACTED))
})

test('redactSecrets：幂等 + 不误伤无关键名', () => {
  const once = redactSecrets('PASSWORD=x TOKEN=y make BUILD=1 path=/a/b')
  assert.equal(redactSecrets(once), once)
  assert.equal(once.includes('BUILD=1'), true) // 非凭据键名原样保留
  assert.equal(once.includes('path=/a/b'), true)
})

test('redactHome/homePathVariants：Windows、POSIX、WSL /mnt 三种形态都折叠成 <home>', () => {
  // 长的先替换（`/mnt/c/Users/tr` 15 字符在前，避免前缀先被吃掉导致残留）
  assert.deepEqual(homePathVariants('C:\\Users\\tr'), ['/mnt/c/Users/tr', 'C:\\Users\\tr', 'C:/Users/tr'])
  assert.deepEqual(homePathVariants(''), [])
  assert.equal(redactHome('cd /mnt/c/Users/tr/proj && ls', 'C:\\Users\\tr'), `cd ${HOME_TOKEN}/proj && ls`)
  assert.equal(redactHome('copy C:\\Users\\tr\\a.txt', 'C:\\Users\\tr'), `copy ${HOME_TOKEN}\\a.txt`)
})

test('summarizeCommand：折平换行、脱敏、折叠主目录、超长带裁剪标记', () => {
  assert.equal(summarizeCommand('a\n  b\nc', 240, 'C:\\Users\\tr'), 'a ; b ; c')
  assert.equal(summarizeCommand('PASSWORD=x ls', 240, 'C:\\Users\\tr'), `PASSWORD=${REDACTED} ls`)
  const long = summarizeCommand('x'.repeat(300), 240, 'C:\\Users\\tr')
  assert.equal(long.length > 240, true)
  assert.ok(long.endsWith('...(+60 chars)'))
  assert.equal(summarizeCommand('y'.repeat(10), 240, 'C:\\Users\\tr').length, 10)
})

// ---------- 流统计（Q4：被截断了多少） ----------

test('streamStatsOf：bytes 取整流偏移，dropped = bytes - kept（含钳位与 spill 标记）', () => {
  assert.deepEqual(streamStatsOf({ text: 'tail', nextOffset: 100, lossy: true, spillPath: '/t/s' }), {
    bytes: 100, keptBytes: 4, droppedBytes: 96, truncated: true, spill: true,
  })
  assert.deepEqual(streamStatsOf({ text: 'ok', nextOffset: 2, lossy: false }), {
    bytes: 2, keptBytes: 2, droppedBytes: 0, truncated: false, spill: false,
  })
  // 退化输入：未裁剪流上出现负偏移（不可能）→ 钳到 0，不产生负数字段
  assert.equal(streamStatsOf({ text: 'abc', nextOffset: -5, lossy: false }).bytes, 0)
  assert.equal(streamStatsOf({ text: '多字节', nextOffset: 9, lossy: true }).keptBytes, 9)
})

// ---------- 序列化 / 解析 / 落盘 ----------

test('serializeTraceEntry：单行 + 键序固定 + 缺省字段不污染', () => {
  const line = serializeTraceEntry(base({ stdoutDropped: 96 }))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'build', 'pid', 'caller', 'durationMs', 'stdoutDropped',
  ])
  const full = JSON.parse(serializeTraceEntry(base({
    callId: 'call-1', distro: 'Ubuntu', workdir: '/mnt/e/alice', command: 'ls', commandChars: 2,
    timeoutMs: 120000, exitCode: 0, signal: null, timedOut: false, aborted: false, status: 'completed',
    stdoutBytes: 10, stdoutKept: 10, stdoutDropped: 0, stdoutTruncated: false,
    stderrBytes: 0, stderrKept: 0, stderrDropped: 0, stderrTruncated: false, spill: false,
  })))
  // 键序：caller 之后依次是 callId?/distro?/…/timeoutMs?（可选字段前插），再 durationMs，再结果字段
  assert.equal(full.callId, 'call-1')
  assert.deepEqual(Object.keys(full).slice(6), [
    'distro', 'workdir', 'command', 'commandChars', 'timeoutMs', 'durationMs',
    'exitCode', 'signal', 'timedOut', 'aborted', 'status',
    'stdoutBytes', 'stdoutKept', 'stdoutDropped', 'stdoutTruncated',
    'stderrBytes', 'stderrKept', 'stderrDropped', 'stderrTruncated', 'spill',
  ])
  assert.equal(full.exitCode, 0) // null/0 都要如实落盘，不能被当成缺省丢掉
})

test('parseTraceEntries：坏行/半行/空行/null 全部跳过，不抛', () => {
  const good = serializeTraceEntry(base({}))
  const text = [
    '',
    good,
    '   ',
    '{"atMs":1,"phase":"exec/end"',        // 半行（JSON 截断）
    '{"atMs":"not-a-number","phase":"x"}', // 类型不符
    'null',
    '[1,2,3]',
    'not json at all',
  ].join('\n')
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].phase, 'exec/end')
})

test('readTraceEntries：缺失文件 / 目录当文件读 → 空数组（不抛）', () => {
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'wsl-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), [])
})

test('appendTraceEntry + readTraceEntries：正常落盘与回读（追加不覆盖）', () => {
  const path = join(tmp, 'ok', 'wsl-trace.jsonl')
  assert.equal(appendTraceEntry(path, base({ phase: 'exec/start', durationMs: 0 })), true)
  assert.equal(appendTraceEntry(path, base({})), true)
  const back = readTraceEntries(path)
  assert.equal(back.length, 2)
  assert.deepEqual(back.map((e) => e.phase), ['exec/start', 'exec/end'])
  assert.equal(readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 2)
})

test('尸体测试：父路径是普通文件 → 返回 false 且不抛（观测不反噬主流程）', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  assert.doesNotThrow(() => {
    assert.equal(appendTraceEntry(join(blocker, 'wsl-trace.jsonl'), base({})), false)
  })
  assert.equal(appendTraceEntry(join(blocker, 'x', 'y.jsonl'), base({})), false)
})

test('wslTrace：注入 now/pid/路径，落一行可回读；不可写路径返回 false', () => {
  const path = join(tmp, 'thin', 'wsl-trace.jsonl')
  assert.equal(wslTrace(
    { phase: 'exec/start', caller: 'wsl:foreground', durationMs: 0, command: 'ls', commandChars: 2 },
    { path, now: 99, pid: 7, build: 'b@1' },
  ), true)
  const [line] = readTraceEntries(path)
  assert.equal(line.atMs, 99)
  assert.equal(line.pid, 7)
  assert.equal(line.build, 'b@1')
  const blocker = join(tmp, 'blocker')
  assert.equal(wslTrace({ phase: 'exec/end', caller: 'wsl', durationMs: 1 }, {
    path: join(blocker, 'wsl-trace.jsonl'), now: 1, pid: 1,
  }), false)
})

test('wslTraceBoot：boot 行自报生效配置（Q1 配置面）', () => {
  const path = join(tmp, 'boot', 'wsl-trace.jsonl')
  const cfg = {
    distro: 'Ubuntu', wslExe: 'wsl.exe', loginShell: false, timeoutMs: 120000,
    maxTimeoutMs: 600000, maxOutputBytes: 64000, maxSpillBytes: 1024, enableRunInBackground: true,
  }
  assert.equal(wslTraceBoot(cfg, { path, now: 5, pid: 6, build: 'b@2' }), true)
  const [line] = readTraceEntries(path)
  assert.equal(line.phase, 'boot')
  assert.equal(line.caller, 'apply')
  assert.deepEqual(line.cfg, cfg)
})

// ---------- 隐私尸体测试（派发纪律：凭据一个字都不许落盘） ----------

test('隐私尸体测试：含凭据的命令 → 落盘行里搜不到任何凭据串', () => {
  const path = join(tmp, 'privacy', 'wsl-trace.jsonl')
  const secrets = ['hunter2', 'ghp_SECRETVALUE', 'sk-live-9f8e7d', 'correct-horse-battery']
  const command = [
    'export GITHUB_TOKEN=ghp_SECRETVALUE',
    'curl -H "Authorization: Bearer sk-live-9f8e7d" https://api.example/x',
    'psql postgres://admin:hunter2@db/x',
    `mysql -u root --password='correct-horse-battery' -e 'select 1'`,
    'echo done',
  ].join('\n')
  assert.equal(wslTrace({
    phase: 'exec/start', caller: 'wsl:foreground', durationMs: 0,
    command: summarizeCommand(command, 240, 'C:\\Users\\tr'),
    commandChars: command.length,
  }, { path, now: 1, pid: 1 }), true)
  const raw = readFileSync(path, 'utf8')
  for (const secret of secrets) assert.equal(raw.includes(secret), false, `轨迹泄露凭据：${secret}`)
  assert.equal(raw.includes(REDACTED), true) // 脱敏确实发生了（不是「什么都没写」）
})

// ---------- 接线测试：真实执行器 → 轨迹（Q2/Q3/Q4/Q5 五问实证） ----------

/** 假 subprocess 接缝（形状与 dsh-subprocess 的 CollectReader/Handle 一致）。 */
function fakeSubprocess(reads) {
  return {
    spawn: () => ({
      done: Promise.resolve({ exitCode: reads.exitCode ?? 0, signal: null }),
      collected: {
        stdout: { readFrom: () => reads.stdout },
        stderr: { readFrom: () => reads.stderr },
      },
      terminate: () => {},
    }),
  }
}

const specOf = (over = {}) => ({
  command: 'echo hi',
  workdir: 'C:\\Users\\tr\\proj',
  timeoutMs: 120000,
  stdoutMaxBytes: 64000,
  ...over,
})
const configOf = () => ({
  distro: 'Ubuntu', wslExe: 'wsl.exe', loginShell: false, timeoutMs: 120000, maxTimeoutMs: 600000,
  maxOutputBytes: 64000, maxSpillBytes: 1024, graceMs: 3000,
})
const ctxOf = (spawned) => ({ subprocess: spawned })

test('接线：前台执行落 exec/start + exec/end，且**被截断了多少**在轨迹里可读', async () => {
  const path = join(tmp, 'wired', 'wsl-trace.jsonl')
  process.env['DSH_HOME'] = join(tmp, 'wired')
  const ex = new WslExecutor(ctxOf(fakeSubprocess({
    stdout: { text: 'tail-of-output', nextOffset: 5000, lossy: true, spillPath: '/tmp/spill0' },
    stderr: { text: 'warn', nextOffset: 4, lossy: false },
  })), configOf())
  const result = await ex.runArgv(specOf({ traceCallId: 'call-42' }), ['wsl.exe'])
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.truncated, true)
  const lines = readTraceEntries(path)
  assert.deepEqual(lines.map((l) => l.phase), ['exec/start', 'exec/end'])
  const end = lines[1]
  assert.equal(end.caller, 'wsl:foreground')
  assert.equal(end.callId, 'call-42')
  assert.equal(end.distro, 'Ubuntu')
  assert.equal(end.workdir, redactHome(specOf().workdir))   // 用户名不落盘（主目录折叠为 <home>）
  assert.equal(end.timeoutMs, 120000)                        // Q5 预算
  assert.equal(typeof end.durationMs, 'number')
  assert.equal(end.stdoutBytes, 5000)                        // Q4 产量
  assert.equal(end.stdoutDropped, 5000 - Buffer.byteLength('tail-of-output', 'utf8'))
  assert.equal(end.stdoutTruncated, true)
  assert.equal(end.stderrBytes, 4)
  assert.equal(end.spill, true)
})

test('接线：traceLabel 区分调用方（wsl_env 与 wsl:background 各自可辨）', async () => {
  const home = join(tmp, 'wired2')
  process.env['DSH_HOME'] = home
  const reads = { stdout: { text: 'x', nextOffset: 1, lossy: false }, stderr: { text: '', nextOffset: 0, lossy: false } }
  const ex = new WslExecutor(ctxOf(fakeSubprocess(reads)), configOf())
  await ex.runArgv(specOf({ traceLabel: 'wsl_env' }), [])
  const proc = ex.startArgv(specOf({ traceLabel: 'wsl:background' }), [])
  await proc.done
  const lines = readTraceEntries(wslTracePath(home))
  assert.deepEqual(lines.map((l) => l.phase), ['exec/start', 'exec/end', 'exec/start', 'exec/end'])
  assert.equal(lines[0].caller, 'wsl_env')
  assert.equal(lines[2].caller, 'wsl:background')
  assert.equal(lines[3].streamsDeferred, true)   // 后台输出归 job，字节统计不可得（诚实标注）
  assert.equal(lines[2].streamsDeferred, undefined)
  assert.equal(lines[3].status, 'completed')
})

test('尸体测试（接线级）：DSH_HOME 不可写时执行照常返回，绝不反噬主流程', async () => {
  const blocker = join(tmp, 'blocker-wired')      // 父路径是普通文件
  writeFileSync(blocker, 'not a dir', 'utf8')
  process.env['DSH_HOME'] = join(blocker, 'nope')
  const ex = new WslExecutor(ctxOf(fakeSubprocess({
    stdout: { text: 'ok', nextOffset: 2, lossy: false },
    stderr: { text: '', nextOffset: 0, lossy: false },
  })), configOf())
  const result = await ex.runArgv(specOf(), [])
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, 'ok')
  assert.deepEqual(readTraceEntries(join(blocker, 'nope', 'wsl-trace.jsonl')), [])
})

test('接线：spawn 抛错 → exec/error 落盘（Q3 断点）且错误照常抛出', async () => {
  const home = join(tmp, 'wired3')
  process.env['DSH_HOME'] = home
  const broken = { spawn: () => { throw new Error('ENOENT: wsl.exe not found') } }
  const ex = new WslExecutor(ctxOf(broken), configOf())
  await assert.rejects(() => ex.runArgv(specOf(), []), /ENOENT/)
  assert.throws(() => ex.startArgv(specOf(), []), /ENOENT/)   // 后台同步抛错路径同样留痕
  const lines = readTraceEntries(wslTracePath(home))
  // 每次尝试都是 start → error 一对（start 在 spawn 之前落笔，才能证明「确实试过执行」）
  assert.deepEqual(lines.map((l) => l.phase), ['exec/start', 'exec/error', 'exec/start', 'exec/error'])
  assert.equal(lines[1].error.includes('ENOENT'), true)
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
