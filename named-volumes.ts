// Shared by extension.ts (server-side node actions), server/docker.ts (compose doc generation),
// and src/nodes/application.tsx (client UI) so the line format used for AppData.namedVolumes has
// one definition: "volumeName:containerPath[:ro][:direct][:subpath=<path>]". The optional segments
// after the required name/path pair are order-independent and matched by pattern, not position.

export interface AttachedVolume {
  volumeName: string
  containerPath: string
  readOnly: boolean
  subpath?: string
  // Bind-mount the resolved host path under the daemon's data root instead of using compose's
  // volume.subpath mount option. Needed to mount individual files (volume.subpath only handles
  // directories) and works on any Docker version, at the cost of only supporting the default
  // "local" volume driver. Opt-in, defaults to false — see server/docker.ts's namedVolumeMountEntry.
  directMount?: boolean
}

const SUBPATH_PREFIX = 'subpath='
const DIRECT_MARKER = 'direct'

// Docker's volume.subpath mount option rejects an absolute path ("must be relative") — strip any
// leading slashes so both "/sub/dir" and "sub/dir" behave the same wherever a subpath is entered
// (the UI input, or the attachVolume action's param), instead of surfacing a compose error.
export function normalizeSubpath(subpath: string): string {
  return subpath.replace(/^\/+/, '')
}

export function parseNamedVolumes(raw: string): AttachedVolume[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [volumeName, containerPath, ...rest] = line.split(':')
      let readOnly = false
      let directMount = false
      let subpath: string | undefined
      for (const segment of rest) {
        if (segment === 'ro') {
          readOnly = true
        } else if (segment === DIRECT_MARKER) {
          directMount = true
        } else if (segment.startsWith(SUBPATH_PREFIX)) {
          subpath = normalizeSubpath(segment.slice(SUBPATH_PREFIX.length)) || undefined
        }
      }
      return { volumeName: volumeName ?? '', containerPath: containerPath ?? '', readOnly, subpath, directMount }
    })
    .filter((v) => v.volumeName && v.containerPath)
}

// The same volume can legitimately be mounted at more than one container path (e.g. two different
// subpaths of it). What makes an entry unique is the (volumeName, containerPath) pair, not the
// volume name alone — every place that adds, removes, or keys off an entry must compare both.
export function sameMount(a: AttachedVolume, volumeName: string, containerPath: string): boolean {
  return a.volumeName === volumeName && a.containerPath === containerPath
}

export function serializeNamedVolumes(entries: AttachedVolume[]): string {
  return entries
    .map((e) => {
      let line = `${e.volumeName}:${e.containerPath}`
      if (e.readOnly) {
        line += ':ro'
      }
      if (e.directMount) {
        line += `:${DIRECT_MARKER}`
      }
      const subpath = e.subpath ? normalizeSubpath(e.subpath) : ''
      if (subpath) {
        line += `:${SUBPATH_PREFIX}${subpath}`
      }
      return line
    })
    .join('\n')
}
