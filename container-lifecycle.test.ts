import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { serviceLifecycle, serviceStatus, serviceSummary, verbApplies } from './container-lifecycle.ts'

const one = (state: string) => [{ state }]

describe('serviceLifecycle', () => {
  test('gives every daemon state the verbs that do something to it', () => {
    assert.deepEqual(serviceLifecycle(one('created')), { start: true, stop: false, reboot: true })
    assert.deepEqual(serviceLifecycle(one('running')), { start: false, stop: true, reboot: true })
    assert.deepEqual(serviceLifecycle(one('paused')), { start: false, stop: true, reboot: true })
    assert.deepEqual(serviceLifecycle(one('restarting')), { start: false, stop: true, reboot: true })
    assert.deepEqual(serviceLifecycle(one('exited')), { start: true, stop: false, reboot: true })
  })

  test('offers nothing for dead, removing, an unknown state or a missing one', () => {
    const none = { start: false, stop: false, reboot: false }
    assert.deepEqual(serviceLifecycle(one('dead')), none)
    assert.deepEqual(serviceLifecycle(one('removing')), none)
    assert.deepEqual(serviceLifecycle(one('hibernating')), none)
    assert.deepEqual(serviceLifecycle([{}]), none)
  })

  test('offers nothing for a service without containers', () => {
    assert.deepEqual(serviceLifecycle([]), { start: false, stop: false, reboot: false })
  })

  test('offers a verb when it applies to any one replica', () => {
    assert.deepEqual(serviceLifecycle([{ state: 'running' }, { state: 'exited' }]), {
      start: true,
      stop: true,
      reboot: true,
    })
  })

  test('does not read a state name off the object prototype', () => {
    assert.equal(verbApplies('start', 'constructor'), false)
  })
})

describe('serviceSummary', () => {
  test('names a restart loop rather than calling it stopped', () => {
    assert.equal(serviceSummary(one('restarting')), '1 restarting')
  })

  test('counts each shown state, in a fixed order', () => {
    assert.equal(
      serviceSummary([{ state: 'exited' }, { state: 'restarting' }, { state: 'running' }, { state: 'running' }]),
      '2 running · 1 restarting · 1 stopped',
    )
  })

  test('says "stopped" when nothing is running, restarting or paused', () => {
    assert.equal(serviceSummary([{ state: 'exited' }, { state: 'created' }, { state: 'dead' }]), 'stopped')
  })

  test('says nothing for a service without containers', () => {
    assert.equal(serviceSummary([]), '')
  })
})

describe('serviceStatus', () => {
  test('is a warning while a container is restarting or paused', () => {
    assert.equal(serviceStatus(one('restarting')), 'warning')
    assert.equal(serviceStatus(one('paused')), 'warning')
  })

  test('is success when every container runs, error when none is', () => {
    assert.equal(serviceStatus([{ state: 'running' }, { state: 'running' }]), 'success')
    assert.equal(serviceStatus([{ state: 'exited' }, { state: 'created' }]), 'error')
  })

  test('is a warning for a partly running service and neutral for an empty one', () => {
    assert.equal(serviceStatus([{ state: 'running' }, { state: 'exited' }]), 'warning')
    assert.equal(serviceStatus([]), 'neutral')
  })
})
