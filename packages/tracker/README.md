# @lobstah/tracker

Opt-in peer discovery service for the lobstah grid. In-memory registry with TTL-bounded entries; signed announcements; signed unannounce; deliberately small (~150 LOC) so anyone can run their own.

Two deployments:

- **Node** (the original) — `lobstah tracker start` from the CLI, or import `startTracker` from this package
- **Cloudflare Workers** — `src/worker.ts` + `wrangler.toml`, KV-backed

## Run locally (Node)

```sh
node packages/cli/dist/index.js tracker start --port 17476
```

## Deploy to Cloudflare Workers (free tier)

```sh
# one-time
pnpm install -g wrangler        # or: npm i -g wrangler
wrangler login                  # opens browser to your Cloudflare account

# create the KV namespace that backs the registry
wrangler kv:namespace create REGISTRY
# Output:
#   ✨ Success!
#   Add the following to your configuration file:
#   [[kv_namespaces]]
#   binding = "REGISTRY"
#   id = "abc123…"
#
# Paste the id into wrangler.toml under [[kv_namespaces]].

# deploy
cd packages/tracker
pnpm deploy:worker
# Output: ✨ Deployed lobstah-tracker triggers (1.23s)
#         https://lobstah-tracker.<your-account>.workers.dev
```

That URL is your tracker. Test it:

```sh
curl https://lobstah-tracker.<your-account>.workers.dev/peers
# {"version":1,"count":0,"peers":[]}
```

Now anyone can sync against it:

```sh
lobstah peers sync https://lobstah-tracker.<your-account>.workers.dev
```

And announcers can advertise to it:

```sh
lobstah worker start \
    --announce-to https://lobstah-tracker.<your-account>.workers.dev \
    --announce-url http://your-public-host:17474
```

## Cost

Cloudflare Workers free tier covers expected traffic:

| Resource | Free quota | Lobstah usage |
|---|---|---|
| Worker invocations | 100k/day | ~1 per peer per 150s + ad-hoc syncs (a tracker with 3 active peers ≈ 2k/day) |
| KV reads | 100k/day | 1 per `/peers` call |
| KV writes | **1k/day** | 1 per `/announce` (heartbeat). 3 active peers ≈ 600/day. The bottleneck. |
| KV storage | 1GB | each peer entry is ~1KB |

For >5 active peers full-time, upgrade to Workers Paid ($5/mo) to lift the KV write cap. Or shard across multiple trackers.

## How the storage works

Each announcement is stored under `peer:<pubkey>` with KV's `expirationTtl` set to the announcement's TTL (clamped to KV's 60s minimum and a 600s maximum). Dead peers fall off automatically — no sweeper job, no Durable Objects required.

`GET /peers` lists all `peer:*` keys and returns the values, double-checking freshness in case KV's lazy eviction hasn't run yet.

`POST /unannounce` requires a signature over `unannounce:<pubkey>:<timestamp>` to prove key ownership.

## What's NOT in the Workers version

- Server-side rate limiting (Cloudflare's WAF can do this if needed)
- Aggregation across multiple trackers (clients can sync from N trackers and merge)
- Auth on `/announce` (anyone can announce a valid signed claim — that's by design)
