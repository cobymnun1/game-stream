# Game Stream

Decentralized game streaming on Akash. This repo contains the web app, backend
worker, browser streaming client, shared protocol code, Akash deployment
template, and the Sunshine/Steam container build used to launch cloud gaming
sessions.

The easiest fresh-clone path is:

```sh
corepack enable
corepack pnpm install
cp .env.example .env
corepack pnpm dev
```

Then fill in `.env` with your Privy, database, Akash, and optional Squid/KMS
settings. Never commit `.env`; `.env.example` is the committed template.

## What This Repo Contains

This is a pnpm/Turbo monorepo.

| Path | Package | Purpose | Default port |
| --- | --- | --- | --- |
| `apps/client` | `@basehack/client` | Next.js web app for login, session creation, funding, deploy status, and connection details. | `3000` |
| `apps/worker` | `@basehack/worker` | Hono backend for Privy auth, database state, Akash wallet/session orchestration, Squid funding, deployment, and teardown. | `4000` |
| `apps/iwa` | `@basehack/iwa` | Vite browser Moonlight client, packaged as an Isolated Web App for Direct Sockets. | `3001` |
| `apps/pairing-api` | `@basehack/pairing-api` | Local pairing helper for Sunshine PIN pairing and port-map proxying. | `4100` |
| `packages/shared` | `@basehack/shared` | Shared session types, GPU catalog, funding chains, and Sunshine port constants. | n/a |
| `packages/protocol` | `@basehack/protocol` | TypeScript wrapper and Emscripten/WASM build scaffold for `moonlight-common-c`. | n/a |
| `infra/docker` | n/a | Sunshine + SteamOS container build assets. | n/a |
| `sdl` | n/a | Akash SDL template rendered by the worker. | n/a |

For a deeper implementation walkthrough, see `ARCHITECTURE.md`.

## Prerequisites

Required for normal development:

- Node.js `>=20`
- Corepack, included with modern Node
- pnpm `9`, selected by the root `packageManager`
- A Postgres database for `apps/worker`
- A Privy app for authentication

Required for real Akash deploys:

- Akash RPC and gRPC endpoints
- A deployable Sunshine image, usually `ghcr.io/<owner>/game-stream:latest`
- Funding for the Akash wallet path you use
- GPU/IP-capable Akash providers with the required ports available

Required only when rebuilding the protocol WASM from source:

- Emscripten SDK with `emcmake` on PATH
- CMake `>=3.20`
- A working C/C++ build toolchain

Required only when packaging the IWA:

- Chrome/Chromium with Isolated Web App support
- `wbn` and `wbn-sign` CLIs
- OpenSSL for generating the local IWA signing key

## Fresh Clone Setup

1. Install dependencies.

```sh
corepack enable
corepack pnpm install
```

2. Create your local environment file.

```sh
cp .env.example .env
```

3. Fill in `.env`.

At minimum, the full platform needs `DATABASE_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`,
`PRIVY_APP_ID`, `PRIVY_APP_SECRET`, and a shared `WORKER_SHARED_SECRET`.

4. Run the dev servers.

```sh
corepack pnpm dev
```

Or run only what you need:

```sh
corepack pnpm --filter @basehack/client dev
corepack pnpm --filter @basehack/worker dev
corepack pnpm --filter @basehack/iwa dev
corepack pnpm --filter @basehack/pairing-api dev
```

Open:

- Web app: `http://localhost:3000`
- Worker health: `http://localhost:4000/health`
- IWA dev client: `http://localhost:3001`
- Pairing API health: `http://localhost:4100/health`

## Environment Variables

The repo root `.env` is loaded by the worker and the Next.js app. Some apps can
also load local app-level env files, such as `apps/client/.env.local` or
`apps/worker/.env`, but root `.env` is the normal setup path.

