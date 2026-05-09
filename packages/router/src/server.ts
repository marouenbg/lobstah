import { serve } from "@hono/node-server";
import { append, computeBalances, readAll } from "@lobstah/ledger";
import {
  assertSafeUrl,
  BOOTSTRAP_ALLOWANCE_TOKENS,
  ChatCompletionRequestSchema,
  type Identity,
  isReceiptFresh,
  JOB_DONE_TTL_MS,
  JOB_ERROR_TTL_MS,
  type JobRecord,
  JobSubmitRequestSchema,
  RECEIPT_HEADER,
  RECEIPT_SSE_PREFIX,
  REQUESTER_HEADER,
  type SignedReceipt,
  formatPubkey,
  verifyReceipt,
} from "@lobstah/protocol";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { DASHBOARD_HTML } from "./dashboard-html.js";
import { noteNonce } from "./nonce-store.js";
import { getCapacity, markFailed, markSucceeded } from "./peer-state.js";
import { loadPeers, type Peer } from "./peers.js";
import { candidatesForModel, orderCandidates, preferTier } from "./pick.js";

const blockPrivateNetwork = (): boolean =>
  process.env.LOBSTAH_BLOCK_PRIVATE_ADDRS === "1";

// Router-side job mapping. Each client-facing jobId is fresh (not the
// worker's id) so the worker's pubkey + worker job id stay internal.
type JobMapping = {
  peerPubkey: string;
  peerUrl: string;
  workerJobId: string;
  createdAt: number;
  // Set once we've ledgered the receipt so repeated polls don't try to
  // re-validate after the dedupe window has expired the nonce.
  receiptLedgered?: boolean;
  // Last-seen status (for eviction).
  lastStatus?: string;
  lastSeenAt?: number;
};

const jobMappings = new Map<string, JobMapping>();

const evictOldJobMappings = (): void => {
  const now = Date.now();
  for (const [id, m] of jobMappings) {
    const ttl = m.lastStatus === "error" ? JOB_ERROR_TTL_MS : JOB_DONE_TTL_MS;
    if (m.lastSeenAt && now - m.lastSeenAt > ttl) jobMappings.delete(id);
  }
};

setInterval(evictOldJobMappings, 5 * 60 * 1000).unref();

export type RouterOptions = {
  identity: Identity;
  port?: number;
  host?: string;
};

export type RunningRouter = {
  port: number;
  pubkey: string;
  stop: () => Promise<void>;
};

export type BuildRouterAppOptions = {
  identity: Identity;
};

export type RouterApp = {
  app: Hono;
  pubkey: string;
};

const DEFAULT_PORT = 17475;

const tryAcceptReceipt = async (
  b64: string,
  ourPubkey: string,
  peerPubkey: string,
): Promise<void> => {
  let signed: SignedReceipt;
  try {
    signed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as SignedReceipt;
  } catch {
    process.stderr.write(`router: malformed receipt from ${peerPubkey}\n`);
    return;
  }
  if (!verifyReceipt(signed)) {
    process.stderr.write(`router: rejected receipt from ${peerPubkey} (bad signature)\n`);
    return;
  }
  if (signed.receipt.requesterPubkey !== ourPubkey) {
    process.stderr.write(`router: rejected receipt from ${peerPubkey} (requester mismatch)\n`);
    return;
  }
  if (!isReceiptFresh(signed.receipt)) {
    process.stderr.write(`router: rejected receipt from ${peerPubkey} (expired or future-dated)\n`);
    return;
  }
  if (noteNonce(signed.receipt.nonce) === "replay") {
    process.stderr.write(`router: rejected receipt from ${peerPubkey} (nonce replay)\n`);
    return;
  }
  await append(signed);
};

type UpstreamAttempt = {
  upstream?: Response;
  peer?: Peer;
  errors: { peer: string; message: string }[];
  // Set when a worker returned a 4xx that's the same regardless of
  // peer (insufficient credit, malformed request, etc.). The router
  // short-circuits the fallback loop and surfaces this status to
  // the client directly.
  fatal?: { status: number; body: string; peer: string };
};

