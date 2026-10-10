import { secrets } from '@opencroft/server/secrets'

import { buildDockerExecContext } from './dockerExecContext'
import { parseNamedVolumes, sameMount, serializeNamedVolumes } from './named-volumes'
import {
  type DockerCheckImageUpdateParams,
  type DockerCheckParams,
  type DockerContainerActionParams,
  type DockerDownParams,
  type DockerImageActionParams,
  type DockerImagePullParams,
  type DockerListParams,
  type DockerPsParams,
  type DockerRestartServiceParams,
  type DockerServiceLogsParams,
  type DockerStartInstancesParams,
  type DockerStopInstancesParams,
  type DockerStopServiceParams,
  type DockerTerminalConfigParams,
  type DockerUpParams,
  type DockerVolumeNameParams,
  deployStatus,
  dockerCheck,
  dockerCheckImageUpdate,
  dockerCreateVolume,
  dockerDown,
  dockerListContainers,
  dockerListImages,
  dockerListVolumes,
  dockerProbe,
  dockerPs,
  dockerPullImage,
  dockerRemoveContainer,
  dockerRemoveImage,
  dockerRemoveVolume,
  dockerRestartContainer,
  dockerRestartService,
  dockerServiceLogs,
  dockerStartContainer,
  dockerStartInstances,
  dockerStopContainer,
  dockerStopInstances,
  dockerStopService,
  dockerTerminalConfig,
  dockerUp,
} from './server/docker'
import {
  type ContainerParams,
  closeView,
  containerState,
  type WatchLogsParams,
  watchContainerLogs,
  watchDeploy,
} from './server/log-streams'

export const actions = {
  'docker.check': (params: DockerCheckParams) => dockerCheck(params),
  'docker.probe': (params: DockerCheckParams) => dockerProbe(params),
  'docker.ps': (params: DockerPsParams) => dockerPs(params),
  'docker.up': (params: DockerUpParams) => dockerUp(params),
  'docker.down': (params: DockerDownParams) => dockerDown(params),
  'docker.stopService': (params: DockerStopServiceParams) => dockerStopService(params),
  'docker.restartService': (params: DockerRestartServiceParams) => dockerRestartService(params),
  'docker.deployStatus': (params: { applicationNodeId: string }) => deployStatus(params.applicationNodeId),
  'docker.watchDeploy': (params: { applicationNodeId: string }) => watchDeploy(params.applicationNodeId),
  'docker.watchLogs': (params: WatchLogsParams) => watchContainerLogs(params),
  'docker.closeView': (params: { sessionKey: string }) => closeView(params.sessionKey),
  'docker.containerState': (params: ContainerParams) => containerState(params),
  'docker.terminalConfig': (params: DockerTerminalConfigParams) => dockerTerminalConfig(params),
  'docker.listContainers': (params: DockerListParams) => dockerListContainers(params),
  'docker.listImages': (params: DockerListParams) => dockerListImages(params),
  'docker.startContainer': (params: DockerContainerActionParams) => dockerStartContainer(params),
  'docker.stopContainer': (params: DockerContainerActionParams) => dockerStopContainer(params),
  'docker.restartContainer': (params: DockerContainerActionParams) => dockerRestartContainer(params),
  'docker.removeContainer': (params: DockerContainerActionParams) => dockerRemoveContainer(params),
  'docker.removeImage': (params: DockerImageActionParams) => dockerRemoveImage(params),
  'docker.pullImage': (params: DockerImagePullParams) => dockerPullImage(params),
  'docker.checkImageUpdate': (params: DockerCheckImageUpdateParams) => dockerCheckImageUpdate(params),
  'docker.listVolumes': (params: DockerListParams) => dockerListVolumes(params),
  'docker.createVolume': (params: DockerVolumeNameParams) => dockerCreateVolume(params),
  'docker.removeVolume': (params: DockerVolumeNameParams) => dockerRemoveVolume(params),
}

// ── Application node actions ──────────────────────────────────────────────

