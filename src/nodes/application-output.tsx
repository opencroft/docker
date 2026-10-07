import { invoke, React } from '@ext/host'
import { InspectorTerminalBody } from '@ext/ui'

import type { DeployLogEntry } from '../../deploy-log'
import type { LogView } from '../../log-view'
import { type AppData, useDockerNodeId, useInspectedContainer } from './application'
import { ApplicationEmpty } from './application-empty'
import { type HeaderState, OutputHeader } from './output-header'
import { createViewSlot, type ViewSlot } from './view-slot'

// The Deploy and Logs tabs. Both show a session the server started — never a connection the
// browser opens — through the same header and the same terminal, and both follow their subject by
// re-reading its state, so each state reads as what it is: live output, finished output, or none.
// "None" is ApplicationEmpty, the empty state the Terminal tab shows too.
//
// Each view the server starts holds one of its job slots until it is closed, so a tab hands every
// view it opens to its ViewSlot, which closes it as soon as the tab is done with it.

const { useCallback, useEffect, useRef, useState } = React

// How often a tab re-reads the state its header shows.
const STATE_POLL_MS = 3000

/**
 * A tab: its header over the terminal watching `view`. The terminal only ever attaches — the
 * session is the server's — and a session that ends is the end of the output, not a fault, so it
 * leaves what it showed on screen and reports the end through `onEnded`.
 */
