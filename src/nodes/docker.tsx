import {
  InputHandle,
  icons,
  invoke,
  NodeFrame,
  OutputHandle,
  React,
  toast,
  useNodeContext,
} from '@ext/host'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusIndicator,
} from '@ext/ui'
import { cn } from 'cn'

import { verbApplies } from '../../container-lifecycle'
import { useSecretsStoreKeys } from './secrets-store-keys'
import { VolumeEntryRow } from './volume-entry'

const { useCallback, useEffect, useState } = React

export interface DockerRegistry {
  host: string
  usernameSecret: string
  passwordSecret: string
}

export interface DockerData {
  contextName: string
  registries?: DockerRegistry[]
}

interface TerminalContext {
  type: string
  host?: string
  [key: string]: unknown
}

interface ContainerListItem {
  id: string
  name: string
  image: string
  status: string
  state: string
  created: string
  ports: string
  running: boolean
}

interface ImageListItem {
  id: string
  repository: string
  tag: string
  size: string
  created: string
}

interface InventoryGroup {
  image: ImageListItem | null
  reference: string
  containers: ContainerListItem[]
}

interface DockerProbeResult {
  ok: boolean
  version?: string
  reason?: string
  message?: string
}

export function DockerNode({ id, data, selected }: { id: string; data: DockerData; selected?: boolean }) {
  const ctx = useNodeContext<TerminalContext>(id, 'ctx-in')
  const target = useNodeContext<TerminalContext>(id, 'context-in')
  const host = ctx?.value?.type ?? 'none'
  const [probe, setProbe] = useState<DockerProbeResult | null>(null)

  useEffect(() => {
    if (!ctx?.value) {
      setProbe(null)
      return
    }
    setProbe(null)
    invoke<DockerProbeResult>('docker.probe', { dockerNodeId: id })
      .then(setProbe)
      .catch((err) => setProbe({ ok: false, reason: 'unknown', message: String(err) }))
  }, [id, ctx?.value, target?.value, data.contextName])

  const status = probe === null ? 'neutral' : probe.ok ? 'success' : 'error'
  const subtitle =
    probe === null
      ? host === 'none'
        ? 'no host'
        : 'checking…'
      : probe.ok
        ? target?.value?.host || data.contextName || host
        : (probe.reason ?? 'error')

  return (
    <NodeFrame
      icon={icons.Container}
      title='Docker'
      subtitle={subtitle}
      status={status}
      selected={selected ?? false}
      input={<InputHandle type='builtin.core.terminal-context' id='ctx-in' />}
      output={<OutputHandle type='docker-context' id='docker-out' />}
    >
      <div className='flex flex-col gap-1.5'>
        <InputHandle type='builtin.core.terminal-context' id='context-in'>
          <span className='text-[10px] text-muted-foreground'>Context</span>
        </InputHandle>
        {probe && !probe.ok && probe.message ? (
          <div className='text-[10px] leading-snug text-destructive'>{probe.message}</div>
        ) : null}
        {probe?.ok && probe.version ? (
          <div className='text-[10px] text-muted-foreground'>docker {probe.version}</div>
        ) : null}
      </div>
    </NodeFrame>
  )
}

