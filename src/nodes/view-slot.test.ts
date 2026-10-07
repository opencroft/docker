import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createViewSlot } from './view-slot.ts'

// A server that, like the terminal session manager, refuses an open past ten live views.
function fakeServer(cap = 10) {
  let next = 0
  const live = new Set<string>()
  const closed: string[] = []
  return {
    live,
    closed,
    /** Resolves after `ticks` turns of the event loop, the way an open is still in flight for a while. */
    async open(ticks = 1): Promise<string> {
      if (live.size >= cap) {
        throw new Error(`Session limit reached (${cap} active); close another session and retry.`)
      }
      next += 1
      const key = `job:${next}`
      live.add(key)
      for (let i = 0; i < ticks; i++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      return key
    },
    close(key: string) {
      live.delete(key)
      closed.push(key)
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('a tab and its view', () => {
  test('switching tabs more than ten times never reaches the cap, leaving mid-open included', async () => {
    const server = fakeServer()
    const inFlight: Promise<unknown>[] = []
    // Deploy, Logs, Terminal, round and round. The Terminal tab opens no view; Deploy and Logs do.
    const tabs = ['deploy', 'logs', 'terminal'] as const
    for (let visit = 0; visit < 30; visit++) {
      const tab = tabs[visit % tabs.length]
      if (tab === 'terminal') {
        continue
      }
      const slot = createViewSlot((key) => server.close(key))
      const ticket = slot.begin()
      const opened = server.open(3).then((key) => slot.hold(ticket, key))
      inFlight.push(opened)
      // Every other visit leaves before the open has come back; the rest once it has.
      if (visit % 2 === 0) {
        await opened
      }
      slot.release()
    }
    await Promise.all(inFlight)
    assert.equal(server.live.size, 0, 'every view was closed, the late ones as they arrived')
  })

  test('without letting go, the same switching reaches the cap: the failure the test above guards', async () => {
    const server = fakeServer()
    await assert.rejects(async () => {
      for (let visit = 0; visit < 30; visit++) {
        const slot = createViewSlot((key) => server.close(key))
        const ticket = slot.begin()
        slot.hold(ticket, await server.open())
      }
    }, /Session limit reached \(10 active\)/)
  })

  test('a newer view replaces the one held, which is closed', () => {
    const closed: string[] = []
    const slot = createViewSlot((key) => closed.push(key))
    assert.equal(slot.hold(slot.begin(), 'job:first'), true)
    assert.equal(slot.hold(slot.begin(), 'job:second'), true)
    assert.deepEqual(closed, ['job:first'])
  })

  test('an open overtaken by a newer one is closed when it arrives, and the newer is kept', async () => {
    const server = fakeServer()
    const slot = createViewSlot((key) => server.close(key))
    const older = slot.begin()
    const slow = server.open(5)
    const newer = slot.begin()
    assert.equal(slot.hold(newer, await server.open(1)), true)
    assert.equal(slot.isLatest(older), false, 'a failure of the older open is not shown either')
    assert.equal(slot.hold(older, await slow), false)
    assert.deepEqual([...server.live], ['job:2'])
  })

  test('holding the same view again does not close it', () => {
    const closed: string[] = []
    const slot = createViewSlot((key) => closed.push(key))
    slot.hold(slot.begin(), 'job:same')
    slot.hold(slot.begin(), 'job:same')
    assert.deepEqual(closed, [])
  })

  test('after release the slot can hold again, as a remounted effect does', async () => {
    const closed: string[] = []
    const slot = createViewSlot((key) => closed.push(key))
    slot.hold(slot.begin(), 'job:a')
    slot.release()
    await settle()
    assert.equal(slot.hold(slot.begin(), 'job:b'), true)
    assert.deepEqual(closed, ['job:a'])
  })
})
