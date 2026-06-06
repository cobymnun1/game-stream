# Game Stream Launch

Decentralized game streaming orchestration: Privy auth, Base wallet funding, Squid swap to AKT, and Akash Sunshine deployment.

## Structure

- `apps/web` — Next.js frontend (Vercel)
- `apps/worker` — Node orchestration service (Railway/Fly)
- `packages/shared` — shared types and constants
- `sdl/sunshine-stream.yaml` — Handlebars-templated Akash SDL

## Quick start

1. Copy `.env.example` to `.env` in the repo root and fill in values.
2. Start Postgres and set `DATABASE_URL`.
3. Install and run:

```bash
pnpm install
pnpm --filter @game-stream/shared build
pnpm dev:worker   # :4000
pnpm dev:web      # :3000
```

## Environment

See [.env.example](.env.example) for required variables. Key services:

- **Privy** — Discord, Twitter/X, wallet login + embedded Base wallet
- **Squid Router** — Base ETH/USDC → AKT (`x-integrator-id` header)
- **Akash** — `AKASH_RPC`, `AKASH_GRPC`, `SUNSHINE_IMAGE`
- **KMS** — `AWS_KMS_KEY_ID` in production; `DEV_ENCRYPTION_KEY` for local dev

## Session flow

1. Auth via Privy → sync Base wallet to worker
2. Create session → provision encrypted Akash wallet
3. Select GPU/CPU/RAM/budget → compute deposit
4. Swap Base → AKT via Squid (client signs, worker polls status)
5. Deploy from `sdl/sunshine-stream.yaml` → poll lease → return connection info
6. End session → `closeDeployment`

## Reference

[`deploy-test.mjs`](deploy-test.mjs) — original Akash SDK patterns (SDL construction replaced by file-driven template).
