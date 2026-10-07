import host from '@ext/host'
import { type ExecResult, ssh, type TerminalContext, terminal } from '@opencroft/server'
import * as yaml from 'js-yaml'

import { type LifecycleVerb, verbApplies } from '../container-lifecycle'
import { type AttachedVolume, parseNamedVolumes } from '../named-volumes'
import type { DeployAction, DeployLogEntry, DeployStatus } from '../deploy-log'
import { deployFollowScript } from './deploy-follow'
import { redactSecrets } from './redact'
import { MIN_VALUE_LENGTH } from './redact-values'
import { ensureRegistryLogin } from './registry'

const COMPOSE_PROJECT = 'opencroft'

export interface DockerContext extends TerminalContext {
  contextName?: string
  dockerHost?: string
  targetKeyPath?: string
  dockerNodeId?: string
}

interface ResolvedHandle {
  value?: TerminalContext
}

interface DockerNodeData {
  contextName?: string
  __resolvedContexts?: Record<string, ResolvedHandle>
}

function buildDockerHost(target: TerminalContext | undefined): string | undefined {
  if (!target || target.type !== 'ssh' || !target.host) {
    return undefined
  }
  const user = (target.username as string) || 'root'
  const port = (target.port as number) || 22
  return `ssh://${user}@${target.host}:${port}`
}

async function resolveDockerContext(dockerNodeId: string): Promise<DockerContext> {
  const node = await host.graph.getNode(dockerNodeId)
  if (!node) {
    throw new Error(`Docker node ${dockerNodeId} not found`)
  }
  const data = node.data as DockerNodeData
  const exec = data.__resolvedContexts?.['ctx-in']?.value ?? { type: 'local' }
  const target = data.__resolvedContexts?.['context-in']?.value
  return {
    ...exec,
    contextName: data.contextName,
    dockerHost: buildDockerHost(target),
    targetKeyPath: target?.keyPath as string | undefined,
    dockerNodeId,
  }
}

// Only the named-CLI-context case goes here. A dynamically-known host (`ctx.dockerHost`) is
// passed via the DOCKER_HOST env var instead (see runDockerCmd) — `-H` on the `docker` command
// is NOT inherited by BuildKit/buildx for compose services with a build context, which silently
// falls back to the default context for the build step alone. DOCKER_HOST is respected uniformly
// by both the docker CLI and buildx.
function dockerHostArgs(ctx: DockerContext): string[] {
  if (ctx.contextName) {
    return ['--context', ctx.contextName]
  }
  return []
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

async function resolveTargetKey(keyPath: string): Promise<string> {
  const content = await ssh.resolveKey(keyPath)
  if (!content) {
    throw new Error(`Unable to resolve key for docker context: ${keyPath}`)
  }
  return content.endsWith('\n') ? content : content + '\n'
}

// Heredoc delimiter for stdin-fed compose invocations. Contains '_', which the base64 alphabet
// (A-Za-z0-9+/=) cannot produce, so no encoded data line can ever collide with the terminator.
const COMPOSE_STDIN_MARKER = 'OPENCROFT_COMPOSE_B64_EOF'

// Wrap at 76 cols to match the conventional `base64` CLI line width (cosmetic only — `base64 -d`
// accepts unwrapped input just as well).
function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join('\n') ?? b64
}

