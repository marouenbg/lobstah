# 🦞 Lobstah

> Distributed P2P LLM inference grid for Apple Mac mini. The lobster way.

Lobstah is a federated peer-to-peer compute grid for LLM inference, modeled on the electrical grid. Contribute spare compute when you have it, earn signed credits. Spend credits when you need extra compute. No central authority owns the ledger; receipts are signed by the providing worker and accumulate on every participant's local log.

**Status: pre-alpha.** Tested end-to-end across machines (cross-region streaming through a public tracker, signed receipts, replay protection, multi-peer routing with failover). Not yet published to npm or ClawHub.

## Why

LLM inference is bursty. A 32GB Mac mini idle most of the day could be serving someone else's `llama3.1:8b` queries; in exchange, when you need compute beyond what your hardware supports, you draw from the grid. The token-usage receipt is the meter, the federated ledger is the settlement layer, and an opt-in tracker handles peer discovery.

## Architecture

```
                          (opt-in advertise)
worker  ──signed announce──► tracker  ◄──signed announce── worker
                              │
                              │ (opt-in sync)
                              ▼
                            peers.json
                              │
client  ──/v1/chat/...──► lobstah-router ──forwards──► picked worker
                              │                              │
                              │  ◄────signed receipt─────────┤
                              ▼                              ▼
                          local ledger                   local ledger
```

**Strictly opt-in at every layer.** Workers are invisible by default; routers don't consume the public peer list by default; both sides have an explicit "participate" command (`worker start --announce-to`, `peers sync`).

## Packages

| Package | What |
|---|---|
| `@lobstah/protocol` | Ed25519 identity, signed receipts + announcements (canonical JSON), Zod request schemas, replay-protection helpers, URL safety |
| `@lobstah/ledger` | append-only signed-receipt log + balance computation |
| `@lobstah/engine-ollama` | `WorkerEngine` interface + Ollama adapter (chat + chatStream) |
| `@lobstah/worker` | provider-side HTTP server: signs receipts, OpenAI-compat (streaming + non-streaming), optional auto-announce |
| `@lobstah/router` | local HTTP server: model-aware multi-peer routing with failover, receipt validation + nonce dedupe, append to ledger |
| `@lobstah/tracker` | opt-in discovery service (in-memory peer registry with TTL-bounded entries) |
| `@lobstah/cli` | `keygen | worker start | router start | tracker start | peers add/remove/list/sync | balance` |
| `openclaw-extension/` | openclaw plugin wrapper (will publish as a separate npm package + ClawHub listing) |

## Quickstart (local dev)

```sh
git clone https://github.com/marouenbg/lobstah.git
cd lobstah
corepack pnpm install
corepack pnpm -r build

# generate identity
node packages/cli/dist/index.js keygen

# in one terminal: start a worker against your local Ollama
node packages/cli/dist/index.js worker start

# in another terminal: add the worker as a peer + start a router
node packages/cli/dist/index.js peers add <worker-pubkey> http://127.0.0.1:17474
node packages/cli/dist/index.js router start

# in a third terminal: hit the router with an OpenAI-compatible request
curl -s -X POST http://127.0.0.1:17475/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"llama3.1:8b","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# check your ledger
node packages/cli/dist/index.js balance
```

## Quickstart (with public tracker)

```sh
# discover workers from a tracker (opt-in)
node packages/cli/dist/index.js peers sync https://your-tracker.example.com

# advertise YOUR machine on a tracker (opt-in)
node packages/cli/dist/index.js worker start \
    --announce-to https://your-tracker.example.com \
    --announce-url http://your-public-host:17474 \
    --announce-label my-mac
```

## Trust + safety

- **Receipt replay protection.** Each receipt carries a 16-byte random nonce and a `completedAt` timestamp. Routers reject expired (>5 min) or duplicate-nonce receipts.
- **Announcement freshness.** Trackers reject stale or far-future announcements (±5 min skew window).
- **URL safety.** Any URL the router or CLI fetches is validated: only http/https schemes; resolved IP addresses checked against a blocklist (loopback, link-local incl. AWS/GCP/Azure metadata 169.254.169.254, unspecified). Operators in stricter environments can opt into blocking RFC1918 / ULA / CGNAT via `LOBSTAH_BLOCK_PRIVATE_ADDRS=1`.
- **Worker default bind is loopback.** `lobstah worker start` binds to 127.0.0.1 by default; operators must explicitly pass `--host 0.0.0.0` to expose to a network. The CLI prints a warning when they do.
- **Cooperative trust model.** Workers are assumed not to lie about model output. Catching liars (returning gibberish, returning a different model's output) needs redundant execution + reputation, which is future work.
- **No NAT traversal yet.** Workers must be reachable at the URL they advertise. Public IP, port forwarding, or a Tailscale-style overlay all work today.

## Status / roadmap

- [x] Local 2-process grid (worker + router + ledger)
- [x] Signed Ed25519 receipts with canonical JSON
- [x] Streaming end-to-end (SSE with receipt embedded as comment line)
- [x] Multi-peer routing: model-aware filtering, health tracking, failover
- [x] Replay protection (nonce + freshness)
- [x] Opt-in public tracker with signed announcements + heartbeats + unannounce
- [x] URL-safety / SSRF defenses (loopback, link-local, metadata)
- [x] openclaw plugin wrapper (custom auth + onboarding wizard prompts)
- [ ] Cloudflare Workers tracker deploy
- [ ] npm publish under `@lobstah/*`
- [ ] ClawHub listing
- [ ] Worker-side load shedding (real `queueDepth` from the engine)
- [ ] NAT traversal (relay path for peers behind NATs)
- [ ] Adversarial trust model (redundant execution + reputation)
- [ ] Web dashboard

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Originally proposed as a bundled openclaw extension ([openclaw/openclaw#76253](https://github.com/openclaw/openclaw/pull/76253)); pivoting to a standalone plugin per the project's plugin-marketplace policy.