const openUpstreamWithFallback = async (
  candidates: Peer[],
  body: unknown,
  ourPubkey: string,
): Promise<UpstreamAttempt> => {
  const errors: { peer: string; message: string }[] = [];
  const policy = { blockPrivateNetwork: blockPrivateNetwork() };
  for (const peer of candidates) {
    // Re-check URL safety per request (DNS-rebind defense).
    const safe = await assertSafeUrl(peer.url, policy);
    if (!safe.ok) {
      markFailed(peer.pubkey);
      errors.push({
        peer: peer.pubkey.slice(0, 16),
        message: `unsafe peer URL: ${safe.reason}`,
      });
      continue;
    }
    const target = `${peer.url.replace(/\/$/, "")}/v1/chat/completions`;
    try {
      const r = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [REQUESTER_HEADER]: ourPubkey,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        // 402 (insufficient_credit), 400 (malformed request), and
        // related 4xx-bad-input cases will fail at every peer
        // identically — no point trying the next worker. Short-
        // circuit the fallback so the client sees the real error.
        // 5xx + connect failures still fall through (those are
        // worker-specific transient issues).
        if (r.status >= 400 && r.status < 500) {
          markSucceeded(peer.pubkey); // not the worker's fault
          return {
            errors,
            fatal: { status: r.status, body: text, peer: peer.pubkey.slice(0, 16) },
          };
        }
        markFailed(peer.pubkey);
        errors.push({
          peer: peer.pubkey.slice(0, 16),
          message: `${r.status} ${text.slice(0, 120)}`,
        });
        continue;
      }
      markSucceeded(peer.pubkey);
      return { upstream: r, peer, errors };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markFailed(peer.pubkey);
      errors.push({ peer: peer.pubkey.slice(0, 16), message: msg });
    }
  }
  return { errors };
};