| Variable | Used by | Required | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | `apps/client` | Yes for web login | Public Privy app id. |
| `NEXT_PUBLIC_WORKER_URL` | `apps/client` | Optional | Browser-facing worker URL. Defaults to `http://localhost:4000`. |
| `WORKER_URL` | `apps/client` API routes | Optional | Server-side worker URL. Defaults to `http://localhost:4000`. |
| `WORKER_SHARED_SECRET` | `apps/client`, `apps/worker` | Recommended | Shared internal secret. Must match between web and worker. |
| `PORT` | `apps/worker`, `apps/pairing-api` | Optional | Worker defaults to `4000`; pairing API defaults to `4100`. |
| `CORS_ORIGIN` | `apps/worker` | Optional | Defaults to `http://localhost:3000`. |
| `DATABASE_URL` | `apps/worker` | Yes | Postgres connection string. Supabase is supported. |
| `DATABASE_SSL` | `apps/worker` | Optional | Set to `true` to force SSL. Supabase URLs automatically use SSL. |
| `PRIVY_APP_ID` | `apps/worker` | Yes for auth | Privy server-side app id. |
| `PRIVY_APP_SECRET` | `apps/worker` | Yes for auth | Privy server-side secret. |
| `DEMO_MODE` | `apps/worker`, `apps/client` | Optional | Set `true` to show/use demo deploy flow. |
| `DEMO_AKASH_MNEMONIC` | `apps/worker` | Demo only | Funded Akash mnemonic for demo deploys. Keep secret. |
| `AKASH_RPC` | `apps/worker` | Akash deploys | Defaults are provided in `.env.example`. |
| `AKASH_GRPC` | `apps/worker` | Akash deploys | Defaults are provided in `.env.example`. |
| `SUNSHINE_IMAGE` | `apps/worker` | Akash deploys | Image used in rendered SDL. |
| `AKASH_AKT_USD_PRICE` | `apps/worker` | Optional | Blank means fetch live price. |
| `AKASH_IP_LEASE_USD_PER_HOUR` | `apps/worker` | Optional | Used in pricing. Defaults to `0.5` in `.env.example`. |
| `AWS_REGION` | `apps/worker` | Production KMS | Required only when using AWS KMS. |
| `AWS_KMS_KEY_ID` | `apps/worker` | Production KMS | Blank uses dev encryption key. |
| `DEV_ENCRYPTION_KEY` | `apps/worker` | Dev only | Local mnemonic encryption key. Replace in production. |
| `SQUID_INTEGRATOR_ID` | `apps/worker` | Optional | Squid integrator id. Defaults to `game-stream-launch`. |
| `PORTMAP_URL` | `apps/pairing-api` | Optional | Upstream port-map URL, defaults to `http://localhost:3000/mappings.json`. |
| `VITE_PORTMAP_URL` | `apps/iwa` | Optional | Browser-visible port-map URL for IWA/dev streaming. |
| `VITE_BASE` | `apps/iwa` | Bundle only | Asset base. IWA bundling sets this for `isolated-app://`. |
| `MOONLIGHT_COMMON_C_REF` | `packages/protocol` | Optional | Override pinned upstream ref when fetching vendor source. |

## Main Commands

Root commands:

```sh
corepack pnpm dev
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
```

App commands:

```sh
corepack pnpm --filter @basehack/client dev
corepack pnpm --filter @basehack/worker dev
corepack pnpm --filter @basehack/iwa dev
corepack pnpm --filter @basehack/pairing-api dev
```

Worker deploy smoke test:

```sh
AKASH_MNEMONIC="word1 word2 ..." corepack pnpm --filter @basehack/worker test:deploy
```

Useful optional test variables for `test:deploy`:

- `TEST_GPU`, default `rtx4090`
- `TEST_CPU`, default `8`
- `TEST_MEM`, default `16`
- `TEST_BUDGET_USD`, default `2`
- `TEST_DURATION_HRS`, default `1`
- `KEEP_ALIVE_MIN`, default `30`
- `MAX_RETRIES`, default `8`

## Local Development Workflows

### Web App + Worker

Run:

```sh
corepack pnpm --filter @basehack/worker dev
corepack pnpm --filter @basehack/client dev
```

The web app talks to the worker through `NEXT_PUBLIC_WORKER_URL` in browser code
and `WORKER_URL` in server-side API routes. The worker creates its required
Postgres tables at startup with `CREATE TABLE IF NOT EXISTS`; there are no
separate migration commands in this repo right now.

The normal product flow is:

1. Sign in through Privy in the web app.
2. Sync the user's Base wallet to the worker.
3. Choose GPU, CPU, memory, duration, budget, and funding token.
4. Create a session.
5. Fund through Squid or use demo mode.
6. Deploy a Sunshine container on Akash.
7. Poll until the session is `ready`.
8. Connect with the IWA/Moonlight client.
9. Tear down the Akash lease when done.