// Build the final shell command line for a docker invocation, given the argv and an optional
// stdin payload. Without a payload this is just the quoted argv. With a payload (compose YAML),
// the content is embedded as a base64 heredoc and decoded straight into the command over a
// pipe — no file needs to exist on the exec target, so
// this works whether that target is local, WSL, a remote SSH host, or inside a container (docker
// exec). This is used for BOTH the plain path (terminal.exec) and the ssh-agent key-injection
// script path below, so both get stdin-fed compose for free.
//
// Note: the pipe must sit on the SAME line as the `<<'MARKER'` redirect, not after the closing
// marker line — `cmd <<'EOF'\n...\nEOF\n| other` is a syntax error (verified against bash/dash:
// the heredoc body is consumed as part of the line containing the redirect, and the command is
// already complete once that line's newline is reached; anything after the marker starts a new,
// pipe-less statement). `cmd <<'EOF' | other\n...\nEOF` is the only valid form.
//
// `env` entries become POSIX `K='v'` assignment prefixes on the docker command itself (the LAST
// pipeline segment when a stdin payload is present), so they reach docker/compose and nothing
// else. Callers only pass env together with a stdin payload (compose), which always executes via
// terminal.exec — plain argv calls (terminal.run) never carry env here.
function buildDockerShellCommand(cmd: string[], stdin?: string, env?: Record<string, string>): string {
  const assignments = Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${shellQuote(v)} `)
    .join('')
  const quoted = assignments + cmd.map(shellQuote).join(' ')
  if (stdin === undefined) {
    return quoted
  }
  const payload = wrapBase64(Buffer.from(stdin, 'utf-8').toString('base64'))
  return [`base64 -d <<'${COMPOSE_STDIN_MARKER}' | ${quoted}`, payload, COMPOSE_STDIN_MARKER].join('\n')
}

async function runDockerCmd(
  ctx: DockerContext,
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
  mergeStderr?: boolean,
): Promise<ExecResult> {
  // DOCKER_HOST (not `-H`) is how a dynamically-known host reaches the actual command — see the
  // comment on dockerHostArgs. This needs shell interpretation, so it forces the terminal.exec path
  // below even for calls that would otherwise use the plain argv terminal.run.
  const mergedEnv = ctx.dockerHost ? { ...env, DOCKER_HOST: ctx.dockerHost } : env
  const cmd = ['docker', ...dockerHostArgs(ctx), ...args]
  const shellCmd = buildDockerShellCommand(cmd, stdin, mergedEnv) + (mergeStderr ? ' 2>&1' : '')

  if (!ctx.dockerHost && stdin === undefined && !mergeStderr) {
    // No host override, no stdin payload, no stderr merge — the simple argv path.
    return terminal.runResult(ctx, cmd)
  }

  if (!ctx.dockerHost || !ctx.targetKeyPath) {
    return terminal.execResult(ctx, shellCmd)
  }

  const keyContent = await resolveTargetKey(ctx.targetKeyPath)
  const keyDir = `/tmp/opencroft-docker-keys/${ctx.dockerNodeId ?? 'unknown'}`
  const keyFile = `${keyDir}/id`
  const script = [
    'set -e',
    'umask 077',
    `mkdir -p ${shellQuote(keyDir)}`,
    `cat > ${shellQuote(keyFile)} << 'OPENCROFT_KEY_EOF'`,
    keyContent.trimEnd(),
    'OPENCROFT_KEY_EOF',
    `chmod 600 ${shellQuote(keyFile)}`,
    `sock=${shellQuote(`${keyDir}/agent.sock`)}`,
    'ssh-agent -D -a "$sock" >/dev/null 2>&1 &',
    'agent_pid=$!',
    'export SSH_AUTH_SOCK="$sock"',
    // Preserve the docker command's exit status: the killed agent makes `wait`
    // return non-zero, which must not leak into the script's exit code (set -e).
    `trap 'st=$?; kill "$agent_pid" 2>/dev/null || true; wait "$agent_pid" 2>/dev/null || true; rm -rf ${shellQuote(keyDir)}; exit "$st"' EXIT`,
    'for i in $(seq 1 20); do if [ -S "$sock" ]; then break; fi; sleep 0.1; done',
    `ssh-add ${shellQuote(keyFile)}`,
    shellCmd,
  ].join('\n')
  return terminal.execResult(ctx, script)
}

// Per-dockerNodeId cache of a detected non-default docker socket PATH (e.g. a rootless install's
// `/run/user/<uid>/docker.sock`), populated the first time a plain call needs it. Only used when
// neither an explicit "Context" input (`ctx.dockerHost`) nor a named CLI context is configured —
// those cases already say explicitly which daemon to reach.
const detectedSocketCache = new Map<string, string>()

function isSocketConnectionError(message: string): boolean {
  const m = message.toLowerCase()
  if (!m.includes('docker.sock')) {
    return false
  }
  return (
    m.includes('permission denied') ||
    m.includes('no such file or directory') ||
    m.includes('connection refused') ||
    m.includes('cannot connect to the docker daemon') ||
    m.includes('is the docker daemon running')
  )
}

// Probe the actual exec target (whatever `ctx.type` resolves to — local, wsl, or ssh) for the
// real, live docker socket. A bare `docker` call run non-interactively often doesn't inherit the
// DOCKER_HOST a user's login shell would export (rootless installs set this via .bashrc/.profile
// as part of `dockerd-rootless-setuptool.sh install`), so it silently falls back to the compiled-in
// /var/run/docker.sock default and fails with a permission error even though the daemon is
// reachable. This runs over the SAME transport already used for docker commands against `ctx`, so
// it works identically whether that's local, wsl, or ssh.
async function probeDockerSocket(ctx: DockerContext): Promise<string | undefined> {
  const script = [
    // A DOCKER_HOST that is not a unix socket (tcp://, ssh://) names a daemon this probe cannot
    // express as a socket path. Reporting nothing leaves the call on whatever it already used;
    // reporting it would produce `unix://tcp://…` and cache that for every later call on the node.
    'if [ -n "$DOCKER_HOST" ]; then case "$DOCKER_HOST" in unix://*) printf %s "${DOCKER_HOST#unix://}"; exit 0;; *) exit 1;; esac; fi',
    'sock="/run/user/$(id -u)/docker.sock"',
    'if [ -S "$sock" ]; then printf %s "$sock"; exit 0; fi',
    'exit 1',
  ].join('\n')
  try {
    const out = (await terminal.exec(ctx, script)).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

function stdoutOrThrow(result: ExecResult): string {
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout
    throw new Error(`Command exited with code ${result.exitCode}${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout
}

// The terminal layer already collects stdout/stderr separately on every transport — no shell-level
// merge needed. stderr first: that's where compose's pull/build/recreate narrative actually lands;
// stdout covers e.g. `docker restart`, whose (minimal) output isn't on stderr at all. Cross-stream
// ordering is lost, which is an accepted trade-off for a launch's output.
function combinedOutput(result: ExecResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join('\n')
}

// The context a call actually uses: the node's own, or — for a plain local daemon whose socket an
// earlier call had to detect — that socket. `canDetect` says whether detection applies at all.
function withDetectedSocket(ctx: DockerContext): { canDetect: boolean; cached?: string; effectiveCtx: DockerContext } {
  const canDetect = !ctx.dockerHost && !ctx.contextName && Boolean(ctx.dockerNodeId)
  const cached = canDetect ? detectedSocketCache.get(ctx.dockerNodeId!) : undefined
  return { canDetect, cached, effectiveCtx: cached ? { ...ctx, dockerHost: `unix://${cached}` } : ctx }
}

// A docker call that retries on a detected socket when the plain call could not connect, and never
// throws on a non-zero exit — callers that need the raw output even when the command failed
// (deploy-log capture, below) use this directly. dockerCmd wraps it into the throwing,
// stdout-only contract the other call sites rely on.
async function dockerCmdResult(
  ctx: DockerContext,
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
  mergeStderr?: boolean,
): Promise<ExecResult> {
  const { canDetect, cached, effectiveCtx } = withDetectedSocket(ctx)
  const result = await runDockerCmd(effectiveCtx, args, stdin, env, mergeStderr)
  if (result.exitCode === 0 || !canDetect || cached || !isSocketConnectionError(result.stderr)) {
    return result
  }
  const detected = await probeDockerSocket(ctx)
  if (!detected) {
    return result
  }
  detectedSocketCache.set(ctx.dockerNodeId!, detected)
  return runDockerCmd({ ...ctx, dockerHost: `unix://${detected}` }, args, stdin, env, mergeStderr)
}

async function dockerCmd(
  ctx: DockerContext,
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
  mergeStderr?: boolean,
): Promise<string> {
  return stdoutOrThrow(await dockerCmdResult(ctx, args, stdin, env, mergeStderr))
}

// Run `docker compose` with the given YAML streamed over stdin (`-f -`). No compose file needs
// to exist anywhere — not on the exec target (which may be a remote SSH host or a container with
// no access to the OpenCroft host's filesystem) and not on the OpenCroft host either, so
// operations survive cacheDir wipes (instance recreation). COMPOSE_IGNORE_ORPHANS silences the
// "found orphan containers" warning that per-service docs would otherwise trigger for every
// sibling service in the shared project.
async function composeCmd(ctx: DockerContext, content: string, args: string[]): Promise<ExecResult> {
  return dockerCmdResult(ctx, ['compose', '-f', '-', '-p', COMPOSE_PROJECT, ...args], content, { COMPOSE_IGNORE_ORPHANS: '1' })
}

// List container IDs belonging to the shared compose project (optionally narrowed to one
// service), straight from the daemon's labels. This is the cache-independent primitive behind
// stop/restart/down: it works identically whether or not any compose file ever existed.
async function composeContainerIds(ctx: DockerContext, service?: string): Promise<string[]> {
  const args = ['ps', '-aq', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`]
  if (service) {
    args.push('--filter', `label=com.docker.compose.service=${service}`)
  }
  const out = await dockerCmd(ctx, args)
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

// The service's containers that `verb` does something to, read fresh from the daemon. Running a
// verb only where it applies keeps one replica the daemon would refuse (`start` on a paused one)
// from failing the action for all of them, and makes an action do exactly what its button offered.
async function serviceContainerIdsFor(ctx: DockerContext, service: string, verb: LifecycleVerb): Promise<string[]> {
  const args = [
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.ID}}\\t{{.State}}',
  ]
  const out = await dockerCmd(ctx, args)
  return out
    .split('\n')
    .map((line) => line.trim().split('\t'))
    .filter(([id, state]) => id && verbApplies(verb, state))
    .map(([id]) => id)
}

// ═══════════════════════════════════════════════════════════════════
// Compose doc generation — single-service docs, streamed via stdin
// ═══════════════════════════════════════════════════════════════════
//
// There is no accumulated compose file. Each `up` builds a self-contained
// single-service doc from the action params and streams it to `docker compose -f -`;
// stop/restart/down operate on the daemon's compose labels directly. Nothing reads any file, so
// behavior is unaffected by cacheDir wipes.

interface ComposeDoc {
  services: Record<string, Record<string, unknown>>
  networks?: Record<string, Record<string, unknown>>
  volumes?: Record<string, { external: true }>
}

function composeYaml(doc: unknown): string {
  return yaml.dump(doc, { indent: 2, lineWidth: -1, noRefs: true })
}

function composeDocContent(service: string, doc: ComposeDoc): string {
  const header = `# Generated by the OpenCroft docker extension for service "${service}".\n`
  return header + composeYaml(doc)
}

// Replaces every value the node resolved out of the Secrets Store with the name it came from.
//
// Matching the escaped value exactly is right HERE and wrong at the log seam, and the difference is
// worth stating because the two rules look contradictory. A secret occupies a compose field on its
// own, and the one transform applied to it is escapeCompose — so the string in the document IS the
// encoded value, and searching for it finds it. A log line, by contrast, usually encodes something
// larger than the credential, which is why redact-values.ts decodes candidates instead of encoding
// values.
//
// The minimum length is the redactor's own, imported rather than restated, because the hazard it
// guards is the same one: this replaces SUBSTRINGS throughout the document, not whole fields, so a
// two-character stored value would rewrite those two characters inside image names, paths and
// command lines. Knowing which transform was applied says nothing about where the match lands, so
// exactness does not make the guard unnecessary here — it is one rule across both modules, and a
// value shorter than this is uncovered on both paths alike.
function secretValueScrubber(secrets: Record<string, string> | undefined): (text: string) => string {
  const pairs = Object.entries(secrets ?? {})
    .filter(([, value]) => value.length >= MIN_VALUE_LENGTH)
    .map(([name, value]) => [escapeCompose(value), `[redacted: value of ${name}]`] as const)
    // Longest first, so a value that contains another is replaced whole rather than gutted by it.
    .sort((a, b) => b[0].length - a[0].length)
  return (text) => pairs.reduce((acc, [needle, marker]) => acc.split(needle).join(marker), text)
}

// Scrubs the document as an OBJECT, before it is serialised, and that ordering is load-bearing:
// once yaml.dump has quoted or line-wrapped a value it is no longer the substring it was, so a
// search over the finished text would quietly find nothing and report a clean file.
function scrubStrings(node: unknown, scrub: (text: string) => string): unknown {
  if (typeof node === 'string') {
    return scrub(node)
  }
  if (Array.isArray(node)) {
    return node.map((item) => scrubStrings(item, scrub))
  }
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, scrubStrings(v, scrub)]))
  }
  return node
}

// The compose document as it enters the deploy log — the surface a user can already open to read
// what a launch did. Nothing is written to disk: the document exists only as part of that entry.
//
// The WHOLE document, not a diff against the previous one. The log keeps a single entry per
// application node, overwritten on every launch, so the base a diff would be read against is
// already gone by the time anyone opens it. And the question a launch record answers is "what
// was compose given", which the document answers on its own and a diff cannot.
//
// It goes FIRST in the entry, ahead of the launch output, because an oversized entry is truncated
// from the front — the end of a build is what says whether it worked.
//
// Two passes before it is stored, because the entry is at rest until someone opens it and
// `getDeployLog`'s redaction only protects the way out:
//
//   1. `secretValueScrubber` over the object — every value this deploy resolved from the store,
//      replaced by the name it came from. Exact, because we know which values and which transform.
//   2. `redactSecrets` over the serialised text — the shared redactor, for a credential that
//      reached the document through some other field entirely: a password inside an `env` URL, or
//      an htpasswd string in a proxy label.
//
// Withheld rather than stored if either pass fails: a document that could not be checked for
// credentials must not be kept, and saying so is a better answer than an empty section. The reader
// is told the check did not happen, not which source failed — `redactSecrets` reads the store AND
// the graph, and the returned line is user-facing text rather than a log line, so naming one of
// them would be a guess printed to a person. The real error goes to `console.error`.
//
// The launch output is unaffected — it is captured either way, and a failure here must not cost the
// record of whether the deploy worked.
async function composeLogSection(
  service: string,
  doc: ComposeDoc,
  secrets: Record<string, string> | undefined,
): Promise<string> {
  try {
    const header =
      `# Compose document for service "${service}", with every value resolved out of the Secrets\n` +
      `# Store replaced by the name it came from — not what compose received byte for byte.\n`
    return header + (await redactSecrets(composeYaml(scrubStrings(doc, secretValueScrubber(secrets)))))
  } catch (err) {
    console.error(`[docker.up] compose document withheld for ${service}; it could not be checked:`, err)
    return '# Compose document withheld: it could not be checked for credentials.\n'
  }
}

// The Deploy tab's data source: the compose document the application node's last start was given,
// followed by that launch's output (a restart has no document, only output). Lives in extension
// storage (DB-backed, per-extension key/value), NOT node.data — it must never show up in
// the graph or anything that reads it.
const DEPLOY_LOG_MAX_BYTES = 256 * 1024

