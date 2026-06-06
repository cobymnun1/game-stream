# BaseHack — Decentralized Game Streaming Platform

## Vision

A fully decentralized game streaming service: users authenticate via Privy (X/Twitter or wallet), authorize a platform agent once to manage their wallet autonomously, and from that point the agent handles everything — charging per session via x402, spinning up a Sunshine + Steam container on Akash GPU compute, auto-pairing it to the Moonlight browser client, and tearing it down when the session ends. No manual signing per game, no centralized cloud.

---

## What is Akash Network?

Akash is a **decentralized cloud computing marketplace** built on the Cosmos blockchain — essentially Airbnb for servers. Data center operators and individuals with spare compute (providers) list idle resources on a public marketplace; tenants deploy containerized workloads by bidding on those resources, typically at 60–85% less than AWS/GCP/Azure.

Key properties for this project:
- **GPU support** — providers offer NVIDIA GPUs (RTX 3080/4090, A100s) required for Sunshine's real-time video encoding
- **Permissionless** — no account approval, no KYC; anything that fits in a container
- **On-demand leases** — leases open and close programmatically via `@akashnetwork/chain-sdk`, making per-session provisioning possible
- **Pay in AKT or USDC** — platform backend holds an AKT/USDC wallet to fund provider leases
- **Globally distributed** — no single company controls the infra

Every gaming session = one Akash lease on a GPU node running Sunshine + Steam.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          Browser Client                         │
│                                                                 │
│  Privy Auth (X / Wallet)  →  USDC in Embedded Wallet           │
│              ↓                          ↓                       │
│  Moonlight IWA (Direct Sockets)   x402 session payment         │
└──────────────┬──────────────────────────┬───────────────────────┘
               │                          │ one-time OAuth device auth
               │                          ▼
               │              ┌───────────────────────────┐
               │              │      Platform Agent        │
               │              │  (Claude / Hermes / etc.)  │
               │              │                            │
               │              │  · receives x402 payment   │
               │              │  · opens Akash lease       │
               │              │  · auto-submits Sunshine   │
               │              │    PIN via /api/pin        │
               │              │  · closes lease on expiry  │
               │              └────────────┬──────────────┘
               │                           │ @akashnetwork/chain-sdk
               │                           ▼
               │  TCP+UDP     ┌────────────────────────────┐
               └─────────────→   Akash Network GPU Node    │
                              │                            │
                              │  Sunshine + Steam + Proton │
                              │  (provisioned per session) │
                              └────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Game streaming server | Sunshine (LizardByte) | Open-source GameStream host with Steam integration |
| Game streaming client | Moonlight Web (IWA) | Browser-based client via Isolated Web App |
| Client networking | Direct Sockets API | Raw TCP/UDP from IWA directly to Sunshine |
| Infrastructure | Akash Network | Decentralized GPU compute, per-session leases |
| Akash SDK | `@akashnetwork/chain-sdk` | Programmatic lease open/close from backend |
| Auth | Privy | X (Twitter) OAuth + embedded wallet |
| Agent auth | Privy Device Authorization | OAuth 2.0 device flow — agent gets wallet access |
| Payments | x402 + Privy USDC wallet | Auto-payment per session, no manual signing |
| Cross-chain (optional) | Squid Router | ETH → AKT/USDC fallback if user pays in ETH |
| Frontend | Next.js (App Router) | Web app shell |
| Wallet primitives | viem + wagmi | EVM wallet connection |

---

## Core Components

### 1. Isolated Web App + Direct Sockets

Moonlight requires raw TCP/UDP that a normal browser tab cannot open. Fix: package it as an **Isolated Web App (IWA)** — a signed web bundle Chrome trusts with elevated permissions including the Direct Sockets API (`TCPSocket` / `UDPSocket`). This lets the browser talk directly to Sunshine on Akash with no relay or proxy.

```
/apps/moonlight-iwa/
  manifest.webmanifest
  web-bundle.wbn
```

### 2. Sunshine + Steam on Akash

**Port map** (from Sunshine docs — all must be declared in SDL):

| Ports | Protocol | Purpose |
|---|---|---|
| 47984, 47989, 48010 | TCP | Moonlight control + video |
| 47998, 47999, 48000, 48002, 48010 | UDP | Moonlight audio/video streams |
| 47990 | TCP | Sunshine HTTPS web UI (used for `/api/pin`) |

**Steam integration:**
- Sunshine auto-detects installed Steam games and populates an application list
- Container launches Steam in Big Picture mode as the default app — gives users a console-style game browser inside the stream
- Individual games can be deep-linked via `steam://rungameid/<appid>` from the platform UI
- Proton handles Windows games on Linux Akash nodes — no Windows image needed

**Custom Docker image** (Sunshine + Steam + Proton):
```
/infra/docker/Dockerfile.sunshine
```