function OutputTab({ header, view, onEnded }: { header: HeaderState; view: LogView | null; onEnded: (view: LogView) => void }) {
  return (
    <div className='flex flex-col h-full'>
      <OutputHeader {...header} />
      {view ? (
        <div className='flex-1 min-h-0'>
          <InspectorTerminalBody
            key={view.sessionKey}
            attachKey={view.sessionKey}
            logView
            readOnly
            onStatusChange={(status: string) => {
              if (status === 'disconnected') {
                onEnded(view)
              }
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function closeView(sessionKey: string): void {
  // Failing to close leaves the view to the server's unwatched bound, so there is nothing to tell.
  invoke('docker.closeView', { sessionKey }).catch(() => {})
}

/** This tab's ViewSlot. Leaving the tab closes the view it holds. */
function useViewSlot(): ViewSlot {
  const slot = useRef<ViewSlot | null>(null)
  if (!slot.current) {
    slot.current = createViewSlot(closeView)
  }
  useEffect(() => {
    const current = slot.current
    return () => current?.release()
  }, [])
  return slot.current
}

// ── Deploy ──────────────────────────────────────────────────────────────────

type DeployStatus = Omit<DeployLogEntry, 'text'>

/** The view on screen, and what it was opened for. */
interface DeployWatch {
  at: string
  view: LogView | null
  /** The session has ended — a finished print, or a follow that stopped. */
  ended: boolean
  /** The entry was running when the view was opened. */
  openedWhileRunning: boolean
}

// Whether the view on screen no longer shows the deploy as it stands. A live follow is current
// until it ends; a snapshot is current only once the deploy has finished.
function deployViewIsStale(status: DeployStatus, watch: DeployWatch): boolean {
  if (watch.at !== status.at) {
    return true
  }
  if (status.status === 'running') {
    return watch.ended || !watch.view?.live
  }
  return watch.openedWhileRunning && !watch.view?.live
}

function deployHeader(status: DeployStatus, watch: DeployWatch | null): HeaderState {
  const reboot = status.action === 'restart'
  const when = new Date(status.at).toLocaleString()
  if (status.status === 'running') {
    const notLive = watch?.view && !watch.view.live ? ' · not live: this Docker context cannot stream, so this refreshes every few seconds' : ''
    return { indicator: 'warning', title: reboot ? 'Rebooting…' : 'Deploying…', detail: `started ${when}${notLive}` }
  }
  const truncated = status.truncated ? ' · earlier output cut' : ''
  if (status.exitCode !== undefined && status.exitCode !== 0) {
    return { indicator: 'destructive', title: `${reboot ? 'Reboot' : 'Deploy'} failed · exit ${status.exitCode}`, detail: `${when}${truncated}` }
  }
  return { indicator: 'success', title: reboot ? 'Rebooted' : 'Deployed', detail: `${when}${truncated}` }
}

export function ApplicationDeployTab({ nodeId, data }: { nodeId: string; data: AppData; updateData: (p: Partial<AppData>) => void }) {
  const [status, setStatus] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; status: DeployStatus | null }>({
    kind: 'loading',
  })
  const [watch, setWatch] = useState<DeployWatch | null>(null)
  const [watchError, setWatchError] = useState<string | null>(null)
  const slot = useViewSlot()

  const readStatus = useCallback(async () => {
    try {
      setStatus({ kind: 'ready', status: await invoke<DeployStatus | null>('docker.deployStatus', { applicationNodeId: nodeId }) })
    } catch (err) {
      setStatus({ kind: 'error', message: errorMessage(err) })
    }
  }, [nodeId])

  useEffect(() => {
    readStatus()
    const timer = setInterval(readStatus, STATE_POLL_MS)
    return () => clearInterval(timer)
  }, [readStatus])

  const openView = useCallback(
    async (current: DeployStatus) => {
      const ticket = slot.begin()
      try {
        const view = await invoke<LogView | null>('docker.watchDeploy', { applicationNodeId: nodeId })
        if (view ? !slot.hold(ticket, view.sessionKey) : !slot.isLatest(ticket)) {
          return
        }
        setWatchError(null)
        setWatch({ at: current.at, view, ended: false, openedWhileRunning: current.status === 'running' })
      } catch (err) {
        if (slot.isLatest(ticket)) {
          setWatchError(errorMessage(err))
        }
      }
    },
    [nodeId, slot],
  )

  // Every read of the status decides whether the view still shows the deploy as it stands: a new
  // deploy, a follow that stopped while the deploy runs on, a snapshot of a run that has since
  // finished. A failed open waits for Retry rather than being retried every few seconds.
  // One open at a time: the status is re-read every few seconds, and a slow open must not be
  // started again underneath itself.
  const opening = useRef(false)
  const current = status.kind === 'ready' ? status.status : null
  useEffect(() => {
    if (!current || watchError || opening.current) {
      return
    }
    if (!watch || deployViewIsStale(current, watch)) {
      opening.current = true
      openView(current).finally(() => {
        opening.current = false
      })
    }
  }, [current, watch, watchError, openView])

  if (status.kind === 'loading') {
    return <ApplicationEmpty nodeId={nodeId} data={data} reason='checking' subject='output' />
  }
  if (status.kind === 'error') {
    return (
      <OutputTab
        header={{ indicator: 'destructive', title: 'Could not read the deploy', detail: status.message, action: { label: 'Retry', onClick: readStatus } }}
        view={null}
        onEnded={() => {}}
      />
    )
  }
  if (!current) {
    return <ApplicationEmpty nodeId={nodeId} data={data} reason='not-deployed' subject='output' />
  }
  const header: HeaderState =
    watchError
      ? { indicator: 'destructive', title: 'Could not open the output', detail: watchError, action: { label: 'Retry', onClick: () => setWatchError(null) } }
      : deployHeader(current, watch)
  const shown = watch && watch.at === current.at ? watch : null
  // A follow ends when its deploy does, a moment before the status says so. Reading the status
  // first means that end is seen as a finished deploy, and only a follow lost mid-deploy reopens.
  const markEnded = async (endedView: LogView) => {
    await readStatus()
    setWatch((w) => (w && w.view === endedView ? { ...w, ended: true } : w))
  }
  return <OutputTab header={header} view={shown?.view ?? null} onEnded={markEnded} />
}

// ── Logs ────────────────────────────────────────────────────────────────────

interface ContainerState {
  state: 'running' | 'stopped' | 'missing'
  status: string
}

interface LogsWatch {
  /** Whether the view was opened to follow a running container. */
  follow: boolean
  view: LogView
  ended: boolean
}

export function ApplicationLogsTab({ nodeId, data }: { nodeId: string; data: AppData; updateData: (p: Partial<AppData>) => void }) {
  const dockerNodeId = useDockerNodeId(nodeId)
  const container = useInspectedContainer(nodeId, data)
  if (!dockerNodeId) {
    return <ApplicationEmpty nodeId={nodeId} data={data} reason='no-docker' subject='logs' />
  }
  return <ContainerLogs key={`${dockerNodeId}:${container}`} nodeId={nodeId} data={data} dockerNodeId={dockerNodeId} container={container} />
}

function logsHeader(container: string, state: ContainerState, watch: LogsWatch | null, reopen: () => void): HeaderState {
  if (state.state === 'stopped') {
    return { indicator: 'secondary', title: 'Stopped', detail: `${container} · ${state.status} · its last lines` }
  }
  if (watch && !watch.view.live) {
    return {
      indicator: 'warning',
      title: 'Running',
      detail: `${container} · its last lines: this Docker context cannot stream`,
      action: { label: 'Refresh', onClick: reopen },
    }
  }
  if (watch?.follow && watch.ended) {
    return { indicator: 'destructive', title: 'Log stream ended', detail: `${container} is still running`, action: { label: 'Reconnect', onClick: reopen } }
  }
  return { indicator: 'success', title: 'Live', detail: container }
}

function ContainerLogs({ nodeId, data, dockerNodeId, container }: { nodeId: string; data: AppData; dockerNodeId: string; container: string }) {
  const [state, setState] = useState<ContainerState | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [watch, setWatch] = useState<LogsWatch | null>(null)
  const [watchError, setWatchError] = useState<string | null>(null)
  // Bumped to open the view again for the same state: Reconnect, Refresh, Retry.
  const [attempt, setAttempt] = useState(0)
  const slot = useViewSlot()

  const readState = useCallback(async () => {
    try {
      setState(await invoke<ContainerState>('docker.containerState', { dockerNodeId, container }))
      setStateError(null)
    } catch (err) {
      setStateError(errorMessage(err))
    }
  }, [dockerNodeId, container])

  // A live follow says when it ends, so the state is re-read only while nothing live is on screen:
  // that is how a stopped container starting again, or a new one appearing, is noticed.
  const following = state?.state === 'running' && watch?.follow && watch.view.live && !watch.ended
  useEffect(() => {
    readState()
    if (following) {
      return
    }
    const timer = setInterval(readState, STATE_POLL_MS)
    return () => clearInterval(timer)
  }, [readState, following])

  const follow = state?.state === 'running'
  const hasLog = state?.state === 'running' || state?.state === 'stopped'
  useEffect(() => {
    if (!hasLog) {
      slot.release()
      setWatch(null)
      return
    }
    const ticket = slot.begin()
    invoke<LogView>('docker.watchLogs', { dockerNodeId, container, follow })
      .then((view) => {
        if (slot.hold(ticket, view.sessionKey)) {
          setWatch({ follow, view, ended: false })
          setWatchError(null)
        }
      })
      .catch((err: unknown) => {
        if (slot.isLatest(ticket)) {
          setWatchError(errorMessage(err))
        }
      })
  }, [dockerNodeId, container, hasLog, follow, attempt, slot])

  const reopen = useCallback(() => setAttempt((n) => n + 1), [])

  let header: HeaderState
  if (stateError) {
    header = { indicator: 'destructive', title: 'Cannot reach Docker', detail: stateError, action: { label: 'Retry', onClick: readState } }
  } else if (!state || state.state === 'missing') {
    return <ApplicationEmpty nodeId={nodeId} data={data} reason={state ? 'no-container' : 'checking'} subject='logs' container={container} />
  } else if (watchError && hasLog) {
    header = { indicator: 'destructive', title: 'Could not open the log', detail: watchError, action: { label: 'Retry', onClick: reopen } }
  } else {
    header = logsHeader(container, state, watch, reopen)
  }
  return (
    <OutputTab
      header={header}
      view={hasLog ? (watch?.view ?? null) : null}
      onEnded={(endedView) => {
        setWatch((w) => (w && w.view === endedView ? { ...w, ended: true } : w))
        // A follow that ended is either a container that stopped or a stream that was lost; the
        // daemon says which.
        readState()
      }}
    />
  )
}
