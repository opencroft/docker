// Who holds a tab's log view. Kept free of host imports so the tab-switching test can run it.
//
// A view is a job the server started for one tab, and it holds a job slot until it is closed.
// Closing it is up to the tab, since only the tab knows when it is done with it. That happens in
// three ways: the view is replaced by a newer one, the tab is left, or the view arrives after
// the tab stopped wanting it (left while the open was still in flight, or superseded by a newer
// open). All three go through here, so no view is left open for the server to time out.

export interface ViewSlot {
  /** An open is starting. Any open still in flight is stale from now on. */
  begin(): number
  /**
   * The open `ticket` returned the view `key`. Returns true when the slot keeps it: it is the latest
   * open and the slot has not been released since. The view held before is closed. Returns false
   * when the view is no longer wanted, and closes it at once.
   */
  hold(ticket: number, key: string): boolean
  /** Whether `ticket` is still the latest open, so that its outcome, a failure included, is wanted. */
  isLatest(ticket: number): boolean
  /** The tab is done: close the view held and make every open in flight stale. */
  release(): void
}

export function createViewSlot(close: (key: string) => void): ViewSlot {
  let latest = 0
  let held: string | null = null
  return {
    begin() {
      latest += 1
      return latest
    },
    hold(ticket, key) {
      if (ticket !== latest) {
        close(key)
        return false
      }
      if (held !== null && held !== key) {
        close(held)
      }
      held = key
      return true
    },
    isLatest(ticket) {
      return ticket === latest
    },
    release() {
      latest += 1
      if (held !== null) {
        close(held)
        held = null
      }
    },
  }
}
