import { serve } from "@hono/node-server";
import { type WorkerEngine, OllamaEngine } from "@lobstah/engine-ollama";
import {
  append as appendLedger,
  availableCredits,
  readAll as readAllLedger,
} from "@lobstah/ledger";
import {
  ChatCompletionRequestSchema,
  DEFAULT_WORKER_TIER,
  type Identity,
  JobSubmitRequestSchema,
  RECEIPT_HEADER,
  RECEIPT_SSE_PREFIX,
  REQUESTER_HEADER,
  type Receipt,
  type SignedReceipt,
  type WorkerTier,
  formatPubkey,
  generateNonce,
  signReceipt,
} from "@lobstah/protocol";
import { DEFAULT_RELAYS, publishReceipt } from "@lobstah/transport-nostr";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { JobStore } from "./jobs.js";

export type WorkerOptions = {
  identity: Identity;
  port?: number;
  host?: string;
  engine?: WorkerEngine;
  tier?: WorkerTier;
  concurrency?: number;
  /**
   * If true (default), the worker refuses to serve requests from
   * accounts whose available credit (bootstrap allowance + earned -
   * spent, computed from the LOCAL ledger) is below zero. New
   * accounts the worker has never seen still get the default
   * BOOTSTRAP_ALLOWANCE_TOKENS credit. Set to false to disable
   * enforcement entirely.
   */
  enforceBalance?: boolean;
  /**
   * If true (default), every signed receipt the worker creates is
   * also published as a Nostr event (kind 1474) so the network can
   * build a public-account view. Set to false for a private worker
   * that doesn't contribute to the federated ledger.
   */
  publishReceiptsToNostr?: boolean;
  /**
   * Custom Nostr relay set for receipt publishing. Defaults to the
   * lobstah default relays (damus.io, nos.lol, relay.nostr.band).
   */
  nostrRelays?: ReadonlyArray<string>;
};

export type RunningWorker = {
  port: number;
  pubkey: string;
  engine: string;
  tier: WorkerTier;
  concurrency: number;
  stop: () => Promise<void>;
};

export type BuildWorkerAppOptions = {
  identity: Identity;
  engine?: WorkerEngine;
  tier?: WorkerTier;
  concurrency?: number;
  enforceBalance?: boolean;
  publishReceiptsToNostr?: boolean;
  nostrRelays?: ReadonlyArray<string>;
};

export type WorkerApp = {
  app: Hono;
  pubkey: string;
  engine: string;
  tier: WorkerTier;
  concurrency: number;
  jobs: JobStore;
};

const DEFAULT_PORT = 17474;

