import { dispatch, invoke } from '@opencroft/client/actions'
import {
  InputHandle,
  inspectorIntent,
  type NodeContextMenuContext,
  type NodeContextMenuItem,
  NodeFrame,
  OutputHandle,
  useGraphEdges,
  useInspectorIntent,
  useNodeContext,
  useReactFlow,
} from '@opencroft/client/canvas'
import { type DockerContainerSnapshot, useDockerContainers, useDockerSnapshotReceived } from '@opencroft/client/docker'
import { Terminal } from '@opencroft/client/terminal'
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusIndicator,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@opencroft/client/ui'
import { cn } from 'cn'
import {
  AppWindow,
  CircleAlert,
  CircleArrowUp,
  CircleCheck,
  Copy,
  Info,
  LoaderCircle,
  Play,
  Rocket,
  RotateCw,
  ScrollText,
  Square,
  TerminalSquare,
  Unlink,
  X,
} from 'lucide-react'
import { type ChangeEvent, Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { type LifecycleVerb, serviceLifecycle, serviceStatus, serviceSummary } from '../../container-lifecycle'
import { parseNamedVolumes, sameMount, serializeNamedVolumes } from '../../named-volumes'
import { ApplicationEmpty } from './application-empty'
import { type HeaderState, OutputHeader } from './output-header'
import { useSecretsStoreKeys } from './secrets-store-keys'
import { VolumeEntryRow } from './volume-entry'

const COMPOSE_PROJECT = 'opencroft'

export interface AppData {
  name: string
  image: string
  ports: string
  env: string
  command: string
  entrypoint: string
  ipc: string
  shmSize: string
  restart: string
  replicas: number
  containerName: string
  workingDir: string
  terminalUser: string
  terminalShell: string
  buildContext: string
  buildDockerfile: string
  gpu: boolean
  requirementMemory: string
  requirementCpu: string
  init: boolean
  readOnly: boolean
  dependsOn: string
  groupAdd: string
  securityOpts: string
  tmpfs: string
  devices: string
  logDriver: string
  logOpts: string
  healthcheckTest: string
  healthcheckInterval: string
  healthcheckTimeout: string
  healthcheckRetries: number
  healthcheckStartPeriod: string
  proxyDomain: string
  proxyEntrypoint: string
  proxyTls: boolean
  proxyBasicAuth: string
  proxyPort: number
  exposeHostDocker: boolean
  copyDockerBinaries: boolean
  labels: string
  secrets: string
  namedVolumes?: string
}

// The host's snapshot of a container, plus the daemon's `State` word. `docker.ps` returns it and
// the snapshot carries it, but `DockerContainerSnapshot` does not declare it.
interface ContainerInfo extends DockerContainerSnapshot {
  state: string
}

// What the Docker node's output holds: the terminal context it runs on (what `exposeOutput` in
// client.tsx spreads) plus the name of the Docker CLI context.
interface DockerContext {
  type: string
  contextName?: string
  host?: string
  port?: number
  username?: string
  password?: string
  keyPath?: string
  distro?: string
  [key: string]: unknown
}

function instanceVariant(container: ContainerInfo): 'success' | 'warning' | 'destructive' {
  if (container.state === 'restarting' || container.state === 'paused') {
    return 'warning'
  }
  if (!container.running) {
    return 'destructive'
  }
  if (/health:\s*starting/i.test(container.status)) {
    return 'warning'
  }
  if (/\(unhealthy\)/i.test(container.status)) {
    return 'destructive'
  }
  return 'success'
}

function SecretsPicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const availableKeys = useSecretsStoreKeys()

  const selected = useMemo(
    () =>
      value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    [value],
  )

  const remaining = useMemo(() => availableKeys.filter((k) => !selected.includes(k)), [availableKeys, selected])

  const remove = useCallback(
    (name: string) => {
      onChange(selected.filter((s) => s !== name).join('\n'))
    },
    [onChange, selected],
  )

  const add = useCallback(
    (name: string) => {
      if (!name || selected.includes(name)) {
        return
      }
      onChange([...selected, name].join('\n'))
    },
    [onChange, selected],
  )

  const stale = selected.filter((s) => !availableKeys.includes(s))

  return (
    <div className='flex flex-col gap-1.5'>
      {selected.length > 0 ? (
        <div className='flex flex-wrap gap-1'>
          {selected.map((name) => {
            const missing = stale.includes(name)
            return (
              <Badge
                key={name}
                variant={missing ? 'destructive' : 'secondary'}
                className='gap-1 font-mono text-[10px] pr-1'
                title={missing ? 'Not found in any Secrets Store' : ''}
              >
                <span>{name}</span>
                <button type='button' onClick={() => remove(name)} className='hover:opacity-70'>
                  <X className='h-3 w-3' />
                </button>
              </Badge>
            )
          })}
        </div>
      ) : null}
      {remaining.length > 0 ? (
        <Select
          value=''
          onValueChange={(v: string | null) => {
            if (v !== null) {
              add(v)
            }
          }}
        >
          <SelectTrigger className='h-7 text-xs'>
            <SelectValue placeholder='Add secret…' />
          </SelectTrigger>
          <SelectContent>
            {remaining.map((k) => (
              <SelectItem key={k} value={k} className='font-mono text-xs'>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : availableKeys.length === 0 ? (
        <p className='text-[10px] text-muted-foreground italic'>
          No Secrets Stores in this graph. Add a Secrets Store node and define keys to pick from.
        </p>
      ) : (
        <p className='text-[10px] text-muted-foreground italic'>
          All available secrets ({availableKeys.length}) selected.
        </p>
      )}
    </div>
  )
}

function InstanceCard({
  index,
  container,
  workingDir,
  onViewLogs,
  onViewShell,
}: {
  index: number
  container: ContainerInfo
  workingDir?: string
  onViewLogs: () => void
  onViewShell: () => void
}) {
  return (
    <div className='flex items-center gap-1.5 text-[10px]'>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className='flex items-center gap-1.5 cursor-default' />}>
            <StatusIndicator variant={instanceVariant(container)} />
            <span className='text-muted-foreground'>#{index + 1}</span>
          </TooltipTrigger>
          <TooltipContent side='top'>{container.status}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span className='flex-1' />
      <Button variant='ghost' size='sm' className='nodrag nopan h-5 text-[10px] px-1.5' onClick={onViewLogs}>
        <ScrollText className='h-2.5 w-2.5 shrink-0' />
      </Button>
      {container.running ? (
        <OutputHandle type='builtin.core.terminal-context' id={`instance-terminal-${container.name || container.id}`}>
          <Button
            variant='ghost'
            size='sm'
            className='nodrag nopan h-5 text-[10px] px-1.5'
            onClick={onViewShell}
            title={workingDir ? `Terminal (cwd: ${workingDir})` : 'Terminal'}
          >
            <TerminalSquare className='h-2.5 w-2.5 shrink-0' />
            <span>Terminal</span>
          </Button>
        </OutputHandle>
      ) : null}
    </div>
  )
}

export function ApplicationNode({ id, data, selected }: { id: string; data: AppData; selected?: boolean }) {
  const ctx = useNodeContext<DockerContext>(id, 'docker-in')
  const edges = useGraphEdges()
  const rf = useReactFlow()
  const dockerNodeId = ctx?.sourceNodeId
  const serviceName = data.name || id
  const errors = (data as AppData & { __errors?: string[] }).__errors
  const volumeCount = useMemo(
    () => edges.filter((e) => e.target === id && e.targetHandle === 'volumes-in').length,
    [edges, id],
  )
  const containers = useDockerContainers(dockerNodeId, serviceName) as ContainerInfo[]
  const snapshotReceived = useDockerSnapshotReceived(dockerNodeId)
  const { busy, runAction } = useNodeActionRunner(id)
  const loaded = !ctx?.value || snapshotReceived

  const deploy = useCallback(() => runAction('deploy', 'Deploy'), [runAction])
  const start = useCallback(() => runAction('start', 'Start'), [runAction])
  const stop = useCallback(() => runAction('stop', 'Stop'), [runAction])
  const reboot = useCallback(() => runAction('reboot', 'Reboot'), [runAction])

  // The tabs show the instance by the name the inspector was opened on. A name, not an id: it is
  // what the tabs show, and a redeploy recreates the container under the same name with a new id.
  const openInspector = useCallback(
    (tab: string, containerName: string) => {
      rf.setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
      inspectorIntent.open(id, tab, containerName)
    },
    [id, rf],
  )

  const openLogs = useCallback((containerName: string) => openInspector('logs', containerName), [openInspector])
  const openShell = useCallback((containerName: string) => openInspector('terminal', containerName), [openInspector])

  const lifecycle = serviceLifecycle(containers)
  // One header button covers both Start and Stop: it offers Stop whenever Stop applies (a restart
  // loop included) and Start otherwise. Each verb is enabled by the same rule as its context-menu
  // entry.
  const toggle = lifecycle.stop ? 'stop' : 'start'
  const status = busy ? 'warning' : !loaded || !ctx?.value ? 'neutral' : serviceStatus(containers)

  return (
    <div className='flex flex-col gap-1.5'>
      <NodeFrame
        icon={AppWindow}
        title={data.name || 'Application'}
        subtitle={serviceSummary(containers)}
        status={status}
        selected={selected ?? false}
        loading={busy || !loaded}
        errors={errors}
        extra={
          // Start/Stop, Reboot, Deploy — every one-click lifecycle verb the header offers, in
          // increasing order of consequence: act on what is there, restart what is there, then
          // build or rebuild it. Each glyph is the one its action already carries in the context
          // menu, so a verb never shows up as two different icons across the two surfaces.
          // Terminate is deliberately menu-only: a full teardown does not belong on a row of
          // buttons that act on a single click.
          <div className='flex items-center gap-1'>
            <Button
              variant='ghost'
              size='sm'
              className='nodrag nopan h-5 text-[10px] px-1.5'
              title={toggle === 'stop' ? 'Stop' : 'Start'}
              onClick={toggle === 'stop' ? stop : start}
              disabled={busy || !lifecycle[toggle]}
            >
              {toggle === 'stop' ? (
                <Square className='h-2.5 w-2.5 shrink-0' />
              ) : (
                <Play className='h-2.5 w-2.5 shrink-0' />
              )}
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='nodrag nopan h-5 text-[10px] px-1.5'
              title='Reboot'
              onClick={reboot}
              disabled={busy || !lifecycle.reboot}
            >
              <RotateCw className='h-2.5 w-2.5 shrink-0' />
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='nodrag nopan h-5 text-[10px] px-1.5'
              title='Deploy'
              onClick={deploy}
              disabled={busy || !canDeploy(data, Boolean(ctx?.value))}
            >
              <Rocket className='h-2.5 w-2.5 shrink-0' />
            </Button>
          </div>
        }
      >
        <div className='flex gap-3'>
          <div className='flex flex-col gap-1.5 shrink-0'>
            <InputHandle type='docker-context' id='docker-in'>
              <span className='text-[10px] text-muted-foreground'>Docker</span>
            </InputHandle>
            <InputHandle type='volume-mount' id='volumes-in'>
              <span className='text-[10px] text-muted-foreground'>
                Volumes{volumeCount > 0 ? ` (${volumeCount})` : ''}
              </span>
            </InputHandle>
          </div>
          {containers.length > 0 ? (
            <div className='flex flex-col gap-1 flex-1 min-w-0'>
              {containers.map((c: ContainerInfo, i: number) => (
                <InstanceCard
                  key={c.id}
                  index={i}
                  container={c}
                  workingDir={data.workingDir}
                  onViewLogs={() => openLogs(c.name)}
                  onViewShell={() => openShell(c.name)}
                />
              ))}
            </div>
          ) : null}
        </div>
      </NodeFrame>
    </div>
  )
}

// Backs the context menu's state-aware isEnabled: same cached `docker.ps` lookup (10s TTL,
// invalidated by every lifecycle action) the node's own status badge reads, so this stays cheap.
// A query failure (transport hiccup, cache miss racing an invalidation, etc.) degrades to
// "enabled" rather than hiding the item — the dispatched action re-resolves the docker context
// itself and surfaces the real error if there's actually nothing to do.
async function serviceAllows(
  dockerNodeId: string,
  service: string,
  verb: LifecycleVerb | 'terminate',
): Promise<boolean> {
  try {
    const containers = await invoke<ContainerInfo[]>('docker.ps', { dockerNodeId, service })
    return verb === 'terminate' ? containers.length > 0 : serviceLifecycle(containers)[verb]
  } catch {
    return true
  }
}

/**
 * What stops this Application from deploying: no Docker node wired, or nothing to run (no image
 * and no build context). One rule for every surface that offers Deploy; each passes `wired` from
 * the wiring it can read.
 */
export function deployBlocker(data: AppData, wired: boolean): 'no-docker' | 'no-source' | null {
  if (!wired) {
    return 'no-docker'
  }
  return data.image?.trim() || data.buildContext?.trim() ? null : 'no-source'
}

export function canDeploy(data: AppData, wired: boolean): boolean {
  return deployBlocker(data, wired) === null
}

/** Dispatches one of this node's actions, reporting a failure as a toast, and says while it runs. */
export function useNodeActionRunner(nodeId: string): {
  busy: boolean
  runAction: (actionId: string, label: string) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const runAction = useCallback(
    async (actionId: string, label: string) => {
      setBusy(true)
      try {
        await dispatch(nodeId, actionId)
      } catch (err) {
        toast.error(`${label} failed: ${String(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [nodeId],
  )
  return { busy, runAction }
}

// The Docker node wired into `docker-in` as the open canvas has it, the same wiring useDockerNodeId reads.
function wiredDockerNodeId({ contexts }: NodeContextMenuContext<AppData>): string | undefined {
  return contexts['docker-in']?.sourceNodeId
}

// Start, Stop and Reboot are enabled by the same rule as the node's header buttons; Terminate
// while the service has any container, in whatever state.
function enabledFor(verb: LifecycleVerb | 'terminate') {
  return (ctx: NodeContextMenuContext<AppData>): boolean | Promise<boolean> => {
    const dockerNodeId = wiredDockerNodeId(ctx)
    return dockerNodeId ? serviceAllows(dockerNodeId, ctx.data.name || ctx.nodeId, verb) : false
  }
}

async function runVerb(nodeId: string, verb: string): Promise<void> {
  await dispatch(nodeId, verb)
}

// Five distinct lifecycle verbs: Start/Reboot/Stop act on the service's existing containers in
// place; Deploy/Terminate are the create/destroy ends. Menu item id = dispatched action id = menu
// label's verb, kept in sync on purpose so an agent-facing `list_actions`/`call` on this node type
// sees the exact same vocabulary this menu shows.
export const applicationContextMenuItems: NodeContextMenuItem<AppData>[] = [
  {
    id: 'start',
    label: 'Start',
    icon: 'Play',
    isEnabled: enabledFor('start'),
    onSelect: ({ nodeId }) => runVerb(nodeId, 'start'),
  },
  {
    id: 'reboot',
    label: 'Reboot',
    icon: 'RotateCw',
    isEnabled: enabledFor('reboot'),
    onSelect: ({ nodeId }) => runVerb(nodeId, 'reboot'),
  },
  {
    id: 'stop',
    label: 'Stop',
    icon: 'Square',
    isEnabled: enabledFor('stop'),
    onSelect: ({ nodeId }) => runVerb(nodeId, 'stop'),
  },
  {
    id: 'deploy',
    label: 'Deploy',
    icon: 'Rocket',
    isEnabled: (ctx) => canDeploy(ctx.data, Boolean(wiredDockerNodeId(ctx))),
    onSelect: ({ nodeId }) => runVerb(nodeId, 'deploy'),
  },
  {
    id: 'terminate',
    label: 'Terminate',
    icon: 'Trash2',
    destructive: true,
    isEnabled: enabledFor('terminate'),
    onSelect: ({ nodeId }) => runVerb(nodeId, 'terminate'),
  },
]

interface ImageUpdateResult {
  localDigest?: string
  remoteDigest?: string
  hasUpdate: boolean
}

type ImageUpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'update-available' }
  | { kind: 'no-local' }
  | { kind: 'unknown' }
  | { kind: 'error'; message: string }

function ImageUpdateChecker({ nodeId, dockerNodeId, image }: { nodeId: string; dockerNodeId?: string; image: string }) {
  const [state, setState] = useState<ImageUpdateState>({ kind: 'idle' })
  const [updating, setUpdating] = useState(false)

  const check = useCallback(async () => {
    if (!dockerNodeId || !image.trim()) {
      setState({ kind: 'idle' })
      return
    }
    setState({ kind: 'checking' })
    try {
      const res = await invoke<ImageUpdateResult>('docker.checkImageUpdate', { dockerNodeId, image })
      if (res.hasUpdate) {
        setState({ kind: 'update-available' })
        return
      }
      if (!res.remoteDigest) {
        setState({ kind: 'unknown' })
        return
      }
      if (!res.localDigest) {
        setState({ kind: 'no-local' })
        return
      }
      setState({ kind: 'up-to-date' })
    } catch (err) {
      setState({ kind: 'error', message: String(err) })
    }
  }, [dockerNodeId, image])

  useEffect(() => {
    check()
  }, [check])

  const update = useCallback(async () => {
    if (!dockerNodeId || !image.trim()) {
      return
    }
    setUpdating(true)
    try {
      await invoke<void>('docker.pullImage', { dockerNodeId, reference: image })
      await dispatch(nodeId, 'deploy')
      toast.success('Image updated and service restarted')
      await check()
    } catch (err) {
      toast.error(`Update failed: ${String(err)}`)
    } finally {
      setUpdating(false)
    }
  }, [dockerNodeId, image, nodeId, check])

  if (state.kind === 'idle') {
    return null
  }

  const message = (() => {
    if (state.kind === 'checking') {
      return 'Checking for image updates…'
    }
    if (state.kind === 'up-to-date') {
      return 'Image up to date'
    }
    if (state.kind === 'update-available') {
      return 'New image version available'
    }
    if (state.kind === 'no-local') {
      return 'Image not pulled locally'
    }
    if (state.kind === 'unknown') {
      return 'Could not check remote image'
    }
    return `Check failed: ${state.message}`
  })()

  const Icon = (() => {
    if (state.kind === 'checking') {
      return LoaderCircle
    }
    if (state.kind === 'up-to-date') {
      return CircleCheck
    }
    if (state.kind === 'update-available') {
      return CircleArrowUp
    }
    if (state.kind === 'error') {
      return CircleAlert
    }
    return Info
  })()

  const tone =
    state.kind === 'update-available'
      ? 'text-primary'
      : state.kind === 'error'
        ? 'text-destructive'
        : 'text-muted-foreground'

  return (
    <div className='flex items-center gap-1.5 text-[10px]'>
      <Icon className={cn('h-3 w-3 shrink-0', tone, state.kind === 'checking' && 'animate-spin')} />
      <span className={cn('flex-1 truncate', tone)} title={message}>
        {message}
      </span>
      {state.kind === 'update-available' ? (
        <Button variant='outline' size='sm' className='h-6 text-[10px] px-2' onClick={update} disabled={updating}>
          {updating ? 'Updating…' : 'Pull & restart'}
        </Button>
      ) : (
        <Button
          variant='ghost'
          size='sm'
          className='h-6 text-[10px] px-2'
          onClick={check}
          disabled={state.kind === 'checking'}
        >
          Recheck
        </Button>
      )}
    </div>
  )
}

export function ApplicationInspector({
  nodeId,
  data,
  updateData,
}: {
  nodeId: string
  data: AppData
  updateData: (p: Partial<AppData>) => void
}) {
  const dockerNodeId = useDockerNodeId(nodeId)

  const portUrls = useMemo(() => {
    const urls: { label: string; url: string; category: 'public' | 'local' | 'container' }[] = []
    const serviceName = data.name || nodeId

    // Public URL from proxy config
    if (data.proxyDomain?.trim()) {
      const scheme = data.proxyTls ? 'https' : 'http'
      urls.push({
        label: data.proxyDomain,
        url: `${scheme}://${data.proxyDomain}`,
        category: 'public',
      })
    }

    // Local URLs from port mappings
    if (data.ports?.trim()) {
      for (const line of data.ports
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)) {
        const parts = line.split(':')
        const hostPort = parts.length >= 2 ? parts[0].trim() : parts[0].trim()
        const containerPort = parts.length >= 2 ? parts[1].trim() : parts[0].trim()
        urls.push({
          label: `localhost:${hostPort}`,
          url: `http://localhost:${hostPort}`,
          category: 'local',
        })
        urls.push({
          label: `${serviceName}:${containerPort}`,
          url: `http://${serviceName}:${containerPort}`,
          category: 'container',
        })
      }
    }

    // Container URL from service port (if not already covered by port mappings)
    if (
      data.proxyPort &&
      !data.ports
        ?.trim()
        .split('\n')
        .some((l) => {
          const parts = l.trim().split(':')
          return (parts.length >= 2 ? parts[1].trim() : parts[0].trim()) === String(data.proxyPort)
        })
    ) {
      urls.push({
        label: `${serviceName}:${data.proxyPort}`,
        url: `http://${serviceName}:${data.proxyPort}`,
        category: 'container',
      })
    }

    // Sort: public first, then local, then container
    const order = { public: 0, local: 1, container: 2 }
    urls.sort((a, b) => order[a.category] - order[b.category])

    return urls
  }, [data.ports, data.proxyDomain, data.proxyTls, data.proxyPort, data.name, nodeId])

  const copyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url)
    toast.success('URL copied')
  }, [])

  return (
    <div className='flex flex-col gap-3'>
      {portUrls.length > 0 ? (
        <div className='flex flex-col gap-1'>
          <Label>URLs</Label>
          <div className='grid grid-cols-[1fr_auto_auto] gap-x-1 gap-y-0.5 items-center'>
            {portUrls.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a derived, display-only list in which two port lines can give the same URL
              <Fragment key={i}>
                <a
                  href={item.url}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='truncate text-primary hover:underline font-mono text-[11px]'
                >
                  {item.url}
                </a>
                <Badge
                  variant={item.category === 'public' ? 'default' : 'secondary'}
                  className='text-[9px] px-1.5 py-0 h-4 w-full text-center cursor-default'
                  onClick={() => copyUrl(item.url)}
                >
                  {item.category}
                </Badge>
                <Button variant='ghost' size='sm' className='h-5 w-5 p-0' onClick={() => copyUrl(item.url)}>
                  <Copy className='h-3 w-3' />
                </Button>
              </Fragment>
            ))}
          </div>
        </div>
      ) : null}
      <div className='flex flex-col gap-1'>
        <Label>Service Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='my-app'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Image</Label>
        <Input
          value={data.image ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ image: e.target.value })}
          placeholder='nginx:latest'
        />
        <ImageUpdateChecker nodeId={nodeId} dockerNodeId={dockerNodeId} image={data.image ?? ''} />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Ports (one per line, host:container)</Label>
        <Textarea
          value={data.ports ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ ports: e.target.value })}
          placeholder={'8080:80\n3000:3000'}
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Environment (one per line, KEY=VALUE)</Label>
        <Textarea
          value={data.env ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ env: e.target.value })}
          placeholder={'NODE_ENV=production\nDEBUG=false'}
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Secrets</Label>
        <SecretsPicker value={data.secrets ?? ''} onChange={(next: string) => updateData({ secrets: next })} />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Command (optional)</Label>
        <Textarea
          value={data.command ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ command: e.target.value })}
          placeholder='npm start'
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Entrypoint (optional, overrides image default)</Label>
        <Input
          value={data.entrypoint ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ entrypoint: e.target.value })}
          placeholder='sh -c'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>IPC mode (optional)</Label>
        <Input
          value={data.ipc ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ ipc: e.target.value })}
          placeholder='host'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>shm_size (optional)</Label>
        <Input
          value={data.shmSize ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ shmSize: e.target.value })}
          placeholder='8gb'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Replicas</Label>
        <Input
          type='number'
          value={data.replicas ?? 1}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ replicas: Number(e.target.value) || 1 })}
          placeholder='1'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Restart Policy</Label>
        <Input
          value={data.restart ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ restart: e.target.value })}
          placeholder='unless-stopped'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Container Name (optional)</Label>
        <Input
          value={data.containerName ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ containerName: e.target.value })}
          placeholder='explicit-container-name'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Working Directory (optional)</Label>
        <Input
          value={data.workingDir ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ workingDir: e.target.value })}
          placeholder='/app'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Terminal user (optional)</Label>
        <Input
          value={data.terminalUser ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ terminalUser: e.target.value })}
          placeholder='container default'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Terminal shell (optional)</Label>
        <Input
          value={data.terminalShell ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ terminalShell: e.target.value })}
          placeholder='auto (bash → sh)'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Depends On (comma-separated)</Label>
        <Input
          value={data.dependsOn ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ dependsOn: e.target.value })}
          placeholder='db, redis'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Build (alternative to Image)</Label>
      <div className='flex flex-col gap-1'>
        <Label>Build Context</Label>
        <Input
          value={data.buildContext ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ buildContext: e.target.value })}
          placeholder='./path/to/source'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Dockerfile</Label>
        <Input
          value={data.buildDockerfile ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ buildDockerfile: e.target.value })}
          placeholder='Dockerfile'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Requirements</Label>
      <div className='flex flex-col gap-1'>
        <Label>Memory limit</Label>
        <Input
          value={data.requirementMemory ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ requirementMemory: e.target.value })}
          placeholder='512m, 2g'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>vCPU limit</Label>
        <Input
          value={data.requirementCpu ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ requirementCpu: e.target.value })}
          placeholder='0.5, 2'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Runtime</Label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.gpu ?? false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ gpu: e.target.checked })}
        />
        NVIDIA GPU
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.init ?? false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ init: e.target.checked })}
        />
        Init (PID 1 reaping)
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.readOnly ?? false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ readOnly: e.target.checked })}
        />
        Read-only filesystem
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.exposeHostDocker ?? false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ exposeHostDocker: e.target.checked })}
        />
        Expose host docker
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.copyDockerBinaries ?? false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ copyDockerBinaries: e.target.checked })}
        />
        Copy docker binaries
      </label>
      <div className='flex flex-col gap-1'>
        <Label>group_add (comma-separated)</Label>
        <Input
          value={data.groupAdd ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ groupAdd: e.target.value })}
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>security_opt (one per line)</Label>
        <Textarea
          value={data.securityOpts ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ securityOpts: e.target.value })}
          placeholder='no-new-privileges:true'
          className='font-mono text-xs min-h-[40px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>tmpfs (one per line)</Label>
        <Textarea
          value={data.tmpfs ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ tmpfs: e.target.value })}
          placeholder={'/tmp\n/var/run/postgresql'}
          className='font-mono text-xs min-h-[40px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>devices (one per line, host:container)</Label>
        <Textarea
          value={data.devices ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ devices: e.target.value })}
          placeholder={'/dev/kvm\n/dev/dri:/dev/dri'}
          className='font-mono text-xs min-h-[40px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Log driver (optional, e.g. json-file)</Label>
        <Input
          value={data.logDriver ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ logDriver: e.target.value })}
          placeholder='json-file'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Log options (one per line, KEY=VALUE)</Label>
        <Textarea
          value={data.logOpts ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ logOpts: e.target.value })}
          placeholder={'max-size=50m\nmax-file=7'}
          className='font-mono text-xs min-h-[40px]'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Healthcheck</Label>
      <div className='flex flex-col gap-1'>
        <Label>Test Command</Label>
        <Input
          value={data.healthcheckTest ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ healthcheckTest: e.target.value })}
          placeholder='curl -f http://localhost/health'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Interval</Label>
        <Input
          value={data.healthcheckInterval ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ healthcheckInterval: e.target.value })}
          placeholder='30s'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Timeout</Label>
        <Input
          value={data.healthcheckTimeout ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ healthcheckTimeout: e.target.value })}
          placeholder='5s'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Retries</Label>
        <Input
          type='number'
          value={data.healthcheckRetries ?? 0}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            updateData({ healthcheckRetries: Number(e.target.value) || 0 })
          }
          placeholder='3'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Start Period</Label>
        <Input
          value={data.healthcheckStartPeriod ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ healthcheckStartPeriod: e.target.value })}
          placeholder='20s'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Traefik Proxy</Label>
      <div className='flex flex-col gap-1'>
        <Label>Domain</Label>
        <Input
          value={data.proxyDomain ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ proxyDomain: e.target.value })}
          placeholder='app.example.com'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Entrypoint</Label>
        <Input
          value={data.proxyEntrypoint ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ proxyEntrypoint: e.target.value })}
          placeholder='websecure'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Service Port</Label>
        <Input
          type='number'
          value={data.proxyPort ?? 0}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ proxyPort: Number(e.target.value) || 0 })}
          placeholder='80'
        />
      </div>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.proxyTls ?? false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ proxyTls: e.target.checked })}
        />
        TLS (letsencrypt)
      </label>
      <div className='flex flex-col gap-1'>
        <Label>Basic Auth (user:hash)</Label>
        <Input
          value={data.proxyBasicAuth ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ proxyBasicAuth: e.target.value })}
          placeholder='admin:$apr1$...'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Labels</Label>
      <div className='flex flex-col gap-1'>
        <Label>Custom labels (one per line, KEY=VALUE)</Label>
        <Textarea
          value={data.labels ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ labels: e.target.value })}
          placeholder={'traefik.http.routers.foo.service=api@internal\ncom.example.role=worker'}
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
    </div>
  )
}