interface ActionCtx {
  nodeId: string
  data: Record<string, unknown>
  params: Record<string, unknown>
  inputSource<T = unknown>(
    handleId: string,
  ): { sourceNodeId: string; sourceHandleId: string; handleType: string; value: T } | undefined
  connectedSources(
    handleId: string,
  ): { nodeId: string; handleId: string; type?: string; data: Record<string, unknown> }[]
  containingNodes(
    type?: string,
  ): { id: string; type?: string; position: { x: number; y: number }; data: Record<string, unknown> }[]
  updateData(patch: Record<string, unknown>): void
  // Present when the host runs the action as a background task, and aborted when that task is
  // cancelled or runs out of time.
  signal?: AbortSignal
}

interface VolumeData {
  hostPath?: string
  containerPath?: string
  readOnly?: boolean
}

interface NetworkData {
  networkName?: string
  driver?: string
  external?: boolean
}

interface AppData {
  name?: string
  image?: string
  ports?: string
  env?: string
  command?: string
  entrypoint?: string
  ipc?: string
  shmSize?: string
  restart?: string
  replicas?: number
  containerName?: string
  workingDir?: string
  terminalUser?: string
  terminalShell?: string
  buildContext?: string
  buildDockerfile?: string
  gpu?: boolean
  requirementMemory?: string
  requirementCpu?: string
  init?: boolean
  readOnly?: boolean
  dependsOn?: string
  groupAdd?: string
  securityOpts?: string
  tmpfs?: string
  devices?: string
  healthcheckTest?: string
  healthcheckInterval?: string
  healthcheckTimeout?: string
  healthcheckRetries?: number
  healthcheckStartPeriod?: string
  proxyDomain?: string
  proxyEntrypoint?: string
  proxyTls?: boolean
  proxyBasicAuth?: string
  proxyPort?: number
  exposeHostDocker?: boolean
  copyDockerBinaries?: boolean
  labels?: string
  secrets?: string
  namedVolumes?: string
  logDriver?: string
  logOpts?: string
}

const HOST_DOCKER_BINARIES = [
  '/usr/bin/docker:/usr/bin/docker:ro',
  '/usr/libexec/docker/cli-plugins/docker-compose:/usr/libexec/docker/cli-plugins/docker-compose:ro',
]

function buildVolumes(ctx: ActionCtx, data: AppData): string {
  const mounts: string[] = []
  for (const src of ctx.connectedSources('volumes-in')) {
    const d = src.data as VolumeData
    if (!d.hostPath || !d.containerPath) {
      continue
    }
    mounts.push(`${d.hostPath}:${d.containerPath}${d.readOnly ? ':ro' : ''}`)
  }
  if (data.copyDockerBinaries) {
    mounts.push(...HOST_DOCKER_BINARIES)
  }
  return mounts.join('\n')
}

function buildNetworks(ctx: ActionCtx): { name: string; driver: string; external: boolean }[] {
  return ctx
    .containingNodes('network')
    .map((n) => {
      const d = n.data as NetworkData
      return { name: d.networkName ?? '', driver: d.driver ?? '', external: d.external ?? false }
    })
    .filter((n) => n.name)
}