function deployLogStorageKey(applicationNodeId: string): string {
  return `deploy-log:${applicationNodeId}`
}

// The tail of an oversized capture — the end of a long build log (the actual success/failure)
// matters more than the beginning. Shared by the stored entry and the running one synthesised on
// read, so the two cannot disagree about what "truncated" means.
function capDeployText(text: string): { body: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= DEPLOY_LOG_MAX_BYTES) {
    return { body: text, truncated: false }
  }
  return { body: Buffer.from(text, 'utf-8').subarray(-DEPLOY_LOG_MAX_BYTES).toString('utf-8'), truncated: true }
}

// Best-effort: a storage failure must never fail the start/restart action itself. Overwrites the
// previous entry (last launch only) and, when the captured text is oversized, keeps the tail — the
// end of a long build log (the actual success/failure) matters more than the beginning.
async function recordDeployLog(
  applicationNodeId: string,
  action: DeployAction,
  text: string,
  state?: { status: DeployStatus; exitCode?: number; at?: string },
): Promise<void> {
  try {
    const { body, truncated } = capDeployText(text)
    const entry: DeployLogEntry = {
      action,
      at: state?.at ?? new Date().toISOString(),
      text: body,
      truncated,
      status: state?.status ?? 'finished',
      ...(state?.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    }
    await host.storage.set(deployLogStorageKey(applicationNodeId), entry)
  } catch (err) {
    console.error(`[docker.deployLog] failed to store deploy log for ${applicationNodeId}:`, err)
  }
}

// ═══════════════════════════════════════════════════════════════════
// Detached deploys
// ═══════════════════════════════════════════════════════════════════
//
// A compose `up --build` has to outlive the exec that starts it. A one-shot exec is bounded by the
// host's default timeout — two minutes as of 24.09.2026, and nothing here asks for longer — no
// matter who called the action: a button, a graph dispatch or an agent's background task. A build
// that runs past that bound ends `Status: Canceled` mid-way, with no error in the build log, and
// retrying does not help when the long step is a single RUN layer whose partial progress the
// cancellation throws away.
//
// So the compose invocation is spawned into its OWN session (`setsid`, or `nohup` where setsid is
// missing) with its output redirected to a file on the target, and the exec that started it returns
// at once. The exit code lands in a sibling `.rc` file — its existence is what says the deploy
// finished, which is the one fact a poller cannot get wrong.
//
// The state needed to read that back later (which docker node, which paths, the compose document
// captured at launch) lives in extension storage next to the log entry, not in node.data.
const DEPLOY_RUN_DIR = '/tmp/opencroft-deploy'
const DEPLOY_SCRIPT_MARKER = 'OPENCROFT_DEPLOY_SCRIPT_EOF'
const DEPLOY_RC_MARKER = 'OPENCROFT_DEPLOY_RC_EOF'

// How long `dockerUp` waits for a detached deploy before handing it over to the Deploy tab. A
// plain image start finishes well inside this, so the common case keeps a synchronous
// contract: same output, same throw on failure. Only a caller holding a signal waits past it —
// the host hands one to an action it runs as a background task — and it waits for the exit code.
const DEPLOY_SYNC_WAIT_MS = 15_000
const DEPLOY_POLL_INTERVAL_MS = 750
// How often that longer wait asks whether the run has finished. It reads the `.rc` file alone:
// the output, up to DEPLOY_LOG_MAX_BYTES of it, is worth fetching once, at the end.
const DEPLOY_WAIT_POLL_INTERVAL_MS = 5_000
// How much of a failed deploy's output its error carries. An error is read whole — in a toast, or
// in the message an agent's background task ends with — and a build says what went wrong at its
// end. The whole output stays in the Deploy tab.
const DEPLOY_ERROR_TAIL_BYTES = 8 * 1024
// How many checks in a row may fail before a wait gives up on a detached deploy. One failed exec —
// a dropped ssh channel, a busy target — says nothing about the build, which runs on without this
// call; only a run of them means the target is really out of reach.
const DEPLOY_WAIT_MAX_FAILURES = 5

interface DeployRunState {
  dockerNodeId: string
  applicationNodeId: string
  service: string
  // The compose document section, captured at launch — the detached run cannot reproduce it.
  header: string
  logPath: string
  rcPath: string
  startedAt: string
}

function deployRunStorageKey(applicationNodeId: string): string {
  return `deploy-run:${applicationNodeId}`
}

function deployRunPaths(applicationNodeId: string): { logPath: string; rcPath: string; scriptPath: string } {
  const safe = applicationNodeId.replace(/[^A-Za-z0-9_.-]/g, '_')
  return {
    logPath: `${DEPLOY_RUN_DIR}/${safe}.log`,
    rcPath: `${DEPLOY_RUN_DIR}/${safe}.rc`,
    scriptPath: `${DEPLOY_RUN_DIR}/${safe}.sh`,
  }
}

// The ssh-agent key-injection path (a docker context reached over ssh:// with a stored key) wraps
// the command in a script whose EXIT trap tears the agent down — detaching inside that would
// outlive the credentials it needs. Those deploys run synchronously.
function canDetach(ctx: DockerContext): boolean {
  return !(ctx.dockerHost && ctx.targetKeyPath)
}

// The inner script is written to a 0600 file and unlinks ITSELF as its first statement: `sh` has
// the file open by then and reads on from the open descriptor, so the compose document — which
// carries every resolved secret — is never left at rest on the target. It is no more exposed than
// the synchronous path, which passes the same payload on a command line.
function detachedDeployScript(inner: string, paths: { logPath: string; rcPath: string; scriptPath: string }): string {
  const script = [`rm -f ${shellQuote(paths.scriptPath)}`, inner, `echo $? > ${shellQuote(paths.rcPath)}`].join('\n')
  return [
    'set -e',
    'umask 077',
    `mkdir -p ${shellQuote(DEPLOY_RUN_DIR)}`,
    `chmod 700 ${shellQuote(DEPLOY_RUN_DIR)}`,
    `rm -f ${shellQuote(paths.logPath)} ${shellQuote(paths.rcPath)}`,
    `cat > ${shellQuote(paths.scriptPath)} <<'${DEPLOY_SCRIPT_MARKER}'`,
    script,
    DEPLOY_SCRIPT_MARKER,
    `chmod 600 ${shellQuote(paths.scriptPath)}`,
    'if command -v setsid >/dev/null 2>&1; then',
    `  setsid sh ${shellQuote(paths.scriptPath)} > ${shellQuote(paths.logPath)} 2>&1 < /dev/null &`,
    'elif command -v nohup >/dev/null 2>&1; then',
    `  nohup sh ${shellQuote(paths.scriptPath)} > ${shellQuote(paths.logPath)} 2>&1 < /dev/null &`,
    'else',
    `  (trap '' HUP; sh ${shellQuote(paths.scriptPath)} > ${shellQuote(paths.logPath)} 2>&1 < /dev/null) &`,
    'fi',
  ].join('\n')
}

// Read the detached run's output and, if it has finished, its exit code. The log is tail-capped at
// the same size the stored entry is: a build log grows without bound and only its end says whether
// it worked.
async function readDeployRun(ctx: DockerContext, state: DeployRunState): Promise<{ text: string; exitCode?: number }> {
  const script = [
    `cat ${shellQuote(state.rcPath)} 2>/dev/null || true`,
    `echo ${DEPLOY_RC_MARKER}`,
    `tail -c ${DEPLOY_LOG_MAX_BYTES} ${shellQuote(state.logPath)} 2>/dev/null || true`,
  ].join('\n')
  const out = await terminal.exec(ctx, script)
  const at = out.indexOf(DEPLOY_RC_MARKER)
  if (at === -1) {
    return { text: out }
  }
  const text = out.slice(at + DEPLOY_RC_MARKER.length).replace(/^\n/, '')
  return { text, exitCode: parseExitCode(out.slice(0, at)) }
}

// Only whether the detached run has finished, and with what code: the `.rc` file without the log.
async function readDeployExitCode(ctx: DockerContext, state: DeployRunState): Promise<number | undefined> {
  return parseExitCode(await terminal.exec(ctx, `cat ${shellQuote(state.rcPath)} 2>/dev/null || true`))
}

// The `.rc` file's content as an exit code — undefined while the file is missing or still empty.
function parseExitCode(rc: string): number | undefined {
  const parsed = Number.parseInt(rc.trim(), 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

// How a finished detached deploy ends the call that waited for it: quietly on success, otherwise
// with an error carrying the end of the output. Redacted, because an error travels further than the
// Deploy tab does — into a toast, or verbatim into an agent's conversation — and a failing startup
// is exactly when a service prints the value it failed on.
async function endDeploy(exitCode: number, text: string): Promise<void> {
  if (exitCode === 0) {
    return
  }
  const tail = await redactSecrets(Buffer.from(text, 'utf-8').subarray(-DEPLOY_ERROR_TAIL_BYTES).toString('utf-8'))
  throw new Error(`Command exited with code ${exitCode}${tail ? `: ${tail}` : ''}`)
}

// What a wait throws once the target has stopped answering. It must not read as a failed deploy:
// the build may well be going on, and the Deploy tab is still the place that will show its end.
function lostContactError(failures: number, err: unknown): Error {
  return new Error(
    `Lost contact with the deploy after ${failures} failed checks in a row (${err instanceof Error ? err.message : String(err)}). ` +
      'Compose may still be running on the target — the Deploy tab keeps following it.',
  )
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Read the detached run and, if it has finished, finalise it. A run that is still going is NEVER
// written: every reader of the Deploy tab polls, and a poll that wrote 'running' could land after
// the finaliser had written 'finished' — leaving the tab on "running" for good, with nothing left
// to correct it. So a running entry is synthesised from the target on each read (see
// getDeployLog), and storage only ever holds the launch placeholder and the final entry.
async function pollDeployRun(state: DeployRunState): Promise<{ text: string; exitCode?: number }> {
  const ctx = await resolveDockerContext(state.dockerNodeId)
  const run = await readDeployRun(ctx, state)
  if (run.exitCode !== undefined) {
    await finaliseDeployRun(state, run.text, run.exitCode)
  }
  return run
}

// Write the final entry — but only while the run marker still names THIS run. Two finalisers of the
// same run (the tab and a waiting background task) write the same entry, so either order is fine,
// and the second, finding the marker gone, writes nothing. A marker naming a different run means a
// newer deploy has started on the application; its placeholder must not be overwritten with this
// one's result, nor its marker deleted.
async function finaliseDeployRun(state: DeployRunState, text: string, exitCode: number): Promise<void> {
  const key = deployRunStorageKey(state.applicationNodeId)
  const current = await host.storage.get<DeployRunState>(key)
  if (!current || current.startedAt !== state.startedAt) {
    return
  }
  await recordDeployLog(state.applicationNodeId, 'start', `${state.header}\n${text}`, {
    status: 'finished',
    exitCode,
    at: state.startedAt,
  })
  await host.storage.delete(key)
  invalidatePs(state.dockerNodeId)
}

// Redacted on read, like dockerServiceLogs: the entry holds a container's own launch output, which
// carries the risk of a startup error printing the value it failed on and is captured as it came.
// The compose document ahead of it is redacted at capture as well. The same function both times;
// there is no second redactor anywhere on this path.
//
// That asymmetry is a decision, not an oversight, and the reason is what makes it one. Redaction on
// READ improves retroactively: widen the redactor and every entry ever stored is covered the next
// time someone opens it, which is the only thing protecting entries written before the redactor
// knew what to look for. Redaction at CAPTURE is permanent and lossy — what it removes is gone, out
// of reach of a later reader with a better redactor, including whatever it removed by mistake. So
// capture is spent where a credential is KNOWN to land: the compose document is built out of
// resolved secret values, and can carry a URL password from an `env` field. The launch output is
// arbitrary container text where a credential is possible rather than certain, so it keeps the pass
// that can still get better instead of the one that cannot.
//
// Every reader of this key goes through this function. Adding another one means adding this call.
export async function getDeployLog(applicationNodeId: string): Promise<DeployLogEntry | null> {
  // A detached deploy keeps growing after the action returned. While it runs, the entry is read
  // live from the target and returned WITHOUT being stored (see pollDeployRun for why); the read
  // that finds the exit code finalises it. Best-effort: an unreachable target shows the entry
  // stored so far rather than an error.
  const run = await host.storage.get<DeployRunState>(deployRunStorageKey(applicationNodeId))
  if (run) {
    try {
      const live = await pollDeployRun(run)
      if (live.exitCode === undefined) {
        const { body, truncated } = capDeployText(`${run.header}\n${live.text}`)
        return { action: 'start', at: run.startedAt, text: await redactSecrets(body), truncated, status: 'running' }
      }
    } catch (err) {
      console.error(`[docker.deployLog] failed to read detached deploy for ${applicationNodeId}:`, err)
    }
  }
  const entry = await host.storage.get<DeployLogEntry>(deployLogStorageKey(applicationNodeId))
  return entry ? { ...entry, text: await redactSecrets(entry.text) } : null
}

// ═══════════════════════════════════════════════════════════════════
// Watchable output — what the Deploy and Logs tabs stream
// ═══════════════════════════════════════════════════════════════════

/** A command to run as a watchable job, and the context to run it on. */
export interface JobSpec {
  ctx: DockerContext
  command: string
  args: string[]
  env?: Record<string, string>
  stdin?: string
}

// A job needs a transport with a streaming channel of its own, which only local and ssh have. A
// Context input carrying a stored key is refused as well: its ssh agent is set up by a one-shot
// script and lives only as long as that script, which is also why such deploys run synchronously
// (canDetach).
function canStream(ctx: DockerContext): boolean {
  return (ctx.type === 'local' || ctx.type === 'ssh') && canDetach(ctx)
}

// The detached run still going for this application, finalised first if it has ended. An
// unreachable target leaves the run standing: its end is not known yet, and the next call asks
// again.
async function activeDeployRun(applicationNodeId: string): Promise<DeployRunState | null> {
  const run = await host.storage.get<DeployRunState>(deployRunStorageKey(applicationNodeId))
  if (!run) {
    return null
  }
  try {
    const ctx = await resolveDockerContext(run.dockerNodeId)
    if ((await readDeployExitCode(ctx, run)) === undefined) {
      return run
    }
    await pollDeployRun(run)
    return null
  } catch (err) {
    console.error(`[docker.deployLog] failed to check detached deploy for ${applicationNodeId}:`, err)
    return run
  }
}

/** The last deploy's entry without its text — what the Deploy tab's header shows — or null. */
export async function deployStatus(applicationNodeId: string): Promise<Omit<DeployLogEntry, 'text'> | null> {
  await activeDeployRun(applicationNodeId)
  const entry = await host.storage.get<DeployLogEntry>(deployLogStorageKey(applicationNodeId))
  if (!entry) {
    return null
  }
  const { text: _text, ...status } = entry
  return status
}

/**
 * How to follow the application's deploy while it runs, or null when there is nothing to follow:
 * no detached run is going, or its context cannot stream. The run is finalised first if it has
 * just ended.
 */
export async function deployFollowSpec(applicationNodeId: string): Promise<JobSpec | null> {
  const run = await activeDeployRun(applicationNodeId)
  if (!run) {
    return null
  }
  const ctx = await resolveDockerContext(run.dockerNodeId)
  if (!canStream(ctx)) {
    return null
  }
  // The same tail the stored entry keeps.
  return { ctx, command: 'sh', args: ['-c', deployFollowScript(run, DEPLOY_LOG_MAX_BYTES)], stdin: `${run.header}\n` }
}

/** How many lines of a container's log the Logs tab starts from. */
export const LOGS_TAIL_LINES = 500

/** Whether a container's log can still grow (`running`), is complete (`stopped`), or there is none. */
export interface ContainerLogState {
  state: 'running' | 'stopped' | 'missing'
  /** The daemon's own word for it — `running`, `exited`, `restarting`, … — empty when missing. */
  status: string
}

// Asked of the daemon directly rather than read from the ps cache: the cache reports an
// unreachable daemon as "no containers", and the Logs tab has to tell those two apart.
export async function containerLogState(dockerNodeId: string, container: string): Promise<ContainerLogState> {
  const ctx = await resolveDockerContext(dockerNodeId)
  // `container inspect`, not bare `inspect`: an image, volume or network of the same name would be
  // inspected instead.
  const result = await dockerCmdResult(ctx, ['container', 'inspect', '--format', '{{.State.Status}}', container])
  if (result.exitCode !== 0 && /no such (object|container)/i.test(result.stderr)) {
    return { state: 'missing', status: '' }
  }
  const status = stdoutOrThrow(result).trim()
  // A restarting or paused container keeps its log open; `docker logs -f` follows it.
  const growing = status === 'running' || status === 'restarting' || status === 'paused'
  return { state: growing ? 'running' : 'stopped', status }
}

/**
 * `docker logs` for one container as a job — following it when `follow` is set — or null when the
 * docker node's context cannot stream.
 *
 * The docker binary is the job's own process, not a child of a shell, so stopping the job stops
 * the follow. A preflight goes through the ordinary failure-driven call first, for the same reason
 * dockerUp's does: a rootless socket is found by a call that failed on the default one, and a
 * streamed command cannot be retried.
 */
export async function containerLogsSpec(dockerNodeId: string, container: string, follow: boolean): Promise<JobSpec | null> {
  const ctx = await resolveDockerContext(dockerNodeId)
  if (!canStream(ctx)) {
    return null
  }
  stdoutOrThrow(await dockerCmdResult(ctx, ['version', '--format', '{{.Server.Version}}']))
  const { effectiveCtx } = withDetectedSocket(ctx)
  const args = [...dockerHostArgs(effectiveCtx), 'logs', ...(follow ? ['-f'] : []), '--tail', String(LOGS_TAIL_LINES), container]
  return {
    ctx: effectiveCtx,
    command: 'docker',
    args,
    ...(effectiveCtx.dockerHost ? { env: { DOCKER_HOST: effectiveCtx.dockerHost } } : {}),
  }
}

// ═══════════════════════════════════════════════════════════════════
// Docker availability check
// ═══════════════════════════════════════════════════════════════════

export interface DockerCheckParams {
  dockerNodeId: string
}

export async function dockerCheck(params: DockerCheckParams): Promise<boolean> {
  try {
    const ctx = await resolveDockerContext(params.dockerNodeId)
    const out = await dockerCmd(ctx, ['version', '--format', '{{.Server.Version}}'])
    return out.trim().length > 0
  } catch {
    return false
  }
}

export type DockerProbeReason = 'host-key' | 'auth' | 'unreachable' | 'docker' | 'unknown'

export interface DockerProbeResult {
  ok: boolean
  version?: string
  reason?: DockerProbeReason
  message?: string
}

// Turn a raw docker/ssh failure into an actionable reason. The ssh:// transport
// shells out to OpenSSH, so its failure modes (host-key, auth, unreachable)
// surface as text we can pattern-match.
function classifyDockerError(raw: string): { reason: DockerProbeReason; message: string } {
  const e = raw.toLowerCase()
  if (
    e.includes('host key verification failed') ||
    e.includes('remote host identification has changed') ||
    e.includes('no matching host key')
  ) {
    return { reason: 'host-key', message: 'Host key not trusted. Accept the host key on the Server node, then retry.' }
  }
  if (
    e.includes('permission denied') ||
    e.includes('authentication failed') ||
    e.includes('no supported authentication') ||
    e.includes('too many authentication failures') ||
    e.includes('publickey')
  ) {
    return {
      reason: 'auth',
      message: 'SSH authentication failed. Install a key on the server or check its credentials.',
    }
  }
  if (
    e.includes('could not resolve') ||
    e.includes('connection refused') ||
    e.includes('connection timed out') ||
    e.includes('operation timed out') ||
    e.includes('no route to host') ||
    e.includes('network is unreachable')
  ) {
    return {
      reason: 'unreachable',
      message: 'Could not reach the host. Check the address, port, and that it is online.',
    }
  }
  if (
    e.includes('cannot connect to the docker daemon') ||
    e.includes('is the docker daemon running') ||
    e.includes('command not found') ||
    e.includes('executable file not found')
  ) {
    return { reason: 'docker', message: 'Reached the host, but Docker is not available there.' }
  }
  const lastLine = raw.trim().split('\n').pop()?.trim()
  return { reason: 'unknown', message: lastLine || 'Connection failed' }
}

// Probe the connection and report a structured, actionable status (vs. the
// boolean dockerCheck), so the node can show *why* a connection failed.
export async function dockerProbe(params: DockerCheckParams): Promise<DockerProbeResult> {
  try {
    const ctx = await resolveDockerContext(params.dockerNodeId)
    const version = (await dockerCmd(ctx, ['version', '--format', '{{.Server.Version}}'])).trim()
    if (!version) {
      return { ok: false, reason: 'docker', message: 'Connected, but Docker reported no server version.' }
    }
    return { ok: true, version }
  } catch (err) {
    const { reason, message } = classifyDockerError(err instanceof Error ? err.message : String(err))
    return { ok: false, reason, message }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Container queries
// ═══════════════════════════════════════════════════════════════════

export interface ContainerInfo {
  id: string
  name: string
  service: string
  status: string
  /** The daemon's word for the state: `running`, `restarting`, `exited`, … */
  state: string
  running: boolean
}

export interface DockerPsParams {
  dockerNodeId: string
  service?: string
}

const PS_CACHE_TTL = 10_000

interface PsCacheEntry {
  containers: ContainerInfo[]
  expires: number
  inflight?: Promise<ContainerInfo[]>
}

const psCache = new Map<string, PsCacheEntry>()

async function fetchPs(ctx: DockerContext, dockerNodeId: string): Promise<ContainerInfo[]> {
  const args = [
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--format',
    '{{.ID}}\\t{{.Names}}\\t{{.Label "com.docker.compose.service"}}\\t{{.Status}}\\t{{.State}}',
  ]
  let out = ''
  try {
    out = await dockerCmd(ctx, args)
  } catch (err) {
    console.error(`[docker.ps] failed for ${dockerNodeId}:`, err)
    return []
  }
  if (!out.trim()) {
    return []
  }
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [id, name, service, status, state] = line.split('\t')
      return { id, name, service, status, state, running: state === 'running' }
    })
}

function invalidatePs(dockerNodeId: string): void {
  psCache.delete(dockerNodeId)
  const fn = (globalThis as { __dockerPsInvalidated?: (id: string) => void }).__dockerPsInvalidated
  if (fn) {
    fn(dockerNodeId)
  }
}

async function getPsCached(ctx: DockerContext, dockerNodeId: string): Promise<ContainerInfo[]> {
  const entry = psCache.get(dockerNodeId)
  if (entry && entry.expires > Date.now()) {
    return entry.containers
  }
  if (entry?.inflight) {
    return entry.inflight
  }
  const inflight = fetchPs(ctx, dockerNodeId).then((containers) => {
    psCache.set(dockerNodeId, { containers, expires: Date.now() + PS_CACHE_TTL })
    return containers
  })
  psCache.set(dockerNodeId, { containers: entry?.containers ?? [], expires: 0, inflight })
  return inflight
}

export async function dockerPs(params: DockerPsParams): Promise<ContainerInfo[]> {
  // Status is derived purely from the daemon (label-filtered `docker ps -a` in fetchPs), never
  // from a local compose file, so labelled containers are found whether or not this host has ever
  // written one — after a wiped cacheDir included.
  //
  // fetchPs already catches the one call that can fail against a dead host, but resolving the
  // context itself (e.g. the docker node was deleted concurrently) is not otherwise guarded here —
  // wrap the whole thing so this action can never reject, matching dockerCheck/dockerProbe below.
  try {
    const ctx = await resolveDockerContext(params.dockerNodeId)
    const all = await getPsCached(ctx, params.dockerNodeId)
    if (params.service) {
      return all.filter((c) => c.service === params.service)
    }
    return all
  } catch (err) {
    console.error(`[docker.ps] failed for ${params.dockerNodeId}:`, err)
    return []
  }
}

// ═══════════════════════════════════════════════════════════════════
// Full container/image listings (any container/image on the host)
// ═══════════════════════════════════════════════════════════════════

export interface DockerListParams {
  dockerNodeId: string
}

export interface ContainerListItem {
  id: string
  name: string
  image: string
  status: string
  state: string
  created: string
  ports: string
  running: boolean
}

export async function dockerListContainers(params: DockerListParams): Promise<ContainerListItem[]> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const args = [
    'ps',
    '-a',
    '--format',
    '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}\\t{{.CreatedAt}}\\t{{.Ports}}',
  ]
  let out = ''
  try {
    out = await dockerCmd(ctx, args)
  } catch (err) {
    console.error(`[docker.listContainers] failed for ${params.dockerNodeId}:`, err)
    return []
  }
  if (!out.trim()) {
    return []
  }
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [id, name, image, status, state, created, ports] = line.split('\t')
      return { id, name, image, status, state, created, ports: ports ?? '', running: state === 'running' }
    })
}

export interface ImageListItem {
  id: string
  repository: string
  tag: string
  size: string
  created: string
}

export interface DockerContainerActionParams {
  dockerNodeId: string
  containerId: string
}

export async function dockerStartContainer(params: DockerContainerActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  await dockerCmd(ctx, ['start', params.containerId])
  invalidatePs(params.dockerNodeId)
}

export async function dockerStopContainer(params: DockerContainerActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  await dockerCmd(ctx, ['stop', params.containerId])
  invalidatePs(params.dockerNodeId)
}

export async function dockerRestartContainer(params: DockerContainerActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  await dockerCmd(ctx, ['restart', params.containerId])
  invalidatePs(params.dockerNodeId)
}

export async function dockerRemoveContainer(params: DockerContainerActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  await dockerCmd(ctx, ['rm', '-f', params.containerId])
  invalidatePs(params.dockerNodeId)
}

export interface DockerImageActionParams {
  dockerNodeId: string
  imageId: string
}

export async function dockerRemoveImage(params: DockerImageActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  await dockerCmd(ctx, ['rmi', '-f', params.imageId])
}

export interface DockerImagePullParams {
  dockerNodeId: string
  reference: string
}

export async function dockerPullImage(params: DockerImagePullParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  await ensureRegistryLogin(ctx, params.dockerNodeId, params.reference)
  await dockerCmd(ctx, ['pull', params.reference])
}

export interface DockerCheckImageUpdateParams {
  dockerNodeId: string
  image: string
}

export interface DockerCheckImageUpdateResult {
  localDigest?: string
  remoteDigest?: string
  hasUpdate: boolean
}

async function readLocalDigest(ctx: DockerContext, image: string): Promise<string | undefined> {
  try {
    const out = await dockerCmd(ctx, ['image', 'inspect', image, '--format', '{{join .RepoDigests "\\n"}}'])
    const first = out.trim().split('\n')[0]
    if (first.includes('@')) {
      return first.split('@')[1]
    }
  } catch {
    return undefined
  }
  return undefined
}

async function readRemoteDigest(ctx: DockerContext, image: string): Promise<string | undefined> {
  try {
    const out = await dockerCmd(ctx, ['buildx', 'imagetools', 'inspect', image])
    const match = out.match(/^Digest:\s+(sha256:[a-f0-9]+)/m)
    if (match) {
      return match[1]
    }
  } catch {
    return undefined
  }
  return undefined
}

export async function dockerCheckImageUpdate(
  params: DockerCheckImageUpdateParams,
): Promise<DockerCheckImageUpdateResult> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  await ensureRegistryLogin(ctx, params.dockerNodeId, params.image)
  const [localDigest, remoteDigest] = await Promise.all([
    readLocalDigest(ctx, params.image),
    readRemoteDigest(ctx, params.image),
  ])
  const hasUpdate = !!localDigest && !!remoteDigest && localDigest !== remoteDigest
  return { localDigest, remoteDigest, hasUpdate }
}