/**
 * The Docker node wired into `docker-in`, read from the canvas edges. The page's copy of a node's
 * `__resolvedContexts` is written by the server on save and can lag wiring done in this page, so
 * anything rendered reads the wiring through this instead.
 */
export function useDockerNodeId(nodeId: string): string | undefined {
  return useNodeContext<DockerContext>(nodeId, 'docker-in')?.sourceNodeId
}

function useDockerConnection(nodeId: string) {
  const ctx = useNodeContext<DockerContext>(nodeId, 'docker-in')
  if (!ctx?.value) return null
  const ctxValue = ctx.value
  return { ctxValue, ctxName: ctxValue.contextName }
}

function resolveContainerName(data: AppData, nodeId: string): string {
  const explicit = data.containerName?.trim()
  if (explicit) {
    return explicit
  }
  const service = data.name || nodeId
  return `${COMPOSE_PROJECT}-${service}-1`
}

function dockerArgs(ctxName: string | undefined, ...rest: string[]): string[] {
  return [...(ctxName ? ['--context', ctxName] : []), ...rest]
}

function buildDockerConnection(ctxValue: DockerContext, args: string[]) {
  if (ctxValue.type === 'ssh') {
    return {
      type: 'ssh' as const,
      config: {
        host: ctxValue.host ?? '',
        port: ctxValue.port,
        username: ctxValue.username ?? '',
        password: ctxValue.password,
        keyPath: ctxValue.keyPath,
        command: ['docker', ...args].join(' '),
      },
    }
  }
  if (ctxValue.type === 'wsl') {
    return {
      type: 'wsl' as const,
      config: { distro: ctxValue.distro, command: 'docker', args },
    }
  }
  return {
    type: 'local' as const,
    config: { command: 'docker', args },
  }
}

