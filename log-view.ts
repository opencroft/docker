// Shared by the server (server/log-streams.ts) and the client (the Deploy and Logs tabs in
// src/nodes/application.tsx).

/** A watchable view of some output. */
export interface LogView {
  /** What the tab's terminal attaches to. It authorises watching the output, and nothing else. */
  sessionKey: string
  /** True while the view follows output that is still being produced; false for a fixed snapshot. */
  live: boolean
}
