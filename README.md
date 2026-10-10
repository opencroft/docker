# Docker

An OpenCroft extension that runs containers with Docker Compose on any host a terminal can reach: the local machine, a WSL distro or a server over SSH.

## Nodes

- **Docker** — a Docker daemon. Wire a terminal into **Host** (where `docker` runs) and, optionally, a second terminal into **Context** to reach a daemon somewhere else. A named CLI context can be set instead. A rootless daemon's socket is detected when the default one refuses. The inspector lists the daemon's containers and its named volumes. Actions: `createVolume`, `removeVolume`, `listVolumes`.
- **Application** — one Compose service. Its fields cover the image or build context, ports, environment, command, restart policy, replicas, GPU and resource limits, healthcheck, security options, log driver, and Traefik routing labels (domain, entrypoint, TLS, basic auth). Environment values can come from the host's Secrets Store. Wire a Docker node into **Docker** and Volume nodes into **Volumes**. Each running container appears as a **Terminal** output that opens a shell inside it. Actions: `deploy`, `start`, `stop`, `reboot`, `terminate`, `logs`, `attachVolume`, `detachVolume`.
- **Volume** — a bind mount from a host path into a container.

Named volumes are created with an `opencroft-` prefix and shown without it. Every Application is a service in the `opencroft` Compose project. No compose file is kept on disk: each deploy builds a single-service document and streams it to `docker compose -f -`.

## Deploys and logs

`deploy` runs compose detached on the host, so a long build or pull is not cut short by the action's timeout. The Deploy tab follows its output while it runs. The Logs tab follows a container's log. Both stream from sessions the server starts. Output is redacted on the way out: every value the Secrets Store holds is removed, in plain form and inside base64, percent-encoded, JSON-escaped and compose-escaped text, and so is the password of any URL in an Application's environment. `server/redact.ts` states exactly what is and is not covered.

## Development

The extension is built and loaded by an OpenCroft instance. Its imports of `@opencroft/client` and `@opencroft/server` (each by module, such as `@opencroft/client/canvas` and `@opencroft/server/graph`), `react`, `lucide-react` and `sonner` are provided by the host at build time. `@opencroft/client` and `@opencroft/server` are peer dependencies that are not published to npm, so install with `--legacy-peer-deps`, as the host does:

```sh
npm ci --legacy-peer-deps
npm test
```

The tests run on Node.js 22.18 or later. The deploy-follow tests need `sh`, `wc`, `tail`, `head` and `sleep` on `PATH`, and one needs `/proc`. Each skips with the reason when its tools are missing.

`npm run typecheck` checks the code against the host's types, and `npm run fix` formats and lints it and then runs the typecheck. Both run the `opencroft-dev` command of an OpenCroft core checkout, so run them with the extension inside a core checkout, or with that checkout's `node_modules/.bin` on `PATH`.

## License

MIT — see [LICENSE](LICENSE).