/** The instance every inspector tab shows: the one the inspector was opened on, else the default. */
export function useInspectedContainer(nodeId: string, data: AppData): string {
  const intent = useInspectorIntent(nodeId)
  return intent.instanceId ?? resolveContainerName(data, nodeId)
}

type ShellStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

// The same header the Deploy and Logs tabs have: the container's state and name, and while it runs,
// the shell's connection.
function shellHeader(container: ContainerInfo, shell: ShellStatus): HeaderState {
  if (!container.running) {
    return { indicator: 'secondary', title: 'Stopped', detail: `${container.name} · ${container.status}` }
  }
  if (shell === 'connected') {
    return { indicator: 'success', title: 'Connected', detail: container.name }
  }
  if (shell === 'connecting') {
    return { indicator: 'warning', title: 'Connecting…', detail: container.name }
  }
  return { indicator: 'destructive', title: 'Disconnected', detail: container.name }
}

/**
 * The shell is keyed by node and container id, and every browser tab has a shell of its own under
 * that key. A reload of the tab re-attaches to it and another inspector tab leaves it running;
 * closing the inspector ends it, and a redeployed container, which gets a new id, opens a fresh
 * one. The inspected instance is named rather than identified, so it is resolved against the
 * Docker node's container list before any shell is opened.
 */