### IWA Dev Client Against a Sunshine Host

Run:

```sh
corepack pnpm --filter @basehack/iwa dev
```

Open `http://localhost:3001`, enter the Sunshine host, and connect. In a normal
browser tab, the Vite dev server proxies HTTP/TCP/UDP operations through local
middleware because raw Direct Sockets and self-signed Sunshine TLS are not
available to regular web pages. A packaged IWA uses Direct Sockets directly.

The committed `apps/iwa/public/moonlight.js` and
`apps/iwa/public/moonlight.wasm` files are the runtime protocol assets used by
the IWA. You do not need Emscripten for normal dev unless you are rebuilding the
protocol core.

### Pairing API Helper

Run:

```sh
corepack pnpm --filter @basehack/pairing-api dev
```

Start a pairing job:

```sh
curl -X POST http://localhost:4100/pair \
  -H 'Content-Type: application/json' \
  -d '{"host":"SUNSHINE_HOST"}'
```

The response contains a job `id` and a Sunshine PIN. Enter the PIN in Sunshine,
then poll:

```sh
curl 'http://localhost:4100/pair/JOB_ID?includeIdentity=1'
```

If Sunshine is exposed through an Akash or proxy port map, pass a port-map URL:

```sh
curl -X POST http://localhost:4100/pair \
  -H 'Content-Type: application/json' \
  -d '{"host":"SUNSHINE_HOST","portMapUrl":"http://localhost:3000/mappings.json"}'
```

### Protocol WASM Rebuild

The vendored `moonlight-common-c` source is committed for easy cloning. The
generated `packages/protocol/dist` build output is not the runtime source of
truth; the IWA serves the committed runtime assets from `apps/iwa/public`.

Only rebuild the protocol core when changing `packages/protocol`, the C platform
shim, or the vendored Moonlight sources.

```sh
corepack pnpm --filter @basehack/protocol configure
corepack pnpm --filter @basehack/protocol build:wasm
```

If the vendor tree is missing for any reason:

```sh
corepack pnpm --filter @basehack/protocol fetch:moonlight
```

After rebuilding, copy the generated runtime assets into the IWA public folder:

```sh
cp packages/protocol/dist/moonlight.js apps/iwa/public/moonlight.js
cp packages/protocol/dist/moonlight.wasm apps/iwa/public/moonlight.wasm
```

`moonlight-common-c` is GPL-3.0. Distributing a client that vendors or links the
resulting WASM must comply with GPL-3.0 obligations for the combined work.

### IWA Bundle

Build and package the IWA:

```sh
corepack pnpm --filter @basehack/iwa build
corepack pnpm --filter @basehack/iwa bundle
```

The bundler generates `apps/iwa/iwa-key.pem` if it does not exist. Keep that key
secret; it is ignored by Git. The signed bundle is written as
`apps/iwa/moonlight.swbn`.

The bundle script expects `wbn-bundle`, `wbn-sign`, and `wbn-key-id` on PATH.

## Akash Deployment

The worker renders `sdl/sunshine-stream.yaml` with:

- `SUNSHINE_IMAGE`
- selected GPU model
- CPU units
- memory
- max price per block
- IP lease price per block

The SDL launches the Sunshine service and exposes the web desktop ports. The
worker also watches bids, creates leases, sends the manifest, extracts forwarded
ports and Sunshine credentials, and tears down deployments on request or process
shutdown.

The Sunshine container is built by `.github/workflows/build-container.yml` from
`infra/docker/Dockerfile` and pushed to GitHub Container Registry:

```text
ghcr.io/<owner>/game-stream:latest
ghcr.io/<owner>/game-stream:<commit-sha>
```

The Docker image is based on LinuxServer SteamOS and installs Sunshine. It
exposes the standard GameStream ports:

- TCP: `47984`, `47989`, `47990`, `48010`
- UDP: `47998`, `47999`, `48000`, `48002`

Akash provider behavior matters. GPU availability, public IP support, and UDP
forwarding are provider-side constraints; a session can deploy successfully but
still fail to stream if required UDP ports are not reachable.

## Worker API Summary

The worker exposes:

