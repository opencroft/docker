// Shared between server (capture/storage) and client (Deploy tab rendering) — see
// server/docker.ts (recordDeployLog/getDeployLog) and src/nodes/application.tsx.

export type DeployAction = 'start' | 'restart'

// A deploy that is still running is a first-class state, not a missing entry: `dockerUp` detaches
// the compose invocation on the target host, so a build can go on long after the action that
// started it has returned.
// An entry stored without `status` reads as 'finished'.
export type DeployStatus = 'running' | 'finished'

export interface DeployLogEntry {
  action: DeployAction
  at: string
  text: string
  truncated?: boolean
  status?: DeployStatus
  // Exit code of the compose invocation. Only set once it has finished.
  exitCode?: number
}
