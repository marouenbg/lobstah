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
