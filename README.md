# 🦞 Lobstah

> Distributed P2P LLM inference grid for Apple Mac mini. The lobstah way.

Lobstah is a federated peer-to-peer compute grid for LLM inference, modeled on the electrical grid. Contribute spare compute when you have it, earn signed credits. Spend credits when you need extra compute. No central authority owns the ledger; receipts are signed by the providing worker and accumulate on every participant's local log.

**Status: pre-alpha.** Tested end-to-end across machines (cross-region streaming, signed receipts, replay protection, multi-peer routing with failover, **discovery via the public Nostr relay network**). [Published on npm](https://www.npmjs.com/org/lobstah) under the `@lobstah/*` scope.

```sh
npm install -g @lobstah/cli
```

## Why

LLM inference is bursty. A 32GB Mac mini idle most of the day could be serving someone else's `llama3.1:8b` queries; in exchange, when you need compute beyond what your hardware supports, you draw from the grid. Token-usage receipts are the meter, the federated ledger is the settlement layer, and discovery rides on top of [Nostr](https://nostr.com) so the project owns no infrastructure.

## Architecture

```
                          (opt-in advertise)
worker  ──signed kind=31474 event──► Nostr relays ◄──signed event── worker
                                  (damus.io, nos.lol,
                                   relay.nostr.band, ...)
                                       │
                                       │ (opt-in subscribe)
                                       ▼
                                    peers.json
                                       │
client  ──/v1/chat/...──► lobstah-router ──forwards──► picked worker
                              │                              │
                              │  ◄────signed receipt─────────┤
                              ▼                              ▼
                          local ledger                   local ledger
```

**Strictly opt-in at every layer.** Workers are invisible by default; routers consume nothing by default. Both sides have explicit "participate" commands (`worker start --publish-via-nostr`, `peers gossip-nostr`). A centralized HTTP tracker is also bundled as a fallback for environments where Nostr WebSockets are blocked.

## Packages

| Package | What |
|---|---|
| `@lobstah/protocol` | Ed25519 (lobstah) + secp256k1/Schnorr (Nostr) identities, signed receipts + announcements (canonical JSON), Zod request schemas, replay-protection helpers, URL safety |
| `@lobstah/ledger` | append-only signed-receipt log + balance computation |
| `@lobstah/engine-ollama` | `WorkerEngine` interface + Ollama adapter (chat + chatStream) |
| `@lobstah/worker` | provider-side HTTP server: signs receipts, OpenAI-compat (streaming + non-streaming), optional auto-publish via Nostr or HTTP tracker |
| `@lobstah/router` | local HTTP server: model-aware multi-peer routing with failover, receipt validation + nonce dedupe, append to ledger |
| `@lobstah/transport-nostr` | thin wrapper around `nostr-tools`: publish + subscribe + NIP-09 unannounce; npub/nsec encoding |
| `@lobstah/tracker` | centralized HTTP tracker (legacy fallback for Nostr-blocked environments) |
| `@lobstah/cli` | `keygen | worker start | router start | tracker start | peers add/remove/list/sync/gossip-nostr | balance` |
| `openclaw-extension/` | openclaw plugin wrapper (will publish as a separate npm package + ClawHub listing) |

## Quickstart (Nostr discovery — the canonical path)

```sh
npm install -g @lobstah/cli

# generate identity (lobstah Ed25519 + Nostr Schnorr keys)
lobstah keygen
# → lobstah: lob1abc...   (signs receipts + announcements)
# → nostr:   npub1xyz...  (signs Nostr-event envelopes for transport)
```

(Alternative: clone the repo + `pnpm install && pnpm -r build` to run from source.)

**Provider** (contributes compute):

```sh
lobstah worker start \
    --host 0.0.0.0 \
    --publish-via-nostr \
    --announce-url http://your-reachable-host:17474 \
    --announce-label my-mac
# → published to wss://relay.damus.io, wss://nos.lol, wss://relay.nostr.band
# → heartbeat every 150s; signed NIP-09 deletion on shutdown
```

**Consumer** (uses compute):

```sh
# pull current peer list from Nostr (one-shot, ~10s to drain relay buffers)
lobstah peers gossip-nostr
# → received N valid announcement(s); merged into peers.json

# start the router
lobstah router start

# request via OpenAI-compatible API
curl -s -X POST http://127.0.0.1:17475/v1/chat/completions \
    -H 'content-type: application/json' \
    -d '{"model":"llama3.1:8b","stream":true,
         "messages":[{"role":"user","content":"hi"}]}'

# check your ledger
lobstah balance
```

Custom relays: pass `--nostr-relay wss://your-preferred-relay` (repeatable) on either side.

## Quickstart (local-only, no discovery)

```sh
lobstah keygen
lobstah worker start                    # terminal 1
lobstah peers add <worker-pubkey> http://127.0.0.1:17474
lobstah router start                    # terminal 2
```

## Quickstart (centralized HTTP tracker fallback)

For environments where Nostr WebSockets are blocked (some corporate networks). Anyone can run their own tracker on Cloudflare Workers free tier — see `packages/tracker/README.md`:

```sh
# discover via HTTP tracker
lobstah peers sync https://your-tracker.example.com

# advertise via HTTP tracker
lobstah worker start \
    --announce-to https://your-tracker.example.com \
    --announce-url http://your-host:17474
```

## Trust + safety

- **Receipt replay protection.** Each receipt carries a 16-byte random nonce and a `completedAt` timestamp. Routers reject expired (>5 min) or duplicate-nonce receipts.
- **Two-layer signatures.** The lobstah Ed25519 key signs receipts + announcement content (the trust layer). The Nostr Schnorr key signs the outer Nostr event envelope (the transport layer). A compromised Nostr key can't forge financial activity; a compromised lobstah key can.
- **Announcement freshness.** Trackers and Nostr-derived peer lists reject stale or far-future announcements (±5 min skew window).
- **URL safety.** Any URL the router or CLI fetches is validated: only http/https schemes; resolved IP addresses checked against a blocklist (loopback, link-local incl. AWS/GCP/Azure metadata 169.254.169.254, unspecified). Operators in stricter environments can opt into blocking RFC1918 / ULA / CGNAT via `LOBSTAH_BLOCK_PRIVATE_ADDRS=1`.
- **Worker default bind is loopback.** `lobstah worker start` binds to 127.0.0.1 by default; operators must explicitly pass `--host 0.0.0.0` to expose to a network. The CLI warns when they do.
- **Cooperative trust model.** Workers are assumed not to lie about model output. Catching liars (returning gibberish, returning a different model's output) needs redundant execution + reputation, which is future work.
- **No NAT traversal yet.** Workers must be reachable at the URL they advertise. Public IP, port forwarding, or a Tailscale-style overlay all work today.

## Status / roadmap

- [x] Local 2-process grid (worker + router + ledger)
- [x] Signed Ed25519 receipts with canonical JSON
- [x] Streaming end-to-end (SSE with receipt embedded as comment line)
- [x] Multi-peer routing: model-aware filtering, health tracking, failover
- [x] Replay protection (nonce + freshness)
- [x] Centralized HTTP tracker (Node + Cloudflare Workers deploy paths)
- [x] **Discovery via Nostr relays — fully P2P, zero infrastructure to operate**
- [x] URL-safety / SSRF defenses (loopback, link-local, metadata)
- [x] openclaw plugin wrapper (custom auth + onboarding wizard prompts)
- [x] npm publish under `@lobstah/*` ([@lobstah/cli](https://www.npmjs.com/package/@lobstah/cli) + 7 sibling packages)
- [ ] ClawHub listing
- [ ] Model-weighted credit pricing (replace today's flat 1-token=1-credit)
- [ ] Worker-side load shedding (real `queueDepth` from the engine)
- [ ] NAT traversal (relay path for peers behind NATs)
- [ ] Adversarial trust model (redundant execution + reputation)
- [ ] Web dashboard

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Originally proposed as a bundled openclaw extension ([openclaw/openclaw#76253](https://github.com/openclaw/openclaw/pull/76253)); pivoting to a standalone plugin per the project's plugin-marketplace policy. Discovery built on [Nostr](https://nostr.com) using `nostr-tools`; default relays match the set shipped with `@openclaw/nostr`.
