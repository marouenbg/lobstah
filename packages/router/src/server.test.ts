import { readAll } from "@lobstah/ledger";
import {
  formatPubkey,
  generateIdentity,
  generateNonce,
  type Receipt,
  RECEIPT_SSE_PREFIX,
  signReceipt,
} from "@lobstah/protocol";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNonceStore } from "./nonce-store.js";
import { resetPeerState } from "./peer-state.js";
import { resetCursor } from "./pick.js";
import { buildRouterApp } from "./server.js";

const enc = new TextEncoder();
// Use a literal IP from RFC5737 TEST-NET-1 so assertSafeUrl skips DNS lookup
// and treats it as a public address (the fetch mock intercepts before any
// real network call would be made).
const PEER_URL = "http://192.0.2.1:17474";

const ollamaContentChunk = (delta: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;

let tmpDir: string;
let ledgerPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lobstah-router-test-"));
  ledgerPath = join(tmpDir, "ledger.jsonl");
  // Peers path is still env-driven (peers.ts hasn't been refactored
  // yet to take an explicit path); the ledger path is now passed
  // explicitly to buildRouterApp({ ledgerPath }) so it's race-free
  // even with parallel tests.
  process.env.LOBSTAH_PEERS = join(tmpDir, "peers.json");
  resetPeerState();
  resetNonceStore();
  resetCursor();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOBSTAH_PEERS;
});

describe("router streaming SSE contract", () => {
  it("forwards data chunks to client, strips receipt comment, appends to ledger", async () => {
    const router = generateIdentity();
    const worker = generateIdentity();
    const routerPk = formatPubkey(router.publicKey);
    const workerPk = formatPubkey(worker.publicKey);

    // peers.json with our fake worker
    await writeFile(
      process.env.LOBSTAH_PEERS!,
      JSON.stringify([{ pubkey: workerPk, url: PEER_URL, label: "test" }]),
    );

    // Build the receipt the fake worker will sign and embed in its SSE tail
    const receipt: Receipt = {
      version: 1,
      jobId: "job-test-1",
      nonce: generateNonce(),
      requesterPubkey: routerPk,
      workerPubkey: workerPk,
      model: "llama3.1:8b",
      inputTokens: 7,
      outputTokens: 2,
      startedAt: Date.now() - 100,
      completedAt: Date.now(),
    };
    const signed = signReceipt(receipt, worker.secretKey);
    const receiptB64 = Buffer.from(JSON.stringify(signed), "utf8").toString("base64");

    const sseBody =
      ollamaContentChunk("Hel") +
      ollamaContentChunk("lo") +
      `${RECEIPT_SSE_PREFIX}:${receiptB64}\n\n` +
      "data: [DONE]\n\n";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/capacity")) {
        return new Response(
          JSON.stringify({ pubkey: workerPk, models: ["llama3.1:8b"], queueDepth: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/chat/completions")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(sseBody));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { app } = buildRouterApp({ identity: router, ledgerPath });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama3.1:8b",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.text();
    const events = body.split("\n\n").filter((e) => e.length > 0);

    expect(events.some((e) => e.startsWith(`${RECEIPT_SSE_PREFIX}:`))).toBe(false);
    expect(events.filter((e) => e.startsWith("data: ")).length).toBe(3);
    expect(events.at(-1)).toBe("data: [DONE]");

    const ledger = await readAll(ledgerPath);
    expect(ledger.length).toBe(1);
    expect(ledger[0].receipt.nonce).toBe(receipt.nonce);
    expect(ledger[0].receipt.workerPubkey).toBe(workerPk);
    expect(ledger[0].receipt.requesterPubkey).toBe(routerPk);
    expect(ledger[0].receipt.inputTokens).toBe(7);
    expect(ledger[0].receipt.outputTokens).toBe(2);
  });

  it("rejects a replayed receipt: ledger size stays at 1 across two identical requests", async () => {
    const router = generateIdentity();
    const worker = generateIdentity();
    const routerPk = formatPubkey(router.publicKey);
    const workerPk = formatPubkey(worker.publicKey);

    await writeFile(
      process.env.LOBSTAH_PEERS!,
      JSON.stringify([{ pubkey: workerPk, url: PEER_URL, label: "test" }]),
    );

    // Same receipt sent twice (worker would never do this, but a buggy/malicious peer could)
    const receipt: Receipt = {
      version: 1,
      jobId: "job-replay",
      nonce: generateNonce(),
      requesterPubkey: routerPk,
      workerPubkey: workerPk,
      model: "llama3.1:8b",
      inputTokens: 3,
      outputTokens: 4,
      startedAt: Date.now() - 100,
      completedAt: Date.now(),
    };
    const signed = signReceipt(receipt, worker.secretKey);
    const receiptB64 = Buffer.from(JSON.stringify(signed), "utf8").toString("base64");
    const sseBody =
      ollamaContentChunk("hi") + `${RECEIPT_SSE_PREFIX}:${receiptB64}\n\n` + "data: [DONE]\n\n";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/capacity")) {
        return new Response(
          JSON.stringify({ pubkey: workerPk, models: ["llama3.1:8b"], queueDepth: 0 }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/chat/completions")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(sseBody));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { app } = buildRouterApp({ identity: router, ledgerPath });
    const makeReq = () =>
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "llama3.1:8b",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    const res1 = await app.fetch(makeReq());
    await res1.text();
    const res2 = await app.fetch(makeReq());
    await res2.text();

    const ledger = await readAll(ledgerPath);
    expect(ledger.length).toBe(1);
  });
});