export async function dockerListImages(params: DockerListParams): Promise<ImageListItem[]> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const args = ['images', '--format', '{{.ID}}\\t{{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}']
  let out = ''
  try {
    out = await dockerCmd(ctx, args)
  } catch (err) {
    console.error(`[docker.listImages] failed for ${params.dockerNodeId}:`, err)
    return []
  }
  if (!out.trim()) {
    return []
  }
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [id, repository, tag, size, created] = line.split('\t')
      return { id, repository, tag, size, created }
    })
}

// ═══════════════════════════════════════════════════════════════════
// Named volumes (opencroft-prefixed, hidden from the client like the
// compose project prefix already is on container names)
// ═══════════════════════════════════════════════════════════════════

const VOLUME_PREFIX = 'opencroft-'

// Per-dockerNodeId cache of the daemon's data root (`docker info`'s DockerRootDir), used to build
// directMount bind-mount sources. Rarely if ever changes for a given daemon, so cached the same
// way as the detected rootless socket.
const dataRootCache = new Map<string, string>()

async function resolveDockerDataRoot(ctx: DockerContext, dockerNodeId: string): Promise<string> {
  const cached = dataRootCache.get(dockerNodeId)
  if (cached) {
    return cached
  }
  const out = (await dockerCmd(ctx, ['info', '-f', '{{.DockerRootDir}}'])).trim()
  if (!out) {
    throw new Error('Could not resolve the docker data root (`docker info` returned an empty DockerRootDir)')
  }
  dataRootCache.set(dockerNodeId, out)
  return out
}