- `GET /health`: liveness check.
- `GET /config`: public feature config, currently `demoMode`.
- `POST /auth/sync`: verify Privy token, link Base wallet, provision Akash wallet.
- `GET /users/me`: current user and wallet addresses.
- `POST /sessions`: create a session from selected specs.
- `GET /sessions/:id`: poll session state and connection details.
- `POST /sessions/:id/quote`: quote funding.
- `POST /sessions/:id/route`: create Squid route transaction data.
- `POST /sessions/:id/swap`: submit swap transaction hash.
- `POST /sessions/:id/deploy`: deploy after funding.
- `POST /sessions/:id/demo-deploy`: deploy from the configured demo wallet.
- `DELETE /sessions/:id`: tear down the session lease.

Session states are defined in `packages/shared/src/session-types.ts` and include
`spec_select`, `deposit_quote`, `swap_in_progress`, `deploying`, `bid_wait`,
`lease_created`, `manifest_sent`, `lease_ready`, `ready`, `tearing_down`,
`closed`, and `failed`.

## Streaming Architecture

The streaming client is a browser Moonlight client:

- Pairing and launch are implemented in TypeScript against Sunshine HTTP APIs.
- The GameStream protocol core comes from `moonlight-common-c` compiled to WASM.
- TCP and UDP are provided by Direct Sockets in a packaged IWA.
- The Vite dev server provides local proxy fallbacks for browser-tab development.
- Encoded video frames are decoded with WebCodecs and rendered to a canvas.
- Opus audio is decoded with WebCodecs and scheduled through Web Audio.
- Keyboard and mouse input are captured with browser input APIs and sent through
  the protocol core to Sunshine.

Chrome/Chromium is the target browser. Direct Sockets, Isolated Web Apps,
Keyboard Lock, Pointer Lock, WebCodecs, and cross-origin isolation are core
assumptions.

## Git And Secrets

Committed for portability:

- `package.json` files
- `pnpm-lock.yaml`
- `.env.example`
- `apps/iwa/public/moonlight.js`
- `apps/iwa/public/moonlight.wasm`
- `packages/protocol/vendor/moonlight-common-c`

Ignored intentionally:

- `node_modules`
- `dist`
- `.turbo`
- `.env` and `.env.local`
- private keys such as `*.pem`, `*.key`, and `apps/iwa/iwa-key.pem`
- generated `.wbn` and `.swbn` bundles
- local Cursor/debug files

Do not commit real database URLs, Privy secrets, Akash mnemonics, KMS key
details, or IWA signing keys.

## Troubleshooting

`DATABASE_URL is required`

: The worker did not load a valid root `.env` or app-level env file. Copy
  `.env.example` to `.env` and set `DATABASE_URL`.

Privy login works but worker calls fail

: Confirm `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `NEXT_PUBLIC_PRIVY_APP_ID`,
  `NEXT_PUBLIC_WORKER_URL`, `WORKER_URL`, and `CORS_ORIGIN`.

No Akash bids

: GPU/IP providers are intermittent. Try a different GPU, lower resource
  requirements, higher budget, or rerun with `MAX_RETRIES` for the deploy smoke
  test.

Session is ready but stream does not connect

: Check forwarded TCP and UDP ports, provider UDP support, Sunshine credentials,
  and whether the host is reachable from the machine running the IWA.

IWA dev works differently than packaged IWA

: Dev mode uses Vite proxy routes for raw TCP/UDP and self-signed TLS. Packaged
  IWA mode uses Direct Sockets directly and requires Chrome support.

Audio starts late or is silent until input

: Chrome requires a user gesture before audio playback. Click or press a key in
  the stream to resume the audio context.

Mouse or keyboard does not reach the game

: Click the canvas to enter pointer lock/fullscreen. Some remote desktop tools
  interfere with pointer lock. Host-side Sunshine/container input device setup
  can also block input even when the browser is capturing it.

Protocol rebuild fails with `emcmake: command not found`

: Install and activate the Emscripten SDK before running the protocol configure
  or build commands.

## Additional Docs

- `ARCHITECTURE.md`: detailed implementation and system architecture.
- `PLAN.md`: product plan and roadmap.
- `packages/protocol/README.md`: protocol-specific build notes and GPL notice.
- `docs/moonlight-wasm-debug-log.md`: historical debugging notes for the WASM
  Moonlight path.
