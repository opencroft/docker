// Which lifecycle verb does something to a container in a given daemon state. Shared by
// server/docker.ts (which containers an action runs on) and the Application and Docker nodes
// (which buttons and menu items are enabled), so what is offered and what runs agree.
//
// The state is the daemon's `{{.State}}` word. What each verb does in it, measured on Docker 28.4
// (03.10.2026):
//
// | state      | start                        | stop                     | restart                       |
// | ---------- | ---------------------------- | ------------------------ | ----------------------------- |
// | created    | starts it                    | no-op                    | starts it                     |
// | running    | no-op                        | stops it                 | restarts it                   |
// | paused     | refused by the daemon        | stops it                 | runs it again                 |
// | restarting | no-op, the loop goes on      | stops it, ends the loop  | runs it now, the loop resumes |
// | exited     | starts it                    | no-op                    | starts it                     |
//
// `dead` and `removing` were not produced in that measurement; a dead container can only be
// removed, and a removing one is on its way out, so neither gets a verb. Nor does a state this
// table does not name: offering nothing is safer than offering a verb with an unknown effect.

export type LifecycleVerb = 'start' | 'stop' | 'reboot'

const VERBS_BY_STATE: Record<string, readonly LifecycleVerb[]> = {
  created: ['start', 'reboot'],
  running: ['stop', 'reboot'],
  paused: ['stop', 'reboot'],
  restarting: ['stop', 'reboot'],
  exited: ['start', 'reboot'],
}

export function verbApplies(verb: LifecycleVerb, state: string | undefined): boolean {
  return state !== undefined && Object.hasOwn(VERBS_BY_STATE, state) && VERBS_BY_STATE[state].includes(verb)
}

/** A verb is available for a service when it does something to at least one of its containers. */
export function serviceLifecycle(containers: readonly { state?: string }[]): Record<LifecycleVerb, boolean> {
  const some = (verb: LifecycleVerb) => containers.some((c) => verbApplies(verb, c.state))
  return { start: some('start'), stop: some('stop'), reboot: some('reboot') }
}

/** Container states as the node shows them; every state outside the first three counts as stopped. */
const SHOWN_STATES = ['running', 'restarting', 'paused', 'stopped'] as const

type ShownState = (typeof SHOWN_STATES)[number]

function shownState(state: string | undefined): ShownState {
  return state === 'running' || state === 'restarting' || state === 'paused' ? state : 'stopped'
}

/**
 * One line on what a service's containers are doing, e.g. "1 running · 1 restarting", or just
 * "stopped" when none is doing anything; empty when the service has no containers.
 */
export function serviceSummary(containers: readonly { state?: string }[]): string {
  const counts = new Map<ShownState, number>()
  for (const c of containers) {
    const shown = shownState(c.state)
    counts.set(shown, (counts.get(shown) ?? 0) + 1)
  }
  if (counts.size === 1 && counts.has('stopped')) {
    return 'stopped'
  }
  return SHOWN_STATES.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(' · ')
}

/**
 * The service's status in the node frame's vocabulary: success when every container runs, error
 * when none runs or is coming back, warning for anything between, a restart loop included.
 */
export function serviceStatus(containers: readonly { state?: string }[]): 'neutral' | 'success' | 'warning' | 'error' {
  if (containers.length === 0) {
    return 'neutral'
  }
  const shown = containers.map((c) => shownState(c.state))
  if (shown.every((s) => s === 'running')) {
    return 'success'
  }
  return shown.every((s) => s === 'stopped') ? 'error' : 'warning'
}