// directMount builds a raw filesystem path, unlike volume.subpath (which docker validates
// internally) — reject any ".." segment so a subpath can't escape the volume's own _data dir.
function validateSubpath(subpath: string): void {
  if (subpath.split('/').some((segment) => segment === '..')) {
    throw new Error(`Invalid subpath "${subpath}": ".." path segments are not allowed`)
  }
}

// Application data carries the friendly (unprefixed) volume name the client shows, e.g.
// "test:/data" — the real docker volume is "opencroft-test". Re-add the prefix on the way into a
// compose doc so the mount source and the external-volume declaration both match the volume that
// actually exists; otherwise compose fails with `external volume "test" not found`.
//
// A subpath needs compose's long (mapping) volume syntax — the short "name:target" form has no
// way to express "mount just this subdirectory of the volume". Entries without a subpath stay in
// the short form.
//
// directMount is a different, opt-in mechanism entirely: instead of referencing the volume by
// name, it bind-mounts the volume's actual storage path on the host (under the daemon's data
// root, only valid for the default "local" driver — which is all dockerCreateVolume ever creates).
// This is the only way to mount an individual *file* out of a volume; volume.subpath only handles
// directories, and only on Docker Engine 25+.
async function namedVolumeMountEntry(
  v: AttachedVolume,
  ctx: DockerContext,
  dockerNodeId: string,
): Promise<string | Record<string, unknown>> {
  const source = VOLUME_PREFIX + v.volumeName
  if (v.subpath) {
    validateSubpath(v.subpath)
  }
  if (v.directMount) {
    const dataRoot = await resolveDockerDataRoot(ctx, dockerNodeId)
    const hostPath = [dataRoot.replace(/\/+$/, ''), 'volumes', source, '_data', v.subpath ?? '']
      .filter(Boolean)
      .join('/')
    return `${hostPath}:${v.containerPath}${v.readOnly ? ':ro' : ''}`
  }
  if (!v.subpath) {
    return `${source}:${v.containerPath}${v.readOnly ? ':ro' : ''}`
  }
  const entry: Record<string, unknown> = {
    type: 'volume',
    source,
    target: v.containerPath,
    volume: { subpath: v.subpath },
  }
  if (v.readOnly) {
    entry.read_only = true
  }
  return entry
}