**Akash SDL:**
```yaml
version: "2.0"
services:
  sunshine:
    image: basehack/sunshine-steam:latest
    env:
      - SUNSHINE_USERNAME=user
      - SUNSHINE_PASSWORD=${SESSION_TOKEN}
    expose:
      - port: 47984
        proto: tcp
        to: [{ global: true }]
      - port: 47989
        proto: tcp
        to: [{ global: true }]
      - port: 48010
        proto: tcp
        to: [{ global: true }]
      - port: 47998
        proto: udp
        to: [{ global: true }]
      - port: 47999
        proto: udp
        to: [{ global: true }]
      - port: 48000
        proto: udp
        to: [{ global: true }]
      - port: 48002
        proto: udp
        to: [{ global: true }]
      - port: 47990
        proto: tcp
        to: [{ global: true }]
profiles:
  compute:
    sunshine:
      resources:
        cpu: { units: 4 }
        memory: { size: 8Gi }
        gpu: { units: 1, attributes: { vendor: { nvidia: [] } } }
        storage: { size: 50Gi }
```

**Auto-PIN pairing** (critical for full automation):

Sunshine exposes a `/api/pin` POST endpoint on port 47990 (HTTPS web UI) that accepts:
```json
{ "name": "clientname", "pin": "1234" }
```
with HTTP Basic auth. This means the platform agent — not the user — can intercept the PIN that Moonlight generates and auto-submit it to Sunshine. **Zero manual PIN entry.** Full pairing is automated.

Flow:
1. Moonlight IWA initiates pairing → generates PIN
2. IWA sends PIN + session ID to platform backend
3. Backend POSTs `{"name": "...", "pin": "..."}` to `https://<akash-provider-ip>:47990/api/pin`
4. Pairing completes silently — stream starts

### 3. Privy Agent Authorization (Key Feature)

This is the orchestration layer that makes session management fully autonomous. Uses Privy's **OAuth 2.0 Device Authorization Grant** — the same headless pattern as GitHub CLI login.

**What it enables:** the platform agent (Claude, Hermes, OpenClaw, or a custom agent) gets a token to sign transactions from the user's Privy embedded wallet. After one browser approval, no more manual signing per session.

**Authorization flow:**

```
1. Agent calls POST /api/oauth/v2/device_authorization
   → receives device_code (secret, for polling) + user_code (short, human-readable)

2. User visits your app's verification page in browser
   → logs in with Privy, sees "Approve BaseHack agent?" prompt
   → clicks Approve

3. Agent polls POST /api/oauth/v2/token until approval
   → receives access_token (15 min TTL) + refresh_token (30 days, rotated each use)

4. Agent exchanges access_token for HPKE-encrypted signing key
   POST /api/v1/wallets/device-auth/authenticate

5. Agent signs and submits wallet RPCs autonomously
   POST /api/v1/wallets/device-auth/{wallet_id}/rpc
   Methods: eth_sendTransaction, personal_sign
```

**Token lifetimes:**

| Token | Lifetime |
|---|---|
| device_code / user_code | 10 minutes |
| access_token | 15 minutes |
| refresh_token | 30 days (rotated on each use) |

**Verification page** (must be built in the Next.js app):
```ts
// reads ?user_code from URL, prompts Privy login if needed
const response = await fetch('https://auth.privy.io/api/oauth/v2/device_verify', {
  method: 'POST',
  headers: {
    'privy-app-id': appId,
    'Authorization': `Bearer ${userAccessToken}`,
  },
  body: JSON.stringify({ user_code: userCode, action: 'approve' })
})
```

**Security model:**
- App secrets stay server-side; agents never receive them
- HPKE encryption ensures signing keys are agent-process-only
- Policies constrain agent actions (transfer limits, contract allowlists)
- Refresh token rotates on every use — revocable at any time

```
/apps/client/app/authorize/page.tsx   # Verification page
/apps/agent/index.ts                  # Platform agent (session orchestrator)
/apps/agent/lib/privy-device-auth.ts  # Device auth + token refresh logic
```

### 4. Payments — x402 + Privy USDC Wallet

x402 is an open HTTP payment protocol: when a resource requires payment, the server returns `402 Payment Required`. The client adds an `X-PAYMENT` header with a signed authorization and retries. With Privy agent authorization, this is fully automatic — the agent pays without the user lifting a finger after the initial approval.

**Requirements:** USDC in the user's Privy embedded wallet on Base (or Base Sepolia for testnet). Gas is covered by the x402 facilitator — user only needs USDC.

**React (session purchase initiation):**
```ts
import { useX402Fetch } from '@privy-io/react-auth'

const { wrapFetchWithPayment } = useX402Fetch()
const x402Fetch = wrapFetchWithPayment() // uses first connected wallet

// This fetch auto-handles 402 → signs payment → retries
const session = await x402Fetch('/api/session/create', { method: 'POST', ... })
```

**Agent side (Node.js — autonomous payment):**
```ts
import { createX402Client } from '@x402/fetch'
// agent uses the Privy device-auth token to sign payments
const x402Fetch = wrapFetchWithPayment(createX402Client(agentWallet))
```

**Available facilitators:** Pay AI, Corbits, Coinbase CDP.

**Squid Router (fallback):** If user wants to pay in ETH rather than USDC, Squid handles the ETH → USDC swap before the x402 charge.

