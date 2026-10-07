import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { deployFollowScript } from './deploy-follow.ts'

function hasCommand(name: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const TOOLS = ['sh', 'wc', 'tail', 'head', 'sleep']
const missing = TOOLS.filter((tool) => !hasCommand(tool))
const skip = missing.length > 0 ? `needs ${missing.join(', ')} on PATH` : false

interface Run {
  child: ChildProcess
  output: () => string
  /** The shell has exited and its output is complete. */
  exited: Promise<number | null>
  /** The shell has exited; a process it left behind may still hold its output open. */
  shellGone: Promise<void>
}

// Followers a test started that have not exited yet.
const running = new Set<ChildProcess>()

function follow(dir: string, maxBytes = 1024 * 1024): Run {
  const script = deployFollowScript({ logPath: join(dir, 'run.log'), rcPath: join(dir, 'run.rc') }, maxBytes)
  const child = spawn('sh', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  running.add(child)
  child.on('exit', () => running.delete(child))
  let output = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    output += chunk
  })
  child.stdin?.end('HEADER\n')
  return {
    child,
    output: () => output,
    exited: new Promise((resolve) => child.on('close', (code) => resolve(code))),
    shellGone: new Promise((resolve) => child.on('exit', () => resolve())),
  }
}

/** How many processes carry `text` in their command line — the shell's own included. */
function processesNaming(text: string): number {
  let count = 0
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(text)) {
        count++
      }
    } catch {
      // The process ended between the listing and the read.
    }
  }
  return count
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function withDir(run: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-follow-'))
    try {
      await run(dir)
    } finally {
      // A test that fails before its follower exits would leave it polling for an rc file that
      // never comes, and its open output would keep the whole run from ending.
      for (const child of running) {
        child.kill()
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

describe('deployFollowScript', { skip }, () => {
  test(
    'shows lines as they are written, before the deploy ends, then exits once the rc file appears',
    withDir(async (dir) => {
      writeFileSync(join(dir, 'run.log'), 'line 1\n')
      const run = follow(dir)

      await until(() => run.output().includes('line 1'), 'the first line')
      appendFileSync(join(dir, 'run.log'), 'line 2\n')
      await until(() => run.output().includes('line 2'), 'a line written while it runs')
      assert.equal(run.child.exitCode, null, 'still following: the deploy has not ended')

      appendFileSync(join(dir, 'run.log'), 'last line\n')
      writeFileSync(join(dir, 'run.rc'), '0\n')

      assert.equal(await run.exited, 0)
      assert.equal(run.output(), 'HEADER\nline 1\nline 2\nlast line\n', 'the header, then every line once, in order')
    }),
  )

  test(
    'starts no further back than the size limit',
    withDir(async (dir) => {
      writeFileSync(join(dir, 'run.log'), 'abcdefghij')
      writeFileSync(join(dir, 'run.rc'), '1\n')
      const run = follow(dir, 4)

      assert.equal(await run.exited, 0)
      assert.equal(run.output(), 'HEADER\nghij')
    }),
  )

  test(
    'waits for a log that does not exist yet',
    withDir(async (dir) => {
      const run = follow(dir)
      await until(() => run.output() === 'HEADER\n', 'the header')
      writeFileSync(join(dir, 'run.log'), 'late start\n')
      writeFileSync(join(dir, 'run.rc'), '0\n')

      assert.equal(await run.exited, 0)
      assert.equal(run.output(), 'HEADER\nlate start\n')
    }),
  )

  test(
    'stopping it leaves nothing reading the log',
    { skip: existsSync('/proc/self/cmdline') ? false : 'reads process command lines from /proc' },
    withDir(async (dir) => {
      const logPath = join(dir, 'run.log')
      writeFileSync(logPath, 'running\n')
      const run = follow(dir)
      await until(() => run.output().includes('running'), 'the first line')

      run.child.kill()
      await run.shellGone

      await until(() => processesNaming(logPath) === 0, 'no process left naming the log')
    }),
  )
})