function RegistriesEditor({
  value,
  onChange,
}: {
  value: DockerRegistry[]
  onChange: (next: DockerRegistry[]) => void
}) {
  const availableSecrets = useSecretsStoreKeys()

  const update = useCallback(
    (index: number, patch: Partial<DockerRegistry>) => {
      onChange(value.map((r, i) => (i === index ? { ...r, ...patch } : r)))
    },
    [value, onChange],
  )

  const remove = useCallback(
    (index: number) => {
      onChange(value.filter((_, i) => i !== index))
    },
    [value, onChange],
  )

  const add = useCallback(() => {
    onChange([...value, { host: '', usernameSecret: '', passwordSecret: '' }])
  }, [value, onChange])

  const renderSecretSelect = (current: string, onPick: (next: string) => void, placeholder: string) => {
    const stale = current && !availableSecrets.includes(current)
    return (
      <Select
        value={current}
        onValueChange={(v: string | null) => {
          if (v !== null) {
            onPick(v)
          }
        }}
      >
        <SelectTrigger className={cn('h-7 text-xs font-mono', stale && 'text-destructive border-destructive')}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {availableSecrets.length === 0 ? (
            <div className='px-2 py-1.5 text-[10px] text-muted-foreground italic'>No secrets available</div>
          ) : (
            availableSecrets.map((k: string) => (
              <SelectItem key={k} value={k} className='font-mono text-xs'>
                {k}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    )
  }

  return (
    <div className='flex flex-col gap-2'>
      {value.map((r, i) => (
        <div key={i} className='flex flex-col gap-1 rounded border p-2'>
          <div className='flex gap-1 items-center'>
            <Label className='text-[10px] w-16 shrink-0'>Host</Label>
            <Input
              value={r.host}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => update(i, { host: e.target.value })}
              className='h-7 text-xs flex-1 font-mono'
            />
            <Button variant='ghost' size='icon' className='h-7 w-7 shrink-0' onClick={() => remove(i)} title='Remove'>
              <icons.X className='h-3 w-3' />
            </Button>
          </div>
          <div className='flex gap-1 items-center'>
            <Label className='text-[10px] w-16 shrink-0'>User</Label>
            {renderSecretSelect(r.usernameSecret, (v) => update(i, { usernameSecret: v }), 'username secret…')}
          </div>
          <div className='flex gap-1 items-center'>
            <Label className='text-[10px] w-16 shrink-0'>Password</Label>
            {renderSecretSelect(r.passwordSecret, (v) => update(i, { passwordSecret: v }), 'password secret…')}
          </div>
        </div>
      ))}
      <Button variant='outline' size='sm' className='h-7 text-xs' onClick={add}>
        <icons.Plus className='h-3 w-3 mr-1' /> Add Registry
      </Button>
    </div>
  )
}

export function DockerInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: DockerData
  updateData: (p: Partial<DockerData>) => void
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Docker Context (optional)</Label>
        <Input
          value={data.contextName ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ contextName: e.target.value })}
          placeholder='default'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Registries (auto-login on start)</Label>
        <RegistriesEditor
          value={data.registries ?? []}
          onChange={(next: DockerRegistry[]) => updateData({ registries: next })}
        />
      </div>
    </div>
  )
}

function useDockerReady(nodeId: string) {
  const ctx = useNodeContext<TerminalContext>(nodeId, 'ctx-in')
  return Boolean(ctx?.value)
}

interface RowActionProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  disabled?: boolean
}

function RowAction({ icon: Icon, label, onClick, disabled }: RowActionProps) {
  return (
    <Button variant='ghost' size='sm' className='h-6 w-6 p-0' title={label} onClick={onClick} disabled={disabled}>
      <Icon className='h-3 w-3' />
    </Button>
  )
}

function parsePorts(ports: string): string[] {
  return ports
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}

function imageReference(img: ImageListItem): string {
  const tagged = img.repository !== '<none>' && img.tag && img.tag !== '<none>'
  return tagged ? `${img.repository}:${img.tag}` : ''
}

function matchesImage(container: ContainerListItem, img: ImageListItem, reference: string): boolean {
  if (reference && container.image === reference) {
    return true
  }
  return container.image === img.id || container.image.startsWith(`sha256:${img.id}`)
}

function buildInventory(images: ImageListItem[], containers: ContainerListItem[]): InventoryGroup[] {
  const groups: InventoryGroup[] = images.map((img) => ({
    image: img,
    reference: imageReference(img),
    containers: [],
  }))
  const orphans = new Map<string, InventoryGroup>()
  for (const c of containers) {
    const group = groups.find((g) => g.image && matchesImage(c, g.image, g.reference))
    if (group) {
      group.containers.push(c)
      continue
    }
    const key = c.image || '(unknown)'
    let orphan = orphans.get(key)
    if (!orphan) {
      orphan = { image: null, reference: key, containers: [] }
      orphans.set(key, orphan)
    }
    orphan.containers.push(c)
  }
  return [...groups, ...orphans.values()]
}