export const buildRouterApp = (opts: BuildRouterAppOptions): RouterApp => {
  const ourPubkey = formatPubkey(opts.identity.publicKey);

  const app = new Hono();

  app.get("/", (c) => c.text("lobstah-router\n"));
  app.get("/pubkey", (c) => c.json({ pubkey: ourPubkey }));
  app.get("/peers", async (c) => c.json(await loadPeers()));

  app.get("/balance", async (c) => {
    const summary = computeBalances(await readAll());
    const self = summary.perPeer.get(ourPubkey) ?? {
      pubkey: ourPubkey,
      earned: 0,
      spent: 0,
      net: 0,
      allowance: BOOTSTRAP_ALLOWANCE_TOKENS,
      available: BOOTSTRAP_ALLOWANCE_TOKENS,
    };
    return c.json({
      pubkey: ourPubkey,
      totals: summary.totals,
      self,
      perPeer: Array.from(summary.perPeer.values()).sort(
        (a, b) => b.available - a.available,
      ),
      bootstrapAllowance: BOOTSTRAP_ALLOWANCE_TOKENS,
    });
  });

  // Recent receipts as a JSON feed. The `?limit=N` query caps how
  // many of the latest receipts to return (default 50, max 500). Used
  // by the /dashboard UI for the activity feed.
  app.get("/ledger", async (c) => {
    const limitRaw = c.req.query("limit");
    const limit = Math.max(
      1,
      Math.min(500, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 50),
    );
    const all = await readAll();
    const slice = all.slice(-limit).reverse();
    return c.json({
      total: all.length,
      returned: slice.length,
      receipts: slice,
    });
  });

  // Browser-friendly dashboard. Single-file static HTML that
  // self-fetches /balance, /peers, /ledger, /v1/models from the same
  // origin. No build pipeline, no npm dep — vanilla JS so the router
  // tarball stays small. For polymarket-style "browseable public
  // accounts" this is the v1; per-account drill-down + cross-node
  // federation are roadmap.
  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));

  app.get("/v1/models", async (c) => {
    const peers = await loadPeers();
    const seen = new Set<string>();
    const data: { id: string; object: "model"; owned_by: string }[] = [];
    await Promise.all(
      peers.map(async (peer) => {
        const cap = await getCapacity(peer);
        if (!cap) return;
        for (const m of cap.models) {
          if (seen.has(m)) continue;
          seen.add(m);
          data.push({
            id: m,
            object: "model",
            owned_by: `lobstah:${peer.label ?? peer.pubkey.slice(0, 12)}`,
          });
        }
      }),
    );
    return c.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", async (c) => {
    const peers = await loadPeers();
    if (peers.length === 0) {
      return c.json({ error: { type: "no_peers", message: "no peers configured" } }, 503);
    }

    const raw = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const candidates = await candidatesForModel(peers, parsed.data.model);
    if (candidates.length === 0) {
      return c.json(
        {
          error: {
            type: "no_capable_peer",
            model: parsed.data.model,
            message: `no healthy peer reports support for model "${parsed.data.model}"`,
          },
        },
        503,
      );
    }

    // Streaming chat completions are interactive-shaped: the client (or
    // their downstream user) is waiting on tokens. Bias toward peers that
    // self-tagged "interactive" but fall through if none exist.
    const tierPreferred = await preferTier(candidates, "interactive");
    const ordered = orderCandidates(tierPreferred);
    const attempt = await openUpstreamWithFallback(ordered, parsed.data, ourPubkey);

    // Worker-emitted 4xx (insufficient_credit, bad request, etc.)
    // means every peer would respond the same way — surface the
    // exact status + body to the client.
    if (attempt.fatal) {
      return new Response(attempt.fatal.body, {
        status: attempt.fatal.status,
        headers: { "content-type": "application/json" },
      });
    }

    const { upstream, peer, errors } = attempt;

    if (!upstream || !peer) {
      return c.json(
        {
          error: {
            type: "all_peers_failed",
            attempts: errors.length,
            errors,
          },
        },
        502,
      );
    }

    if (parsed.data.stream && upstream.body) {
      const upstreamBody = upstream.body;
      const peerPubkey = peer.pubkey;
      return streamSSE(c, async (sse) => {
        const reader = upstreamBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            if (event.startsWith(`${RECEIPT_SSE_PREFIX}:`)) {
              const b64 = event.slice(RECEIPT_SSE_PREFIX.length + 1).trim();
              await tryAcceptReceipt(b64, ourPubkey, peerPubkey);
              continue;
            }
            await sse.write(`${event}\n\n`);
          }
        }
      });
    }

    const upstreamBody = await upstream.text();
    const upstreamCT = upstream.headers.get("content-type") ?? "application/json";
    const receiptHdr = upstream.headers.get(RECEIPT_HEADER);

    if (receiptHdr) {
      await tryAcceptReceipt(receiptHdr, ourPubkey, peer.pubkey);
    }

    const headers: Record<string, string> = { "content-type": upstreamCT };
    if (receiptHdr) headers[RECEIPT_HEADER] = receiptHdr;
    return new Response(upstreamBody, { status: upstream.status, headers });
  });

  // ── Async job API ────────────────────────────────────────────────────
  // Cargo-shaped workloads: submit-and-poll instead of holding a stream.
  // Client-facing jobIds are fresh UUIDs; the worker's own job id stays
  // internal to the router's mapping table.

  app.post("/v1/jobs", async (c) => {
    const peers = await loadPeers();
    if (peers.length === 0) {
      return c.json({ error: { type: "no_peers", message: "no peers configured" } }, 503);
    }

    const raw = await c.req.json();
    const parsed = JobSubmitRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const candidates = await candidatesForModel(peers, parsed.data.model);
    if (candidates.length === 0) {
      return c.json(
        {
          error: {
            type: "no_capable_peer",
            model: parsed.data.model,
            message: `no healthy peer reports support for model "${parsed.data.model}"`,
          },
        },
        503,
      );
    }
    // Job submissions are cargo-shaped — the caller has already accepted
    // that the work runs out-of-band. Prefer "batch" peers; fall back to
    // any tier so we still place the work somewhere if no batch peer is
    // reachable.
    const tierPreferred = await preferTier(candidates, "batch");
    const ordered = orderCandidates(tierPreferred);

    const policy = { blockPrivateNetwork: blockPrivateNetwork() };
    const errors: { peer: string; message: string }[] = [];
    for (const peer of ordered) {
      const safe = await assertSafeUrl(peer.url, policy);
      if (!safe.ok) {
        markFailed(peer.pubkey);
        errors.push({ peer: peer.pubkey.slice(0, 16), message: `unsafe peer URL: ${safe.reason}` });
        continue;
      }
      const target = `${peer.url.replace(/\/$/, "")}/v1/jobs`;
      try {
        const r = await fetch(target, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [REQUESTER_HEADER]: ourPubkey,
          },
          body: JSON.stringify(parsed.data),
        });
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          markFailed(peer.pubkey);
          errors.push({
            peer: peer.pubkey.slice(0, 16),
            message: `${r.status} ${text.slice(0, 120)}`,
          });
          continue;
        }
        const workerJob = (await r.json()) as JobRecord;
        const clientJobId = randomUUID();
        jobMappings.set(clientJobId, {
          peerPubkey: peer.pubkey,
          peerUrl: peer.url,
          workerJobId: workerJob.jobId,
          createdAt: Date.now(),
          lastStatus: workerJob.status,
          lastSeenAt: Date.now(),
        });
        markSucceeded(peer.pubkey);
        return c.json(
          {
            jobId: clientJobId,
            status: workerJob.status,
            createdAt: workerJob.createdAt,
          },
          202,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        markFailed(peer.pubkey);
        errors.push({ peer: peer.pubkey.slice(0, 16), message: msg });
      }
    }
    return c.json(
      { error: { type: "all_peers_failed", attempts: errors.length, errors } },
      502,
    );
  });

  app.get("/v1/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const mapping = jobMappings.get(id);
    if (!mapping) return c.json({ error: { type: "not_found", message: "job not found" } }, 404);
    const target = `${mapping.peerUrl.replace(/\/$/, "")}/v1/jobs/${mapping.workerJobId}`;
    let r: Response;
    try {
      r = await fetch(target);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: { type: "peer_unreachable", message: msg } }, 502);
    }
    if (!r.ok) {
      return new Response(await r.text(), {
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
      });
    }
    const job = (await r.json()) as JobRecord;
    mapping.lastStatus = job.status;
    mapping.lastSeenAt = Date.now();

    // Ledger the receipt the first time the job is done (nonce dedupe is
    // also defense-in-depth; this just avoids extra work on repeat polls).
    if (job.status === "done" && job.signedReceipt && !mapping.receiptLedgered) {
      const b64 = Buffer.from(JSON.stringify(job.signedReceipt), "utf8").toString("base64");
      await tryAcceptReceipt(b64, ourPubkey, mapping.peerPubkey);
      mapping.receiptLedgered = true;
    }

    // Strip the signed receipt before returning to the client (it's a
    // router-internal accounting artifact). Re-export the public fields.
    const { signedReceipt: _internal, ...publicJob } = job;
    return c.json({ ...publicJob, jobId: id }); // overwrite with our client-facing id
  });

  app.delete("/v1/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const mapping = jobMappings.get(id);
    if (!mapping) return c.json({ error: { type: "not_found" } }, 404);
    const target = `${mapping.peerUrl.replace(/\/$/, "")}/v1/jobs/${mapping.workerJobId}`;
    try {
      const r = await fetch(target, { method: "DELETE" });
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: { type: "peer_unreachable", message: msg } }, 502);
    }
  });

  return { app, pubkey: ourPubkey };
};

export const startRouter = async (opts: RouterOptions): Promise<RunningRouter> => {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "127.0.0.1";
  const built = buildRouterApp({ identity: opts.identity });
  const server = serve({ fetch: built.app.fetch, hostname: host, port });
  return {
    port,
    pubkey: built.pubkey,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};
