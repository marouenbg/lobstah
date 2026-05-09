import type { WorkerEngine } from "@lobstah/engine-ollama";
import {
  formatPubkey,
  generateIdentity,
  RECEIPT_HEADER,
  RECEIPT_SSE_PREFIX,
  REQUESTER_HEADER,
  type SignedReceipt,
  verifyReceipt,
} from "@lobstah/protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkerApp } from "./server.js";

const enc = new TextEncoder();

const ollamaContentChunk = (delta: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;

const ollamaUsageChunk = (input: number, output: number): string =>
  `data: ${JSON.stringify({
    choices: [],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    },
  })}\n\n`;

const DONE_CHUNK = "data: [DONE]\n\n";

const mockEngine = (
  chunks: string[],
  models: string[] = ["llama3.1:8b"],
): WorkerEngine => ({
  name: "mock",
  listModels: async () => models,
  chat: async () => ({
    payload: { id: "ok", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } },
    inputTokens: 0,
    outputTokens: 0,
  }),
  chatStream: async () => ({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
  }),
});

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "lobstah-worker-test-"));
  process.env.LOBSTAH_LEDGER = join(dir, "ledger.jsonl");
});

afterEach(() => {
  delete process.env.LOBSTAH_LEDGER;
});

describe("worker streaming SSE contract", () => {
  it("forwards content + usage chunks, embeds signed receipt, ends with [DONE]", async () => {
    const worker = generateIdentity();
    const requester = generateIdentity();
    const requesterPk = formatPubkey(requester.publicKey);
    const workerPk = formatPubkey(worker.publicKey);

    const { app } = buildWorkerApp({
      identity: worker,
      engine: mockEngine([
        ollamaContentChunk("Hel"),
        ollamaContentChunk("lo"),
        ollamaUsageChunk(7, 2),
        DONE_CHUNK,
      ]),
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [REQUESTER_HEADER]: requesterPk,
      },
      body: JSON.stringify({
        model: "llama3.1:8b",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const res = await app.fetch(req);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const body = await res.text();

    const events = body.split("\n\n").filter((e) => e.length > 0);
    const dataLines = events.filter((e) => e.startsWith("data: "));
    const receiptLines = events.filter((e) => e.startsWith(`${RECEIPT_SSE_PREFIX}:`));

    expect(dataLines.length).toBe(4);
    expect(receiptLines.length).toBe(1);
    expect(events.at(-1)).toBe("data: [DONE]");

    const b64 = receiptLines[0].slice(`${RECEIPT_SSE_PREFIX}:`.length).trim();
    const signed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as SignedReceipt;

    expect(verifyReceipt(signed)).toBe(true);
    expect(signed.receipt.workerPubkey).toBe(workerPk);
    expect(signed.receipt.requesterPubkey).toBe(requesterPk);
    expect(signed.receipt.model).toBe("llama3.1:8b");
    expect(signed.receipt.inputTokens).toBe(7);
    expect(signed.receipt.outputTokens).toBe(2);
    expect(signed.receipt.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("/capacity reflects the configured tier (defaults to best-effort)", async () => {
    const worker = generateIdentity();
    const engine: WorkerEngine = {
      name: "mock",
      listModels: async () => ["llama3.1:8b"],
      chat: async () => ({
        payload: {},
        inputTokens: 0,
        outputTokens: 0,
      }),
      chatStream: async () => {
        throw new Error("not used");
      },
    };

    const defaulted = buildWorkerApp({ identity: worker, engine });
    const r1 = await defaulted.app.fetch(new Request("http://localhost/capacity"));
    const c1 = (await r1.json()) as { tier?: string };
    expect(c1.tier).toBe("best-effort");
    defaulted.jobs.shutdown();

    const tagged = buildWorkerApp({ identity: worker, engine, tier: "batch" });
    const r2 = await tagged.app.fetch(new Request("http://localhost/capacity"));
    const c2 = (await r2.json()) as { tier?: string };
    expect(c2.tier).toBe("batch");
    tagged.jobs.shutdown();
  });

  it("non-streaming path returns receipt as header", async () => {
    const worker = generateIdentity();
    const requester = generateIdentity();

    const engine: WorkerEngine = {
      name: "mock",
      listModels: async () => ["llama3.1:8b"],
      chat: async () => ({
        payload: {
          id: "ok",
          choices: [{ message: { role: "assistant", content: "pong" } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        },
        inputTokens: 5,
        outputTokens: 1,
      }),
      chatStream: async () => {
        throw new Error("should not be called");
      },
    };

    const { app } = buildWorkerApp({ identity: worker, engine });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [REQUESTER_HEADER]: formatPubkey(requester.publicKey),
      },
      body: JSON.stringify({
        model: "llama3.1:8b",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const hdr = res.headers.get(RECEIPT_HEADER);
    expect(hdr).toBeTruthy();
    const signed = JSON.parse(Buffer.from(hdr ?? "", "base64").toString("utf8")) as SignedReceipt;
    expect(verifyReceipt(signed)).toBe(true);
    expect(signed.receipt.inputTokens).toBe(5);
    expect(signed.receipt.outputTokens).toBe(1);
  });
});

describe("worker credit enforcement", () => {
  // Mock engine that records request count + simulates a small inference.
  const recordingEngine = (
    inputTokens = 5,
    outputTokens = 5,
  ): WorkerEngine & { calls: number } => {
    const e = {
      name: "mock",
      calls: 0,
      listModels: async () => ["llama3.1:8b"],
      chat: async () => {
        e.calls += 1;
        return {
          payload: { id: "ok", choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } },
          inputTokens,
          outputTokens,
        };
      },
      chatStream: async () => {
        throw new Error("not used");
      },
    };
    return e;
  };

  // Pre-write receipts to LOBSTAH_LEDGER that drain the requester's balance
  // by N tokens. Each receipt is signed by a transient worker identity so
  // it's structurally valid (verifyReceipt would pass), but the worker we
  // build below uses a SEPARATE identity, so these "previous transactions"
  // belong to a different worker — exactly what we want to simulate
  // "requester has spent N tokens with various workers."
  const drainRequester = async (requesterPk: string, totalTokens: number): Promise<void> => {
    const { signReceipt, generateNonce } = await import("@lobstah/protocol");
    const { append: appendLedger } = await import("@lobstah/ledger");
    let remaining = totalTokens;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 1000);
      const ghostWorker = generateIdentity();
      const ghostWorkerPk = formatPubkey(ghostWorker.publicKey);
      const signed = signReceipt(
        {
          version: 1,
          jobId: `drain-${remaining}`,
          nonce: generateNonce(),
          requesterPubkey: requesterPk,
          workerPubkey: ghostWorkerPk,
          model: "drain",
          inputTokens: chunk,
          outputTokens: 0,
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
        },
        ghostWorker.secretKey,
      );
      await appendLedger(signed);
      remaining -= chunk;
    }
  };

  const sendChat = async (
    app: ReturnType<typeof buildWorkerApp>["app"],
    requesterPk: string | null,
  ) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (requesterPk !== null) headers[REQUESTER_HEADER] = requesterPk;
    return app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "llama3.1:8b",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
  };

  it("EDGE 1 — fresh requester (never seen) gets bootstrap allowance, request succeeds", async () => {
    const worker = generateIdentity();
    const fresh = generateIdentity();
    const engine = recordingEngine();
    const { app, jobs } = buildWorkerApp({
      identity: worker,
      engine,
      // Critical: turn off Nostr publish so the test doesn't try to
      // hit live relays.
      publishReceiptsToNostr: false,
    });
    const res = await sendChat(app, formatPubkey(fresh.publicKey));
    expect(res.status).toBe(200);
    expect(engine.calls).toBe(1);
    jobs.shutdown();
  });

  it("EDGE 2 — drained requester (available <= 0) gets 402, engine never called", async () => {
    const { BOOTSTRAP_ALLOWANCE_TOKENS } = await import("@lobstah/protocol");
    const worker = generateIdentity();
    const drained = generateIdentity();
    const drainedPk = formatPubkey(drained.publicKey);

    // Drain to exactly 0 available.
    await drainRequester(drainedPk, BOOTSTRAP_ALLOWANCE_TOKENS);

    const engine = recordingEngine();
    const { app, jobs } = buildWorkerApp({
      identity: worker,
      engine,
      publishReceiptsToNostr: false,
    });

    const res = await sendChat(app, drainedPk);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { type: string; availableTokens: number } };
    expect(body.error.type).toBe("insufficient_credit");
    expect(body.error.availableTokens).toBe(0);
    expect(engine.calls).toBe(0); // no work done
    jobs.shutdown();
  });

  it("EDGE 3 — anonymous request (no REQUESTER_HEADER) bypasses the check", async () => {
    const worker = generateIdentity();
    const engine = recordingEngine();
    const { app, jobs } = buildWorkerApp({
      identity: worker,
      engine,
      publishReceiptsToNostr: false,
    });
    const res = await sendChat(app, null);
    expect(res.status).toBe(200);
    expect(engine.calls).toBe(1);
    jobs.shutdown();
  });

  it("EDGE 4 — enforceBalance: false disables the gate entirely", async () => {
    const { BOOTSTRAP_ALLOWANCE_TOKENS } = await import("@lobstah/protocol");
    const worker = generateIdentity();
    const drained = generateIdentity();
    const drainedPk = formatPubkey(drained.publicKey);
    await drainRequester(drainedPk, BOOTSTRAP_ALLOWANCE_TOKENS + 5000); // way overdrawn

    const engine = recordingEngine();
    const { app, jobs } = buildWorkerApp({
      identity: worker,
      engine,
      enforceBalance: false,
      publishReceiptsToNostr: false,
    });

    const res = await sendChat(app, drainedPk);
    expect(res.status).toBe(200); // no 402 — enforcement off
    expect(engine.calls).toBe(1);
    jobs.shutdown();
  });

  it("EDGE 5 — sequential drain: balance decrements; 402 fires on the request that would push past 0", async () => {
    const { BOOTSTRAP_ALLOWANCE_TOKENS } = await import("@lobstah/protocol");
    const worker = generateIdentity();
    const requester = generateIdentity();
    const requesterPk = formatPubkey(requester.publicKey);

    // Drain to leave only ~50 tokens available.
    await drainRequester(requesterPk, BOOTSTRAP_ALLOWANCE_TOKENS - 50);

    // Mock engine that records request count + drains exactly 30 tokens
    // per call (15+15).
    const engine = recordingEngine(15, 15);
    const { app, jobs } = buildWorkerApp({
      identity: worker,
      engine,
      publishReceiptsToNostr: false,
    });

    // Request 1: available=50 > 0 → serves, drains 30, available=20.
    const r1 = await sendChat(app, requesterPk);
    expect(r1.status).toBe(200);
    expect(engine.calls).toBe(1);

    // Request 2: available=20 > 0 → serves, drains 30, available=-10.
    const r2 = await sendChat(app, requesterPk);
    expect(r2.status).toBe(200);
    expect(engine.calls).toBe(2);

    // Request 3: available=-10 NOT > 0 → 402, no engine call.
    const r3 = await sendChat(app, requesterPk);
    expect(r3.status).toBe(402);
    expect(engine.calls).toBe(2); // still 2 — third request didn't hit engine

    jobs.shutdown();
  });

  it("EDGE 6 — Sybil: each fresh identity gets its own 10K (this is the known limitation)", async () => {
    const worker = generateIdentity();
    const engine = recordingEngine();
    const { app, jobs } = buildWorkerApp({
      identity: worker,
      engine,
      publishReceiptsToNostr: false,
    });

    // Five fresh identities, each making a request. All succeed because
    // each gets its own bootstrap allowance. This documents the Sybil
    // hole: an attacker can mint identities to claim free credits.
    for (let i = 0; i < 5; i++) {
      const sybil = generateIdentity();
      const res = await sendChat(app, formatPubkey(sybil.publicKey));
      expect(res.status).toBe(200);
    }
    expect(engine.calls).toBe(5);
    jobs.shutdown();
  });
});