interface ContainerRowProps {
  container: ContainerListItem
  busy: boolean
  indent?: boolean
  onAction: (containerId: string, action: string, label: string) => void
}

function ContainerRow({ container, busy, indent, onAction }: ContainerRowProps) {
  const ports = parsePorts(container.ports)
  return (
    <div className={cn('flex flex-col gap-0.5 pr-2 py-1.5 text-xs', indent ? 'pl-6' : 'pl-2')}>
      <div className='flex items-center gap-1.5'>
        <StatusIndicator variant={container.running ? 'success' : container.state === 'restarting' || container.state === 'paused' ? 'warning' : 'secondary'} />
        <span className='font-medium truncate flex-1'>{container.name}</span>
        <span className='font-mono text-[10px] text-muted-foreground'>{container.id.slice(0, 12)}</span>
        <div className='flex items-center'>
          {verbApplies('stop', container.state) ? (
            <RowAction
              icon={icons.Square}
              label='Stop'
              onClick={() => onAction(container.id, 'stopContainer', 'Stop')}
              disabled={busy}
            />
          ) : (
            <RowAction
              icon={icons.Play}
              label='Start'
              onClick={() => onAction(container.id, 'startContainer', 'Start')}
              disabled={busy || !verbApplies('start', container.state)}
            />
          )}
          <RowAction
            icon={icons.RotateCw}
            label='Restart'
            onClick={() => onAction(container.id, 'restartContainer', 'Restart')}
            disabled={busy || !verbApplies('reboot', container.state)}
          />
          <RowAction
            icon={icons.Trash2}
            label='Remove'
            onClick={() => onAction(container.id, 'removeContainer', 'Remove')}
            disabled={busy}
          />
        </div>
      </div>
      <div className='text-[10px] text-muted-foreground truncate'>{container.status}</div>
      {ports.length > 0 ? (
        <ul className='flex flex-col text-[10px] text-muted-foreground font-mono'>
          {ports.map((p) => (
            <li key={p} className='truncate'>
              {p}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

interface ImageRowProps {
  image: ImageListItem
  reference: string
  busy: boolean
  onPull: (id: string, reference: string) => void
  onRemove: (id: string) => void
}

function ImageRow({ image, reference, busy, onPull, onRemove }: ImageRowProps) {
  return (
    <div className='flex flex-col gap-0.5 px-2 py-1.5 text-xs bg-muted/30'>
      <div className='flex items-center gap-1.5'>
        <icons.Layers className='h-3 w-3 shrink-0 text-muted-foreground' />
        <span className='font-medium truncate flex-1'>{reference || '(untagged)'}</span>
        <span className='font-mono text-[10px] text-muted-foreground'>{image.id.slice(0, 12)}</span>
        <div className='flex items-center'>
          <RowAction
            icon={icons.Download}
            label='Pull'
            onClick={() => onPull(image.id, reference)}
            disabled={busy || !reference}
          />
          <RowAction icon={icons.Trash2} label='Remove' onClick={() => onRemove(image.id)} disabled={busy} />
        </div>
      </div>
      <div className='flex gap-3 text-[10px] text-muted-foreground pl-4'>
        <span>{image.size}</span>
        <span>{image.created}</span>
      </div>
    </div>
  )
}

function OrphanImageHeader({ reference }: { reference: string }) {
  return (
    <div className='flex items-center gap-1.5 px-2 py-1.5 text-xs bg-muted/30'>
      <icons.Layers className='h-3 w-3 shrink-0 text-muted-foreground' />
      <span className='font-medium truncate flex-1 italic text-muted-foreground'>{reference}</span>
    </div>
  )
}

type ViewMode = 'grouped' | 'images' | 'containers'

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'grouped', label: 'Grouped' },
  { id: 'images', label: 'Images' },
  { id: 'containers', label: 'Containers' },
]

function ViewModeSwitch({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className='inline-flex items-center rounded-md border h-6 p-0.5'>
      {VIEW_MODES.map((m) => (
        <Button
          key={m.id}
          variant={mode === m.id ? 'secondary' : 'ghost'}
          size='sm'
          className='h-5 text-[10px] px-2 rounded-sm'
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </Button>
      ))}
    </div>
  )
}

export function DockerInventoryTab({
  nodeId,
}: {
  nodeId: string
  data: DockerData
  updateData: (p: Partial<DockerData>) => void
}) {
  const ready = useDockerReady(nodeId)
  const [groups, setGroups] = useState<InventoryGroup[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('grouped')

  const refresh = useCallback(async () => {
    if (!ready) {
      setGroups([])
      return
    }
    setLoading(true)
    try {
      const [images, containers] = await Promise.all([
        invoke<ImageListItem[]>('docker.listImages', { dockerNodeId: nodeId }),
        invoke<ContainerListItem[]>('docker.listContainers', { dockerNodeId: nodeId }),
      ])
      setGroups(buildInventory(images, containers))
    } catch {
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [nodeId, ready])

  useEffect(() => {
    refresh()
  }, [refresh])

  const onContainerAction = useCallback(
    async (containerId: string, action: string, label: string) => {
      setBusy(containerId)
      try {
        await invoke<void>(`docker.${action}`, { dockerNodeId: nodeId, containerId })
        await refresh()
      } catch (err) {
        toast.error(`${label} failed: ${String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [nodeId, refresh],
  )

  const onImagePull = useCallback(
    async (imageId: string, reference: string) => {
      setBusy(imageId)
      try {
        await invoke<void>('docker.pullImage', { dockerNodeId: nodeId, reference })
        await refresh()
      } catch (err) {
        toast.error(`Pull failed: ${String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [nodeId, refresh],
  )

  const onImageRemove = useCallback(
    async (imageId: string) => {
      setBusy(imageId)
      try {
        await invoke<void>('docker.removeImage', { dockerNodeId: nodeId, imageId })
        await refresh()
      } catch (err) {
        toast.error(`Remove failed: ${String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [nodeId, refresh],
  )

  if (!ready) {
    return (
      <div className='p-3 text-xs text-muted-foreground italic'>Connect a host to inspect images and containers.</div>
    )
  }

  const imageCount = groups?.filter((g) => g.image).length ?? 0
  const containerCount = groups?.reduce((acc, g) => acc + g.containers.length, 0) ?? 0
  const summary =
    groups === null
      ? '—'
      : mode === 'images'
        ? `${imageCount} image${imageCount === 1 ? '' : 's'}`
        : mode === 'containers'
          ? `${containerCount} container${containerCount === 1 ? '' : 's'}`
          : `${imageCount} image${imageCount === 1 ? '' : 's'}, ${containerCount} container${containerCount === 1 ? '' : 's'}`

  return (
    <div className='flex flex-col h-full'>
      <div className='flex items-center gap-2 px-2 py-1.5 border-b'>
        <span className='text-xs text-muted-foreground flex-1'>{summary}</span>
        <Button variant='ghost' size='sm' className='h-6 text-[10px] px-1.5' onClick={refresh} disabled={loading}>
          <icons.RotateCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
        <ViewModeSwitch mode={mode} onChange={setMode} />
      </div>
      <div className='flex-1 overflow-auto'>
        {renderInventory({ groups, mode, busy, onContainerAction, onImagePull, onImageRemove })}
      </div>
    </div>
  )
}

interface RenderProps {
  groups: InventoryGroup[] | null
  mode: ViewMode
  busy: string | null
  onContainerAction: (containerId: string, action: string, label: string) => void
  onImagePull: (imageId: string, reference: string) => void
  onImageRemove: (imageId: string) => void
}

function renderInventory(props: RenderProps): React.ReactNode {
  const { groups, mode, busy, onContainerAction, onImagePull, onImageRemove } = props
  if (!groups) {
    return null
  }

  if (mode === 'images') {
    const imageGroups = groups.filter((g) => g.image)
    if (imageGroups.length === 0) {
      return <div className='p-3 text-xs text-muted-foreground italic'>No images.</div>
    }
    return (
      <div className='flex flex-col divide-y'>
        {imageGroups.map((g) => (
          <ImageRow
            key={g.image!.id}
            image={g.image!}
            reference={g.reference}
            busy={busy === g.image!.id}
            onPull={onImagePull}
            onRemove={onImageRemove}
          />
        ))}
      </div>
    )
  }

  if (mode === 'containers') {
    const containers = groups.flatMap((g) => g.containers)
    if (containers.length === 0) {
      return <div className='p-3 text-xs text-muted-foreground italic'>No containers.</div>
    }
    return (
      <div className='flex flex-col divide-y'>
        {containers.map((c) => (
          <ContainerRow key={c.id} container={c} busy={busy === c.id} onAction={onContainerAction} />
        ))}
      </div>
    )
  }

  if (groups.length === 0) {
    return <div className='p-3 text-xs text-muted-foreground italic'>No images or containers.</div>
  }
  return (
    <div className='flex flex-col divide-y'>
      {groups.map((g, i) => (
        <div key={g.image ? g.image.id : `orphan-${g.reference}-${i}`} className='flex flex-col'>
          {g.image ? (
            <ImageRow
              image={g.image}
              reference={g.reference}
              busy={busy === g.image.id}
              onPull={onImagePull}
              onRemove={onImageRemove}
            />
          ) : (
            <OrphanImageHeader reference={g.reference} />
          )}
          {g.containers.map((c) => (
            <ContainerRow key={c.id} container={c} busy={busy === c.id} indent onAction={onContainerAction} />
          ))}
        </div>
      ))}
    </div>
  )
}

interface VolumeListItem {
  name: string
  created: string
}

export function DockerVolumesTab({
  nodeId,
}: {
  nodeId: string
  data: DockerData
  updateData: (p: Partial<DockerData>) => void
}) {
  const ready = useDockerReady(nodeId)
  const [volumes, setVolumes] = useState<VolumeListItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    if (!ready) {
      setVolumes([])
      return
    }
    setLoading(true)
    try {
      setVolumes(await invoke<VolumeListItem[]>('docker.listVolumes', { dockerNodeId: nodeId }))
    } catch {
      setVolumes([])
    } finally {
      setLoading(false)
    }
  }, [nodeId, ready])

  useEffect(() => {
    refresh()
  }, [refresh])

  const onCreate = useCallback(async () => {
    const name = newName.trim()
    if (!name) {
      return
    }
    setCreating(true)
    try {
      await invoke<void>('docker.createVolume', { dockerNodeId: nodeId, name })
      setNewName('')
      await refresh()
    } catch (err) {
      toast.error(`Create failed: ${String(err)}`)
    } finally {
      setCreating(false)
    }
  }, [newName, nodeId, refresh])

  const onRemove = useCallback(
    async (name: string) => {
      setBusy(name)
      try {
        await invoke<void>('docker.removeVolume', { dockerNodeId: nodeId, name })
        await refresh()
      } catch (err) {
        toast.error(`Remove failed: ${String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [nodeId, refresh],
  )

  if (!ready) {
    return <div className='p-3 text-xs text-muted-foreground italic'>Connect a host to manage volumes.</div>
  }

  return (
    <div className='flex flex-col h-full'>
      <div className='flex items-center gap-1.5 px-2 py-1.5 border-b'>
        <Input
          value={newName}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
          placeholder='volume name'
          className='h-7 text-xs flex-1 font-mono'
        />
        <Button variant='outline' size='sm' className='h-7 text-xs' onClick={onCreate} disabled={creating || !newName.trim()}>
          <icons.Plus className='h-3 w-3 mr-1' /> Create
        </Button>
        <Button variant='ghost' size='sm' className='h-7 text-[10px] px-1.5' onClick={refresh} disabled={loading}>
          <icons.RotateCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
      </div>
      <div className='flex-1 overflow-auto'>
        {volumes === null ? null : volumes.length === 0 ? (
          <div className='p-3 text-xs text-muted-foreground italic'>No volumes yet.</div>
        ) : (
          <div className='flex flex-col divide-y'>
            {volumes.map((v) => (
              <VolumeEntryRow
                key={v.name}
                name={v.name}
                created={v.created}
                action={{ icon: icons.Trash2, label: 'Delete', onClick: () => onRemove(v.name), disabled: busy === v.name }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