export function ApplicationTerminalTab({
  nodeId,
  data,
}: {
  nodeId: string
  data: AppData
  updateData: (p: Partial<AppData>) => void
}) {
  const dockerConn = useDockerConnection(nodeId)
  const dockerNodeId = useDockerNodeId(nodeId)
  const inspected = useInspectedContainer(nodeId, data)
  const containers = useDockerContainers(dockerNodeId, data.name || nodeId) as ContainerInfo[]
  const snapshotReceived = useDockerSnapshotReceived(dockerNodeId)
  const [shell, setShell] = useState<ShellStatus>('connecting')
  if (!dockerConn) {
    return <ApplicationEmpty nodeId={nodeId} data={data} reason='no-docker' subject='shell' />
  }
  const container = containers.find((c) => c.id === inspected || c.name === inspected)
  if (!container) {
    return (
      <ApplicationEmpty
        nodeId={nodeId}
        data={data}
        reason={snapshotReceived ? 'no-container' : 'checking'}
        subject='shell'
        container={inspected}
      />
    )
  }
  const connection = buildDockerConnection(
    dockerConn.ctxValue,
    dockerArgs(dockerConn.ctxName, 'exec', '-it', container.id, 'bash'),
  )
  const sessionKey = `${nodeId}:${container.id}`
  return (
    <div className='flex flex-col h-full'>
      <OutputHeader {...shellHeader(container, shell)} />
      <div className='flex-1 min-h-0'>
        <Terminal key={sessionKey} sessionKey={sessionKey} connection={connection} onStatusChange={setShell} />
      </div>
    </div>
  )
}