export interface VolumeListItem {
  name: string
  created: string
}

interface VolumeInspectEntry {
  Name: string
  CreatedAt?: string
}

/**
 * The volumes a person is about to pick from, with no size among them.
 *
 * **A volume's size is not a property the daemon holds; it is a walk of the volume's contents.**
 * `volume ls` and one `volume inspect` over every volume read only the daemon's own records, while
 * `system df -v`, which reports sizes, walks the filesystem every time it is asked, with no warm
 * cache to lean on — a cost that grows with everything stored, in a path somebody is watching a
 * spinner in.
 *
 * That is why a size does not come back some cheaper way here — there is no cheaper way. Any
 * number would be another traversal, unbounded in the size of what is stored, on a list that has
 * to open now. A size belongs to an action somebody takes deliberately for one volume, not to
 * opening a tab.
 */
export async function dockerListVolumes(params: DockerListParams): Promise<VolumeListItem[]> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const lsOut = await dockerCmd(ctx, ['volume', 'ls', '--format', '{{.Name}}'])
  const names = lsOut
    .split('\n')
    .map((l) => l.trim())
    .filter((n) => n.startsWith(VOLUME_PREFIX))
  if (names.length === 0) {
    return []
  }
  const inspectOut = await dockerCmd(ctx, ['volume', 'inspect', '--format', '{{json .}}', ...names])
  const created = new Map<string, string>()
  for (const line of inspectOut.trim().split('\n').filter(Boolean)) {
    const entry = JSON.parse(line) as VolumeInspectEntry
    created.set(entry.Name, entry.CreatedAt ?? '')
  }
  return names
    .map((n) => n.slice(VOLUME_PREFIX.length))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      created: created.get(VOLUME_PREFIX + name) ?? '',
    }))
}

export interface DockerVolumeNameParams {
  dockerNodeId: string
  name: string
}

function requireVolumeName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) {
    throw new Error(`Invalid volume name: "${name}"`)
  }
  return trimmed
}

export async function dockerCreateVolume(params: DockerVolumeNameParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const name = requireVolumeName(params.name)
  await dockerCmd(ctx, ['volume', 'create', VOLUME_PREFIX + name])
}

export async function dockerRemoveVolume(params: DockerVolumeNameParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const name = requireVolumeName(params.name)
  await dockerCmd(ctx, ['volume', 'rm', '-f', VOLUME_PREFIX + name])
}

// ═══════════════════════════════════════════════════════════════════
// Service lifecycle
// ═══════════════════════════════════════════════════════════════════

interface NetworkConfig {
  name: string
  driver: string
  external: boolean
}

export interface DockerUpParams {
  dockerNodeId: string
  applicationNodeId: string
  service: string
  image: string
  ports: string
  env: string
  secrets?: Record<string, string>
  volumes: string
  command: string
  entrypoint?: string
  ipc?: string
  shmSize?: string
  restart: string
  replicas: number
  networks: NetworkConfig[]
  containerName?: string
  workingDir?: string
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
  labels?: string
  namedVolumes?: string
  logDriver?: string
  logOpts?: string
}