async function resolveSecrets(data: AppData): Promise<Record<string, string>> {
  const names = (data.secrets ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (names.length === 0) {
    return {}
  }
  const resolved: Record<string, string> = {}
  for (const name of names) {
    const value = await secrets.resolve(name)
    if (value === null) {
      throw new Error(`Secret "${name}" not found in any Secrets Store`)
    }
    resolved[name] = value
  }
  return resolved
}

function requireDockerNodeId(ctx: ActionCtx): string {
  const source = ctx.inputSource('docker-in')
  if (!source?.sourceNodeId) {
    throw new Error('Application is not connected to a Docker node')
  }
  return source.sourceNodeId
}

function serviceName(ctx: ActionCtx, data: AppData): string {
  return data.name || ctx.nodeId
}

// The "deploy" action: compose up, creating or recreating the container.
async function applicationDeploy(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData
  if (!data.image?.trim() && !data.buildContext?.trim()) {
    throw new Error('Application requires an image or build context')
  }
  const dockerNodeId = requireDockerNodeId(ctx)
  const secrets = await resolveSecrets(data)
  const params: DockerUpParams = {
    dockerNodeId,
    applicationNodeId: ctx.nodeId,
    service: serviceName(ctx, data),
    image: data.image ?? '',
    ports: data.ports ?? '',
    env: data.env ?? '',
    secrets,
    volumes: buildVolumes(ctx, data),
    namedVolumes: data.namedVolumes ?? '',
    command: data.command ?? '',
    entrypoint: data.entrypoint,
    ipc: data.ipc,
    shmSize: data.shmSize,
    restart: data.restart ?? '',
    replicas: data.replicas ?? 1,
    networks: buildNetworks(ctx),
    containerName: data.containerName,
    workingDir: data.workingDir,
    buildContext: data.buildContext,
    buildDockerfile: data.buildDockerfile,
    gpu: data.gpu,
    requirementMemory: data.requirementMemory,
    requirementCpu: data.requirementCpu,
    init: data.init,
    readOnly: data.readOnly,
    dependsOn: data.dependsOn,
    groupAdd: data.groupAdd,
    securityOpts: data.securityOpts,
    tmpfs: data.tmpfs,
    devices: data.devices,
    healthcheckTest: data.healthcheckTest,
    healthcheckInterval: data.healthcheckInterval,
    healthcheckTimeout: data.healthcheckTimeout,
    healthcheckRetries: data.healthcheckRetries,
    healthcheckStartPeriod: data.healthcheckStartPeriod,
    proxyDomain: data.proxyDomain,
    proxyEntrypoint: data.proxyEntrypoint,
    proxyTls: data.proxyTls,
    proxyBasicAuth: data.proxyBasicAuth,
    proxyPort: data.proxyPort,
    exposeHostDocker: data.exposeHostDocker,
    labels: data.labels,
    logDriver: data.logDriver,
    logOpts: data.logOpts,
  }
  await dockerUp(params, ctx.signal)
}

// The "terminate" action: compose stop + rm, a full teardown.
async function applicationTerminate(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData
  await dockerStopService({ dockerNodeId: requireDockerNodeId(ctx), service: serviceName(ctx, data) })
}

// The "reboot" action: restart the existing containers in place.
async function applicationReboot(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData
  await dockerRestartService({
    dockerNodeId: requireDockerNodeId(ctx),
    applicationNodeId: ctx.nodeId,
    service: serviceName(ctx, data),
  })
}

// The "start" action: plain `docker start` of the existing containers.
async function applicationStart(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData
  const params: DockerStartInstancesParams = { dockerNodeId: requireDockerNodeId(ctx), service: serviceName(ctx, data) }
  await dockerStartInstances(params)
}

// The "stop" action: plain `docker stop`, keeping the containers.
async function applicationStop(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData
  const params: DockerStopInstancesParams = { dockerNodeId: requireDockerNodeId(ctx), service: serviceName(ctx, data) }
  await dockerStopInstances(params)
}

async function applicationLogs(ctx: ActionCtx): Promise<string> {
  const data = ctx.data as AppData
  const params: DockerServiceLogsParams = {
    dockerNodeId: requireDockerNodeId(ctx),
    service: serviceName(ctx, data),
  }
  if (typeof ctx.params.containerId === 'string' && ctx.params.containerId.trim()) {
    params.containerId = ctx.params.containerId.trim()
  }
  if (typeof ctx.params.tail === 'number') {
    params.tail = ctx.params.tail
  }
  if (typeof ctx.params.since === 'string' && ctx.params.since.trim()) {
    params.since = ctx.params.since.trim()
  }
  if (typeof ctx.params.until === 'string' && ctx.params.until.trim()) {
    params.until = ctx.params.until.trim()
  }
  if (ctx.params.timestamps !== undefined) {
    params.timestamps = Boolean(ctx.params.timestamps)
  }
  return dockerServiceLogs(params)
}

function requireStringParam(ctx: ActionCtx, key: string): string {
  const value = ctx.params[key]
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) {
    throw new Error(`Missing required param "${key}"`)
  }
  return trimmed
}