```
/apps/client/lib/x402.ts       # x402 client setup
/apps/agent/lib/billing.ts     # Session tier pricing, x402 charge logic
```

---

## Full Session Flow (Updated)

```
1.  User opens web app
2.  Logs in via Privy → X (Twitter) OAuth or wallet connect
    Privy creates embedded wallet if user doesn't have one
3.  First-time: "Authorize BaseHack agent?" prompt
    → Agent requests device code
    → User visits /authorize page, approves in browser
    → Agent receives access_token + refresh_token (valid 30 days)
4.  User browses game library (Steam games detected by Sunshine)
    Selects a game + session tier (1h / 4h / 8h)
5.  Payment: x402 auto-charges USDC from embedded wallet
    Agent signs payment autonomously — no manual transaction
6.  Agent opens Akash lease via @akashnetwork/chain-sdk
    Providers bid → GPU node selected → Sunshine + Steam container boots (~30-60s)
7.  Agent POSTs PIN to Sunshine /api/pin endpoint → auto-paired
    Session credentials (provider IP, ports) returned to client
8.  Moonlight IWA opens → Direct Sockets connect to Sunshine
    Stream starts → user lands in Steam Big Picture
9.  User plays. Agent monitors session timer.
10. Timer expires (or user ends session) → agent closes Akash lease
    Compute released. Session logged on-chain.
```

---

## Milestones

### M1 — Core Stream (Week 1–2)
- [ ] Custom Docker image: Sunshine + Steam + Proton
- [ ] Akash SDL with correct port map deployed manually
- [ ] Moonlight IWA connecting via Direct Sockets (Chrome, local first)
- [ ] Auto-PIN pairing via `/api/pin` POST working end-to-end

### M2 — Auth + Agent Authorization (Week 2–3)
- [ ] Privy: X login + embedded wallet setup
- [ ] Agent device authorization flow implemented
- [ ] Verification page at `/authorize`
- [ ] Token refresh logic in agent

### M3 — Payments (Week 3–4)
- [ ] x402 session charging: React hook + agent-side Node.js
- [ ] USDC on Base Sepolia testnet
- [ ] Squid Router ETH fallback
- [ ] Payment verification before provisioning

### M4 — Automated Provisioning (Week 4–5)
- [ ] `@akashnetwork/chain-sdk` lease open/close from agent
- [ ] Agent orchestrates full loop: payment → deploy → pin → stream → teardown
- [ ] Session dashboard (active sessions, history)
- [ ] Refund logic for failed deploys

### M5 — Full Loop + Polish (Week 5–6)
- [ ] End-to-end: login → authorize agent → pick game → play → done
- [ ] Latency/quality settings in Moonlight IWA
- [ ] Mainnet (Base + Akash mainnet)
- [ ] Public beta

---

## Open Questions

| Question | Notes |
|---|---|
| Direct Sockets browser support | Chrome-only via IWA; confirm target browser before M1 |
| Akash GPU availability | GPU leases can be scarce; need queue/waitlist UX |
| UDP forwarding on Akash providers | Not all providers reliably forward UDP — filter for UDP-capable providers in SDL bidding |
| Steam account model | User's own Steam account (legally clean, more friction) vs. platform account |
| Proton vs Windows image | Linux + Proton is cheaper; Windows images larger and scarcer |
| AKT funding | Platform holds AKT wallet to pay providers; fund from x402 USDC revenue via swap |
| Agent policy constraints | Set Privy transfer limits + contract allowlists so authorized agent can't overspend |

---

## Repo Structure

```
/
├── apps/
│   ├── client/                   # Next.js web app
│   │   ├── app/authorize/        # Privy device auth verification page
│   │   └── lib/
│   │       ├── privy.ts          # Privy provider config
│   │       └── x402.ts           # x402 client
│   ├── agent/                    # Platform agent (session orchestrator)
│   │   └── lib/
│   │       ├── privy-device-auth.ts
│   │       ├── akash-deploy.ts
│   │       ├── sunshine-pair.ts
│   │       └── billing.ts
│   └── moonlight-iwa/            # Isolated Web App bundle
├── infra/
│   ├── akash/
│   │   └── sunshine-steam.sdl.yaml
│   └── docker/
│       └── Dockerfile.sunshine   # Sunshine + Steam + Proton
├── packages/
│   ├── contracts/                # Optional on-chain session registry
│   └── sdk/                      # Shared types + helpers
└── PLAN.md
```

---

## Key Links

- Sunshine docs: https://docs.lizardbyte.dev/projects/sunshine
- Moonlight: https://moonlight-stream.org
- Direct Sockets / IWA: https://wicg.github.io/direct-sockets
- Akash SDL docs: https://docs.akash.network/deployments/sdl
- Akash JS SDK: https://github.com/akashnetwork/akash-api
- Privy agent authorization: https://docs.privy.io/recipes/agent-integrations/agent-authorization
- Privy x402: https://docs.privy.io/recipes/agent-integrations/x402
- Squid Router: https://docs.squidrouter.com