function linesToArray(s: string): string[] {
  return (s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function escapeCompose(value: string): string {
  return value.split('$').join('$$')
}

async function buildServiceDef(params: DockerUpParams, ctx: DockerContext): Promise<Record<string, unknown>> {
  const svc: Record<string, unknown> = {}

  // Image or build
  if (params.buildContext) {
    svc.build = params.buildDockerfile
      ? { context: params.buildContext, dockerfile: params.buildDockerfile }
      : params.buildContext
    if (params.image) {
      svc.image = params.image
    }
  } else if (params.image) {
    svc.image = params.image
  }

  if (params.containerName) {
    svc.container_name = params.containerName
  }
  if (params.workingDir) {
    svc.working_dir = params.workingDir
  }

  const ports = linesToArray(params.ports)
  if (ports.length > 0) {
    svc.ports = ports
  }
  const envLines = linesToArray(params.env)
  const environment: Record<string, string> = {}
  for (const line of envLines) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      environment[line.slice(0, eq)] = escapeCompose(line.slice(eq + 1))
    }
  }
  for (const [name, value] of Object.entries(params.secrets ?? {})) {
    environment[name] = escapeCompose(value)
  }
  if (Object.keys(environment).length > 0) {
    svc.environment = environment
  }
  const namedVolumeMounts = await Promise.all(
    parseNamedVolumes(params.namedVolumes || '').map((v) => namedVolumeMountEntry(v, ctx, params.dockerNodeId)),
  )
  const vols: (string | Record<string, unknown>)[] = [...linesToArray(params.volumes), ...namedVolumeMounts]
  if (vols.length > 0) {
    svc.volumes = vols
  }
  if (params.entrypoint) {
    const parts = params.entrypoint.split(/\s+/).filter(Boolean).map(escapeCompose)
    svc.entrypoint = parts
    if (params.command) {
      svc.command = [escapeCompose(params.command)]
    }
  } else if (params.command) {
    svc.command = escapeCompose(params.command)
  }
  if (params.ipc) {
    svc.ipc = params.ipc
  }
  if (params.shmSize) {
    svc.shm_size = params.shmSize
  }
  if (params.restart) {
    svc.restart = params.restart
  }

  // NOTE: params.dependsOn is deliberately NOT emitted. Compose docs are single-service, and
  // compose rejects a doc whose depends_on references a service it doesn't define. Dependency
  // ordering is the responsibility of starting each application node (each service is up'd
  // independently anyway).

  // Security
  if (params.init) {
    svc.init = true
  }
  if (params.readOnly) {
    svc.read_only = true
  }
  const groups = (params.groupAdd || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (groups.length > 0) {
    svc.group_add = groups
  }
  const secOpts = linesToArray(params.securityOpts || '')
  if (secOpts.length > 0) {
    svc.security_opt = secOpts
  }
  const tmpfsMounts = linesToArray(params.tmpfs || '')
  if (tmpfsMounts.length > 0) {
    svc.tmpfs = tmpfsMounts
  }
  const devices = linesToArray(params.devices || '')
  if (devices.length > 0) {
    svc.devices = devices
  }

  // Logging: per-container log driver + options (e.g. rotation). Docker defaults to the daemon's
  // log driver with no options, so this is opt-in — only emitted when the node declares a driver
  // or options. Reproduces create-time --log-driver/--log-opt, which a plain deploy otherwise drops.
  const logOptions: Record<string, string> = {}
  const invalidLogOpts: string[] = []
  for (const line of linesToArray(params.logOpts || '')) {
    const idx = line.indexOf('=')
    if (idx > 0) {
      logOptions[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    } else {
      invalidLogOpts.push(line)
    }
  }
  // A malformed line (missing or empty key) would otherwise be silently dropped, leaving the
  // container without the log config the operator believed they declared — the exact failure this
  // field exists to prevent. Reject the deploy loudly rather than guess.
  if (invalidLogOpts.length > 0) {
    throw new Error(
      `Invalid log option line(s); each must be KEY=VALUE (e.g. max-size=50m): ${invalidLogOpts
        .map((l) => JSON.stringify(l))
        .join(', ')}`,
    )
  }
  if (params.logDriver || Object.keys(logOptions).length > 0) {
    const logging: Record<string, unknown> = {}
    if (params.logDriver) {
      logging.driver = params.logDriver
    }
    if (Object.keys(logOptions).length > 0) {
      logging.options = logOptions
    }
    svc.logging = logging
  }

  // Healthcheck
  if (params.healthcheckTest) {
    const hc: Record<string, unknown> = {
      test: ['CMD-SHELL', escapeCompose(params.healthcheckTest)],
    }
    if (params.healthcheckInterval) {
      hc.interval = params.healthcheckInterval
    }
    if (params.healthcheckTimeout) {
      hc.timeout = params.healthcheckTimeout
    }
    if (params.healthcheckRetries && params.healthcheckRetries > 0) {
      hc.retries = params.healthcheckRetries
    }
    if (params.healthcheckStartPeriod) {
      hc.start_period = params.healthcheckStartPeriod
    }
    svc.healthcheck = hc
  }

  // Deploy (replicas + GPU + resource limits)
  const replicas = params.replicas || 1
  const deploy: Record<string, unknown> = {}
  if (replicas > 1) {
    deploy.replicas = replicas
  }
  const resources: Record<string, unknown> = {}
  const limits: Record<string, unknown> = {}
  if (params.requirementMemory) {
    limits.memory = params.requirementMemory
  }
  if (params.requirementCpu) {
    limits.cpus = params.requirementCpu
  }
  if (Object.keys(limits).length > 0) {
    resources.limits = limits
  }
  if (params.gpu) {
    resources.reservations = {
      devices: [
        {
          driver: 'nvidia',
          count: 'all',
          capabilities: ['gpu'],
        },
      ],
    }
  }
  if (Object.keys(resources).length > 0) {
    deploy.resources = resources
  }
  if (Object.keys(deploy).length > 0) {
    svc.deploy = deploy
  }

  // Labels: auto-generated Traefik labels + user-defined, user wins on conflict
  const labels: Record<string, string> = {}
  if (params.proxyDomain) {
    const router = params.service
    labels['traefik.enable'] = 'true'
    labels[`traefik.http.routers.${router}.rule`] = `Host(\`${params.proxyDomain}\`)`
    if (params.proxyEntrypoint) {
      labels[`traefik.http.routers.${router}.entrypoints`] = params.proxyEntrypoint
    }
    if (params.proxyTls) {
      labels[`traefik.http.routers.${router}.tls`] = 'true'
      labels[`traefik.http.routers.${router}.tls.certresolver`] = 'letsencrypt'
    }
    if (params.proxyPort && params.proxyPort > 0) {
      labels[`traefik.http.services.${router}.loadbalancer.server.port`] = String(params.proxyPort)
    }
    const middlewares: string[] = []
    if (params.proxyBasicAuth) {
      labels[`traefik.http.middlewares.${router}-auth.basicauth.users`] = escapeCompose(params.proxyBasicAuth)
      middlewares.push(`${router}-auth`)
    }
    // Compress responses at the proxy — upstreams serve identity-encoded
    // bodies. Allow-list of text-like types only: media and other binary
    // formats are already codec-compressed (zero gain, wasted CPU), and
    // compressing a streamed body (SSE, chunked audio) buffers the chunks,
    // delaying delivery. A type absent from the list passes through as-is.
    labels[`traefik.http.middlewares.${router}-compress.compress`] = 'true'
    labels[`traefik.http.middlewares.${router}-compress.compress.includedcontenttypes`] = [
      'text/html',
      'text/css',
      'text/plain',
      'text/javascript',
      'application/javascript',
      'application/json',
      'application/manifest+json',
      'application/xml',
      'image/svg+xml',
      'application/wasm',
    ].join(',')
    middlewares.push(`${router}-compress`)
    labels[`traefik.http.routers.${router}.middlewares`] = middlewares.join(',')
  }
  for (const line of linesToArray(params.labels || '')) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      labels[line.slice(0, eq)] = escapeCompose(line.slice(eq + 1))
    }
  }
  if (Object.keys(labels).length > 0) {
    svc.labels = labels
  }

  if (params.networks && params.networks.length > 0) {
    svc.networks = params.networks.map((n) => n.name)
  }
  return svc
}

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock'

// Resolve the real host-side socket path to bind-mount into a container when `exposeHostDocker`
// is set. Prefers a named CLI context's endpoint when configured; otherwise reuses whatever
// `probeDockerSocket`/`dockerCmd` already learned about this dockerNodeId (or probes fresh) so a
// rootless daemon's actual socket gets bind-mounted instead of the rootful default, which — if
// wrong — bind-mounts a nonexistent path and the container sees an empty directory, not a socket.
async function resolveHostDockerSocket(ctx: DockerContext): Promise<string> {
  if (ctx.dockerHost) {
    return DEFAULT_DOCKER_SOCKET
  }
  if (ctx.contextName) {
    try {
      const out = (
        await dockerCmd(ctx, ['context', 'inspect', ctx.contextName, '--format', '{{.Endpoints.docker.Host}}'])
      ).trim()
      const match = out.match(/^unix:\/\/(\/.*)$/)
      if (match) {
        return match[1].replace(/\/{2,}/g, '/')
      }
    } catch {
      // fall through to the generic probe below
    }
  }
  if (ctx.dockerNodeId) {
    const cached = detectedSocketCache.get(ctx.dockerNodeId)
    if (cached) {
      return cached
    }
  }
  const detected = await probeDockerSocket(ctx)
  if (detected) {
    if (ctx.dockerNodeId) {
      detectedSocketCache.set(ctx.dockerNodeId, detected)
    }
    return detected
  }
  return DEFAULT_DOCKER_SOCKET
}

// Build a self-contained single-service compose doc from the action params. Only this service's
// own networks are declared: services sharing a network each declare it, and compose reuses the
// already-created project network on subsequent ups.
async function buildComposeDoc(params: DockerUpParams, ctx: DockerContext): Promise<ComposeDoc> {
  const doc: ComposeDoc = { services: { [params.service]: await buildServiceDef(params, ctx) } }
  if (params.networks && params.networks.length > 0) {
    doc.networks = {}
    for (const net of params.networks) {
      const netDef: Record<string, unknown> = {}
      if (net.driver) {
        netDef.driver = net.driver
      }
      if (net.external) {
        netDef.external = true
      }
      doc.networks[net.name] = netDef
    }
  }
  // directMount entries are bind mounts, not named-volume references — they don't belong in the
  // external-volume declarations (compose would have nothing to match them against anyway).
  const namedVolumeNames = parseNamedVolumes(params.namedVolumes || '')
    .filter((v) => !v.directMount)
    .map((v) => VOLUME_PREFIX + v.volumeName)
  if (namedVolumeNames.length > 0) {
    doc.volumes = {}
    for (const name of namedVolumeNames) {
      doc.volumes[name] = { external: true }
    }
  }
  return doc
}