export const buildWorkerApp = (opts: BuildWorkerAppOptions): WorkerApp => {
  const engine: WorkerEngine = opts.engine ?? new OllamaEngine();
  const tier: WorkerTier = opts.tier ?? DEFAULT_WORKER_TIER;
  const enforceBalance = opts.enforceBalance ?? true;
  const publishNostr = opts.publishReceiptsToNostr ?? true;
  const nostrRelays = opts.nostrRelays ?? DEFAULT_RELAYS;
  const workerPubkey = formatPubkey(opts.identity.publicKey);

  // Pre-flight credit check: refuse the request if the requester
  // has no available credit. Returns null if OK to serve, or the
  // 402 response if not. Reads the local ledger only — for the
  // network-wide view, an aggregator/router would gather receipts
  // from Nostr and pass them in.
  const checkCredit = async (requesterPubkey: string): Promise<{
    ok: boolean;
    available: number;
  }> => {
    if (!enforceBalance || requesterPubkey === "anonymous") {
      // Anonymous requests bypass the check (router didn't supply
      // an identity header). Routers SHOULD always send their
      // pubkey; bypassing here is defensive against test setups.
      return { ok: true, available: Number.POSITIVE_INFINITY };
    }
    const ledger = await readAllLedger();
    const available = availableCredits(requesterPubkey, ledger);
    return { ok: available > 0, available };
  };

  // Fire-and-forget publish to Nostr. Worker doesn't block on this:
  // the receipt is already in the local ledger, and clients have
  // already received their response. Nostr publish is "best effort
  // for the public ledger."
  const publishToNostrInBackground = (signed: SignedReceipt): void => {
    if (!publishNostr) return;
    void publishReceipt(signed, opts.identity.nostrSecretKey, {
      relays: nostrRelays,
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`worker: receipt Nostr publish failed: ${msg}\n`);
    });
  };

  const buildReceipt = (
    jobId: string,
    requesterPubkey: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    startedAt: number,
  ): Receipt => ({
    version: 1,
    jobId,
    nonce: generateNonce(),
    requesterPubkey,
    workerPubkey,
    model,
    inputTokens,
    outputTokens,
    startedAt,
    completedAt: Date.now(),
  });

  const jobs = new JobStore({
    identity: opts.identity,
    engine,
    concurrency: opts.concurrency,
    onReceiptSigned: publishToNostrInBackground,
  });
  const app = new Hono();

  app.get("/", (c) => c.text("lobstah-worker\n"));
  app.get("/pubkey", (c) => c.json({ pubkey: workerPubkey }));

  app.get("/capacity", async (c) => {
    const models = await engine.listModels();
    const counts = jobs.size();
    return c.json({
      pubkey: workerPubkey,
      models,
      tier,
      concurrency: jobs.getConcurrency(),
      queueDepth: counts.queued + counts.running,
      jobCounts: counts,
    });
  });

  app.get("/v1/models", async (c) => {
    const models = await engine.listModels();
    return c.json({
      object: "list",
      data: models.map((id) => ({ id, object: "model" as const, owned_by: `lobstah:${workerPubkey.slice(0, 12)}` })),
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    const requesterPubkey = c.req.header(REQUESTER_HEADER) ?? "anonymous";
    const raw = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    // Credit gate: refuse if requester has no available balance.
    // Returns 402 Payment Required so routers can map it to a
    // human-readable error and fail-fast without the engine doing
    // any work.
    const credit = await checkCredit(requesterPubkey);
    if (!credit.ok) {
      return c.json(
        {
          error: {
            type: "insufficient_credit",
            message: `requester has ${credit.available} tokens of available credit (>0 required)`,
            availableTokens: credit.available,
            requesterPubkey,
          },
        },
        402,
      );
    }

    const startedAt = Date.now();
    const jobId = randomUUID();

    if (parsed.data.stream) {
      let upstream;
      try {
        upstream = await engine.chatStream(parsed.data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: { type: "engine_error", message: msg } }, 502);
      }

      return streamSSE(c, async (sse) => {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let inputTokens = 0;
        let outputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              const dataStr = dataLine.slice(6).trim();
              if (dataStr === "[DONE]") {
                continue;
              }
              try {
                const obj = JSON.parse(dataStr) as {
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                if (obj.usage) {
                  inputTokens = obj.usage.prompt_tokens ?? inputTokens;
                  outputTokens = obj.usage.completion_tokens ?? outputTokens;
                }
              } catch {
                // forward malformed chunks unchanged
              }
            }
            await sse.write(`${event}\n\n`);
          }
        }

        const receipt = buildReceipt(
          jobId,
          requesterPubkey,
          parsed.data.model,
          inputTokens,
          outputTokens,
          startedAt,
        );
        const signed = signReceipt(receipt, opts.identity.secretKey);
        await appendLedger(signed);
        publishToNostrInBackground(signed);
        const b64 = Buffer.from(JSON.stringify(signed), "utf8").toString("base64");
        await sse.write(`${RECEIPT_SSE_PREFIX}:${b64}\n\n`);
        await sse.write("data: [DONE]\n\n");
      });
    }

    let result;
    try {
      result = await engine.chat(parsed.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: { type: "engine_error", message: msg } }, 502);
    }

    const receipt = buildReceipt(
      jobId,
      requesterPubkey,
      parsed.data.model,
      result.inputTokens,
      result.outputTokens,
      startedAt,
    );
    const signed = signReceipt(receipt, opts.identity.secretKey);
    await appendLedger(signed);
    publishToNostrInBackground(signed);
    c.header(RECEIPT_HEADER, Buffer.from(JSON.stringify(signed), "utf8").toString("base64"));
    return c.json(result.payload);
  });

  // Async job API (cargo workloads): submit + poll instead of holding a stream.
  app.post("/v1/jobs", async (c) => {
    const requesterPubkey = c.req.header(REQUESTER_HEADER) ?? "anonymous";
    const raw = await c.req.json();
    const parsed = JobSubmitRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    // Same credit gate as the synchronous path. Refused requests
    // never enter the queue; the requester sees a 402 immediately.
    const credit = await checkCredit(requesterPubkey);
    if (!credit.ok) {
      return c.json(
        {
          error: {
            type: "insufficient_credit",
            message: `requester has ${credit.available} tokens of available credit (>0 required)`,
            availableTokens: credit.available,
            requesterPubkey,
          },
        },
        402,
      );
    }
    const job = jobs.submit(parsed.data, requesterPubkey);
    return c.json(job, 202);
  });

  app.get("/v1/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: { type: "not_found", message: "job not found" } }, 404);
    return c.json(job);
  });

  app.delete("/v1/jobs/:id", (c) => {
    const id = c.req.param("id");
    const ok = jobs.cancel(id);
    if (!ok) return c.json({ error: { type: "not_cancellable" } }, 409);
    return c.json({ jobId: id, status: "error", error: { type: "cancelled" } });
  });

  return {
    app,
    pubkey: workerPubkey,
    engine: engine.name,
    tier,
    concurrency: jobs.getConcurrency(),
    jobs,
  };
};

export const startWorker = async (opts: WorkerOptions): Promise<RunningWorker> => {
  const port = opts.port ?? DEFAULT_PORT;
  // Loopback by default. The worker exposes Ollama-backed inference with no
  // authentication on the API surface, so binding it to all interfaces would
  // silently expose local compute to the LAN. Operators who want network
  // exposure must pass --host explicitly (e.g. `--host 0.0.0.0`).
  const host = opts.host ?? "127.0.0.1";
  const built = buildWorkerApp({
    identity: opts.identity,
    engine: opts.engine,
    tier: opts.tier,
    concurrency: opts.concurrency,
    enforceBalance: opts.enforceBalance,
    publishReceiptsToNostr: opts.publishReceiptsToNostr,
    nostrRelays: opts.nostrRelays,
  });

  // Recover any persisted jobs from a prior run (queued + running both end
  // up requeued — fresh receipts will be issued on completion, with nonce
  // dedupe protecting any old receipts that may have leaked out).
  const hydrated = await built.jobs.hydrate();
  if (hydrated.loaded > 0) {
    process.stdout.write(
      `  recovered ${hydrated.loaded} job(s) from log (${hydrated.requeued} requeued, ${hydrated.droppedExpired} expired)\n`,
    );
  }

  const server = serve({ fetch: built.app.fetch, hostname: host, port });
  return {
    port,
    pubkey: built.pubkey,
    engine: built.engine,
    tier: built.tier,
    concurrency: built.concurrency,
    stop: async () => {
      await built.jobs.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};