async function applicationAttachVolume(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData
  const volumeName = requireStringParam(ctx, 'volumeName')
  const containerPath = requireStringParam(ctx, 'containerPath')
  const readOnly = Boolean(ctx.params.readOnly)
  const subpath =
    typeof ctx.params.subpath === 'string' && ctx.params.subpath.trim() ? ctx.params.subpath.trim() : undefined
  const directMount = Boolean(ctx.params.directMount)
  const current = parseNamedVolumes(data.namedVolumes ?? '')
  // A volume can be mounted at more than one container path (e.g. two different subpaths of it) —
  // only replace an existing entry that matches BOTH the volume and this exact target path.
  const next = [
    ...current.filter((v) => !sameMount(v, volumeName, containerPath)),
    { volumeName, containerPath, readOnly, subpath, directMount },
  ]
  ctx.updateData({ namedVolumes: serializeNamedVolumes(next) })
}

async function applicationDetachVolume(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData
  const volumeName = requireStringParam(ctx, 'volumeName')
  const containerPath = requireStringParam(ctx, 'containerPath')
  const current = parseNamedVolumes(data.namedVolumes ?? '')
  ctx.updateData({
    namedVolumes: serializeNamedVolumes(current.filter((v) => !sameMount(v, volumeName, containerPath))),
  })
}

async function dockerCreateVolumeAction(ctx: ActionCtx): Promise<void> {
  await dockerCreateVolume({ dockerNodeId: ctx.nodeId, name: requireStringParam(ctx, 'name') })
}

async function dockerRemoveVolumeAction(ctx: ActionCtx): Promise<void> {
  await dockerRemoveVolume({ dockerNodeId: ctx.nodeId, name: requireStringParam(ctx, 'name') })
}

async function dockerListVolumesAction(ctx: ActionCtx) {
  return dockerListVolumes({ dockerNodeId: ctx.nodeId })
}

export const nodeActions = {
  docker: {
    createVolume: dockerCreateVolumeAction,
    removeVolume: dockerRemoveVolumeAction,
    listVolumes: dockerListVolumesAction,
  },
  // The ids are the application node's context-menu vocabulary (src/nodes/application.tsx):
  // "start"/"stop" act on the existing containers in place, "deploy"/"terminate" create and
  // tear them down.
  application: {
    deploy: applicationDeploy,
    terminate: applicationTerminate,
    reboot: applicationReboot,
    start: applicationStart,
    stop: applicationStop,
    logs: applicationLogs,
    attachVolume: applicationAttachVolume,
    detachVolume: applicationDetachVolume,
  },
}

// ── exposeOutput (server) ─────────────────────────────────────────────────

export const exposeOutput = (handleId: string, nodeData: Record<string, unknown>, typeId: string): unknown => {
  if (typeId === 'docker') {
    if (handleId !== 'docker-out') {
      return undefined
    }
    const resolved = nodeData.__resolvedContexts as Record<string, { value?: Record<string, unknown> }> | undefined
    const target = resolved?.['context-in']?.value
    const exec = resolved?.['ctx-in']?.value ?? { type: 'local' }
    const base = target ?? exec
    return { ...base, contextName: (nodeData.contextName as string) || '' }
  }

  if (typeId === 'application') {
    if (!handleId.startsWith('instance-terminal-')) {
      return undefined
    }
    const containerId = handleId.slice('instance-terminal-'.length)
    const resolved = nodeData.__resolvedContexts as Record<string, { value?: Record<string, unknown> }> | undefined
    const docker = resolved?.['docker-in']?.value
    if (!docker) {
      return undefined
    }
    const { contextName, ...via } = docker as { contextName?: string } & Record<string, unknown>
    // NOTE: this exposeOutput logic shares buildDockerExecContext (./dockerExecContext) with the
    // client-side implementation in src/client.tsx (the 'application' node's exposeOutput for this
    // same handle) — keep both call sites passing the same arguments.
    return buildDockerExecContext(via, contextName, containerId, nodeData)
  }

  if (typeId === 'volume') {
    if (handleId !== 'vol-out') {
      return undefined
    }
    const hostPath = nodeData.hostPath as string | undefined
    const containerPath = nodeData.containerPath as string | undefined
    if (!hostPath || !containerPath) {
      return undefined
    }
    return { hostPath, containerPath, readOnly: Boolean(nodeData.readOnly) }
  }

  return undefined
}