// `signal` is the one the host hands an action it runs as a background task: with it, the call
// waits for a detached deploy to exit rather than handing it to the Deploy tab.
export async function dockerUp(params: DockerUpParams, signal?: AbortSignal): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  if (params.exposeHostDocker) {
    const sock = await resolveHostDockerSocket(ctx)
    params.volumes = [params.volumes, `${sock}:${DEFAULT_DOCKER_SOCKET}`].filter(Boolean).join('\n')
  }
  const doc = await buildComposeDoc(params, ctx)
  const content = composeDocContent(params.service, doc)
  const upArgs = ['up', '-d']
  if (params.buildContext) {
    upArgs.push('--build')
  }
  upArgs.push(params.service)
  if (params.image) {
    await ensureRegistryLogin(ctx, params.dockerNodeId, params.image)
  }
  const header = await composeLogSection(params.service, doc, params.secrets)

  if (!canDetach(ctx)) {
    const result = await composeCmd(ctx, content, upArgs)
    await recordDeployLog(params.applicationNodeId, 'start', `${header}\n${combinedOutput(result)}`)
    invalidatePs(params.dockerNodeId)
    stdoutOrThrow(result)
    return
  }

  // The socket detection every other call does on failure cannot run once the command is detached,
  // so a cheap preflight goes through the SAME failure-driven path first: `docker version` against
  // the daemon the plain call reaches, falling back to probing for a socket only when that call
  // fails on the socket, as every other call does. Probing up front instead would change WHICH
  // daemon a healthy host is deployed to (a host with both a rootful daemon and a rootless socket would flip
  // to rootless), and cache that for every later call on the node.
  const preflight = await dockerCmdResult(ctx, ['version', '--format', '{{.Server.Version}}'])
  if (preflight.exitCode !== 0) {
    await recordDeployLog(params.applicationNodeId, 'start', `${header}\n${combinedOutput(preflight)}`)
    stdoutOrThrow(preflight)
  }
  const { effectiveCtx } = withDetectedSocket(ctx)

  const paths = deployRunPaths(params.applicationNodeId)
  const cmd = ['docker', ...dockerHostArgs(effectiveCtx), 'compose', '-f', '-', '-p', COMPOSE_PROJECT, ...upArgs]
  const env: Record<string, string> = { COMPOSE_IGNORE_ORPHANS: '1' }
  if (effectiveCtx.dockerHost) {
    env.DOCKER_HOST = effectiveCtx.dockerHost
  }
  const inner = buildDockerShellCommand(cmd, content, env)
  const startedAt = new Date().toISOString()
  const state: DeployRunState = {
    dockerNodeId: params.dockerNodeId,
    applicationNodeId: params.applicationNodeId,
    service: params.service,
    header,
    logPath: paths.logPath,
    rcPath: paths.rcPath,
    startedAt,
  }

  // Stored BEFORE the spawn: a deploy whose marker was never written is a deploy nothing will ever
  // read the output of, and the spawn is the step that can leave a build running.
  await host.storage.set(deployRunStorageKey(params.applicationNodeId), state)
  await recordDeployLog(params.applicationNodeId, 'start', `${header}\nStarting…\n`, { status: 'running', at: startedAt })
  try {
    await terminal.exec(effectiveCtx, detachedDeployScript(inner, paths))
  } catch (err) {
    await host.storage.delete(deployRunStorageKey(params.applicationNodeId))
    await recordDeployLog(params.applicationNodeId, 'start', `${header}\nFailed to start the deploy: ${String(err)}\n`, {
      status: 'finished',
      exitCode: 1,
      at: startedAt,
    })
    throw err
  }

  // Wait out the short deploys so they behave as a synchronous one would — same output in the
  // log, same throw on a non-zero exit. A failed check is retried: the build does not depend on it.
  const deadline = Date.now() + DEPLOY_SYNC_WAIT_MS
  let failures = 0
  while (Date.now() < deadline) {
    await pause(DEPLOY_POLL_INTERVAL_MS)
    signal?.throwIfAborted()
    let run: { text: string; exitCode?: number }
    try {
      run = await pollDeployRun(state)
      failures = 0
    } catch (err) {
      failures += 1
      if (failures >= DEPLOY_WAIT_MAX_FAILURES) {
        throw lostContactError(failures, err)
      }
      continue
    }
    if (run.exitCode !== undefined) {
      await endDeploy(run.exitCode, run.text)
      return
    }
  }

  // Anything longer (an image build, a large pull) is handed to the Deploy tab — unless the caller
  // is a background task, which waits for the exit code so that whoever started it learns how the
  // deploy ended. A cancel or a timeout ends only that wait: the build no longer depends on this
  // call, whoever made it.
  if (!signal) {
    return
  }
  failures = 0
  for (;;) {
    await pause(DEPLOY_WAIT_POLL_INTERVAL_MS)
    signal.throwIfAborted()
    let run: { text: string; exitCode?: number } | undefined
    try {
      if ((await readDeployExitCode(ctx, state)) !== undefined) {
        run = await pollDeployRun(state)
      }
      failures = 0
    } catch (err) {
      failures += 1
      if (failures >= DEPLOY_WAIT_MAX_FAILURES) {
        throw lostContactError(failures, err)
      }
      continue
    }
    if (run?.exitCode !== undefined) {
      await endDeploy(run.exitCode, run.text)
      return
    }
  }
}

export interface DockerDownParams {
  dockerNodeId: string
}

// Label-driven `compose down` equivalent: stop + remove every project container, then remove the
// project's compose-created networks. Needs no compose file (works after a cacheDir wipe) and is
// a clean no-op (exit 0) when nothing is running. Container ops stay honest — a failing
// stop/rm rejects — while network removal is best-effort: a project network can legitimately
// still have endpoints (e.g. containers of another docker node on the same daemon, or externally
// attached ones), and that must not fail a down whose real job succeeded.
export async function dockerDown(params: DockerDownParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const ids = await composeContainerIds(ctx)
  if (ids.length > 0) {
    await dockerCmd(ctx, ['stop', ...ids])
    await dockerCmd(ctx, ['rm', '-f', ...ids])
  }
  const networkIds = (await dockerCmd(ctx, ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`]))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (networkIds.length > 0) {
    await dockerCmd(ctx, ['network', 'rm', ...networkIds]).catch(() => {})
  }
  invalidatePs(params.dockerNodeId)
}

export interface DockerStopServiceParams {
  dockerNodeId: string
  service: string
}

// Label-driven `compose stop` + `compose rm -f` equivalent for one service (all replicas). No
// compose file needed; a service with no containers is a clean no-op (exit 0). `stop` failures
// stay honest (reject); `rm` is best-effort, as `compose rm -f` is.
export async function dockerStopService(params: DockerStopServiceParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const ids = await composeContainerIds(ctx, params.service)
  if (ids.length > 0) {
    await dockerCmd(ctx, ['stop', ...ids])
    await dockerCmd(ctx, ['rm', '-f', ...ids]).catch(() => {})
  }
  invalidatePs(params.dockerNodeId)
}

export interface DockerStartInstancesParams {
  dockerNodeId: string
  service: string
}

// Plain `docker start` on the service's startable containers — resumes stopped ones in place,
// no recreate/build (that's `dockerUp`, the "deploy" action). No compose file
// needed, same label-driven lookup as stop/restart/down; a service with nothing to start is a clean
// no-op. Deliberately does NOT call recordDeployLog: a plain start has no compose/launch narrative
// worth persisting — the Deploy tab stays scoped to actions that actually launch/rebuild something
// (dockerUp, dockerRestartService).
export async function dockerStartInstances(params: DockerStartInstancesParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const ids = await serviceContainerIdsFor(ctx, params.service, 'start')
  if (ids.length > 0) {
    await dockerCmd(ctx, ['start', ...ids])
  }
  invalidatePs(params.dockerNodeId)
}

export interface DockerStopInstancesParams {
  dockerNodeId: string
  service: string
}

// Plain `docker stop` on the service's stoppable containers, a restart loop included — unlike
// dockerStopService (which also removes them, the "terminate" action), this leaves
// the containers in place, stopped, ready for a plain start. Same no-compose-file, no-op-safe shape
// as its siblings above. No recordDeployLog either, for the same reason as dockerStartInstances.
export async function dockerStopInstances(params: DockerStopInstancesParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const ids = await serviceContainerIdsFor(ctx, params.service, 'stop')
  if (ids.length > 0) {
    await dockerCmd(ctx, ['stop', ...ids])
  }
  invalidatePs(params.dockerNodeId)
}

export interface DockerRestartServiceParams {
  dockerNodeId: string
  applicationNodeId: string
  service: string
}

// Label-driven `compose restart` equivalent: restarts every restartable container of the service
// (running or stopped — `docker restart` starts stopped ones too, matching compose semantics). No
// compose file needed; nothing to restart is a clean no-op, mirroring `compose restart` on an
// absent service.
export async function dockerRestartService(params: DockerRestartServiceParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  const ids = await serviceContainerIdsFor(ctx, params.service, 'reboot')
  let result: ExecResult | undefined
  if (ids.length > 0) {
    result = await dockerCmdResult(ctx, ['restart', ...ids])
    await recordDeployLog(params.applicationNodeId, 'restart', combinedOutput(result))
  }
  invalidatePs(params.dockerNodeId)
  if (result) {
    stdoutOrThrow(result)
  }
}

export interface DockerServiceLogsParams {
  dockerNodeId: string
  service: string
  containerId?: string
  tail?: number
  since?: string
  until?: string
  timestamps?: boolean
}

// One-shot `docker logs` (not `-f`/follow — a dispatched action returns a single result, not a
// stream) against a specific container, or the first container found for the service when none is
// given. Merges stderr into the returned text like a real terminal would, since a container's own
// logging often goes to either stream depending on the app.
export async function dockerServiceLogs(params: DockerServiceLogsParams): Promise<string> {
  const ctx = await resolveDockerContext(params.dockerNodeId)
  let containerId = params.containerId
  if (!containerId) {
    const ids = await composeContainerIds(ctx, params.service)
    if (ids.length === 0) {
      throw new Error(`No containers found for service "${params.service}"`)
    }
    containerId = ids[0]
  }
  const args = ['logs']
  if (params.tail !== undefined) {
    args.push('--tail', String(params.tail))
  }
  if (params.since) {
    args.push('--since', params.since)
  }
  if (params.until) {
    args.push('--until', params.until)
  }
  if (params.timestamps) {
    args.push('--timestamps')
  }
  args.push(containerId)
  return redactSecrets(await dockerCmd(ctx, args, undefined, undefined, true))
}

// ═══════════════════════════════════════════════════════════════════
// Terminal config for docker exec
// ═══════════════════════════════════════════════════════════════════

export interface DockerTerminalConfigParams {
  context: DockerContext
  containerId: string
}

interface TerminalConfig {
  type: string
  config: Record<string, unknown>
}

export function dockerTerminalConfig(params: DockerTerminalConfigParams): TerminalConfig {
  const { context, containerId } = params
  const ctxArgs = context.contextName ? ['--context', context.contextName] : []
  const execArgs = [...ctxArgs, 'exec', '-it', containerId, 'bash']

  if (context.type === 'ssh') {
    return {
      type: 'ssh',
      config: {
        host: context.host,
        port: context.port || 22,
        username: context.username || 'root',
        password: context.password,
        keyPath: context.keyPath,
        command: `docker ${execArgs.join(' ')}`,
      },
    }
  }

  return {
    type: 'wsl',
    config: {
      distro: context.distro,
      command: 'docker',
      args: execArgs,
    },
  }
}