interface VolumeListItem {
  name: string
  created: string
}

export function ApplicationVolumesTab({
  nodeId,
  data,
  updateData,
}: {
  nodeId: string
  data: AppData
  updateData: (p: Partial<AppData>) => void
}) {
  const dockerNodeId = useDockerNodeId(nodeId)
  const [pool, setPool] = useState<VolumeListItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [pickVolume, setPickVolume] = useState('')
  const [pickPath, setPickPath] = useState('')
  const [pickSubpath, setPickSubpath] = useState('')
  const [pickReadOnly, setPickReadOnly] = useState(false)
  const [pickDirectMount, setPickDirectMount] = useState(false)

  const attached = useMemo(() => parseNamedVolumes(data.namedVolumes ?? ''), [data.namedVolumes])

  const refresh = useCallback(async () => {
    if (!dockerNodeId) {
      setPool([])
      return
    }
    setLoading(true)
    try {
      setPool(await invoke<VolumeListItem[]>('docker.listVolumes', { dockerNodeId }))
    } catch {
      setPool([])
    } finally {
      setLoading(false)
    }
  }, [dockerNodeId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const poolByName = useMemo(() => new Map((pool ?? []).map((v) => [v.name, v])), [pool])
  // A volume can be mounted at more than one container path (e.g. two different subpaths of it),
  // so being attached once doesn't exclude it from the picker — it stays selectable for another path.

  const detach = useCallback(
    (volumeName: string, containerPath: string) => {
      updateData({
        namedVolumes: serializeNamedVolumes(attached.filter((a) => !sameMount(a, volumeName, containerPath))),
      })
    },
    [attached, updateData],
  )

  const attach = useCallback(() => {
    const path = pickPath.trim()
    if (!pickVolume || !path) {
      return
    }
    const subpath = pickSubpath.trim() || undefined
    // Replace an existing entry only if it's the exact same (volume, path) pair — otherwise this
    // is a second mount of the same volume at a different path, which must be added, not replace it.
    const next = [
      ...attached.filter((a) => !sameMount(a, pickVolume, path)),
      { volumeName: pickVolume, containerPath: path, readOnly: pickReadOnly, subpath, directMount: pickDirectMount },
    ]
    updateData({ namedVolumes: serializeNamedVolumes(next) })
    setPickVolume('')
    setPickPath('')
    setPickSubpath('')
    setPickReadOnly(false)
    setPickDirectMount(false)
  }, [attached, pickDirectMount, pickPath, pickReadOnly, pickSubpath, pickVolume, updateData])

  if (!dockerNodeId) {
    return <div className='p-3 text-xs text-muted-foreground italic'>Connect a Docker node to manage volumes.</div>
  }

  return (
    <div className='flex flex-col h-full'>
      <div className='flex flex-col gap-1.5 px-2 py-1.5 border-b'>
        <div className='flex items-center gap-1.5'>
          <Select
            value={pickVolume}
            onValueChange={(v: string | null) => {
              if (v !== null) {
                setPickVolume(v)
              }
            }}
          >
            <SelectTrigger className='h-7 text-xs flex-1'>
              <SelectValue placeholder={(pool ?? []).length === 0 ? 'no volumes available' : 'pick a volume…'} />
            </SelectTrigger>
            <SelectContent>
              {(pool ?? []).map((v) => (
                <SelectItem key={v.name} value={v.name} className='font-mono text-xs'>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant='ghost' size='sm' className='h-7 text-[10px] px-1.5' onClick={refresh} disabled={loading}>
            <RotateCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          </Button>
        </div>
        <Input
          value={pickSubpath}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setPickSubpath(e.target.value)}
          placeholder='subpath (optional)'
          className='h-7 text-xs w-full font-mono'
        />
        <Input
          value={pickPath}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setPickPath(e.target.value)}
          placeholder='/container/path'
          className='h-7 text-xs w-full font-mono'
        />
        <div className='flex items-center justify-between gap-1.5'>
          <div className='flex items-center gap-2'>
            <label className='flex items-center gap-1 text-xs shrink-0' title='Mount read-only'>
              <input
                type='checkbox'
                checked={pickReadOnly}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setPickReadOnly(e.target.checked)}
              />
              readonly
            </label>
            <label
              className='flex items-center gap-1 text-xs shrink-0'
              title='Bind-mount the resolved host path directly instead of using volume.subpath — needed to mount an individual file, works on any Docker version, only supports the default "local" volume driver.'
            >
              <input
                type='checkbox'
                checked={pickDirectMount}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setPickDirectMount(e.target.checked)}
              />
              direct mount
            </label>
          </div>
          <Button
            variant='outline'
            size='sm'
            className='h-7 text-xs'
            onClick={attach}
            disabled={!pickVolume || !pickPath.trim()}
          >
            Attach
          </Button>
        </div>
      </div>
      <div className='flex-1 overflow-auto'>
        {attached.length === 0 ? (
          <div className='p-3 text-xs text-muted-foreground italic'>No volumes attached.</div>
        ) : (
          <div className='flex flex-col divide-y'>
            {attached.map((a) => {
              const info = poolByName.get(a.volumeName)
              const subpathDisplay = a.subpath ? `/${a.subpath}` : '/'
              return (
                <VolumeEntryRow
                  key={`${a.volumeName}:${a.containerPath}`}
                  name={a.volumeName}
                  created={info?.created ?? ''}
                  subtitle={`${subpathDisplay} → ${a.containerPath}${a.readOnly ? ' (readonly)' : ''}${a.directMount ? ' (direct)' : ''}`}
                  action={{ icon: Unlink, label: 'Detach', onClick: () => detach(a.volumeName, a.containerPath) }}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
