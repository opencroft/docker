import { terminal } from '@opencroft/server/terminal'

import type { LogView } from '../log-view'
import {
  type ContainerLogState,
  containerLogState,
  containerLogsSpec,
  deployFollowSpec,
  dockerServiceLogs,
  getDeployLog,
  type JobSpec,
  LOGS_TAIL_LINES,
} from './docker'
import { openStreamRedactor } from './redact'

// The Deploy and Logs tabs show output as terminal sessions started here, never by the browser:
// the command, the context it runs on and the credentials that reach it stay on the server, and
// every byte a watcher receives has been through the redactor first.

// Every view exists only to be watched, and a follow never ends on its own while its container runs.
// The tab that opened a view closes it when it lets go of it (closeView). Unwatched for this long,
// a view is stopped anyway: that covers a page that closed without saying so. A tab opened later
// starts another.
//
// Every view gets a job of its own rather than sharing one. A job has one watcher, and a second
// attaching takes the watch over without telling the first — which would be left showing "live"
// output that has silently stopped. Each view holds one of the job slots until it is closed.
const VIEW_UNWATCHED_MS = 60_000

// A container name or id as `docker logs` takes it. Anything else is refused before it reaches a
// command line.
const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

async function startRedactedJob(spec: JobSpec): Promise<string> {
  const redactor = await openStreamRedactor()
  const job = await terminal.startJob(spec.ctx, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    stdin: spec.stdin,
    filter: redactor,
    stopWhenUnwatchedMs: VIEW_UNWATCHED_MS,
  })
  return job.sessionKey
}

async function followView(spec: JobSpec): Promise<LogView> {
  return { sessionKey: await startRedactedJob(spec), live: true }
}

// Text that is already redacted, printed as a session that ends at once. The same terminal shows
// it, and the ended session keeps it for a watcher arriving a moment later.
async function printedView(text: string): Promise<LogView> {
  const job = await terminal.startJob(
    { type: 'local' },
    { command: 'cat', stdin: text, stopWhenUnwatchedMs: VIEW_UNWATCHED_MS },
  )
  return { sessionKey: job.sessionKey, live: false }
}

/**
 * The application's deploy output: followed while a detached deploy runs on a context that can
 * stream, otherwise the stored entry as it stands. Null when the application was never deployed.
 */
export async function watchDeploy(applicationNodeId: string): Promise<LogView | null> {
  const spec = await deployFollowSpec(applicationNodeId)
  if (spec) {
    return followView(spec)
  }
  const entry = await getDeployLog(applicationNodeId)
  return entry ? printedView(entry.text) : null
}

export interface ContainerParams {
  dockerNodeId: string
  container: string
}

export interface WatchLogsParams extends ContainerParams {
  /** Follow the log as the container writes it; otherwise print its last lines and end. */
  follow: boolean
}

function checkContainerRef(container: string): void {
  if (!CONTAINER_REF.test(container)) {
    throw new Error(`Not a container name or id: ${JSON.stringify(container)}`)
  }
}

/** What the Logs tab's header reports, fresh from the daemon. */
export async function containerState(params: ContainerParams): Promise<ContainerLogState> {
  checkContainerRef(params.container)
  return containerLogState(params.dockerNodeId, params.container)
}

/**
 * A container's log: its last LOGS_TAIL_LINES lines, then — with `follow` — everything it writes
 * after. A docker context that cannot stream gets the last lines as a snapshot, marked not live.
 */
export async function watchContainerLogs(params: WatchLogsParams): Promise<LogView> {
  const { dockerNodeId, container, follow } = params
  checkContainerRef(container)
  const spec = await containerLogsSpec(dockerNodeId, container, follow)
  if (!spec) {
    return printedView(
      await dockerServiceLogs({ dockerNodeId, service: '', containerId: container, tail: LOGS_TAIL_LINES }),
    )
  }
  return follow ? followView(spec) : { sessionKey: await startRedactedJob(spec), live: false }
}

/**
 * The tab that opened this view is done with it: it was replaced, or the tab was left. Stops the
 * view now rather than when VIEW_UNWATCHED_MS runs out. A view that has already ended is fine.
 */
export function closeView(sessionKey: string): void {
  terminal.stopViewJob(sessionKey)
}
