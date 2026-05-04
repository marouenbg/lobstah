import type { ChatResult, WorkerEngine } from "@lobstah/engine-ollama";
import {
  type ChatCompletionRequest,
  formatPubkey,
  generateIdentity,
  verifyReceipt,
} from "@lobstah/protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "./jobs.js";

const stallableEngine = (
  models: string[] = ["llama3.1:8b"],
): {
  engine: WorkerEngine;
  release: (result?: ChatResult) => void;
  fail: (error: Error) => void;
  pendingResolves: number;
} => {
  let resolve!: (r: ChatResult) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<ChatResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const engine: WorkerEngine = {
    name: "stallable",
    listModels: async () => models,
    chat: async (_: ChatCompletionRequest) => promise,
    chatStream: async () => {
      throw new Error("not used");
    },
  };
  return {
    engine,
    release: (r) =>
      resolve(
        r ?? {
          payload: { ok: true },
          inputTokens: 11,
          outputTokens: 7,
        },
      ),
    fail: (e) => reject(e),
    pendingResolves: 1,
  };
};

const makeReq = (overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({
  model: "llama3.1:8b",
  stream: false,
  messages: [{ role: "user", content: "hi" }],
  ...overrides,
});

const waitFor = async (
  condition: () => boolean,
  { timeoutMs = 1000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "lobstah-jobs-test-"));
  process.env.LOBSTAH_LEDGER = join(dir, "ledger.jsonl");
});

afterEach(() => {
  delete process.env.LOBSTAH_LEDGER;
});

describe("JobStore", () => {
  it("submit + immediately-poll returns queued or running", async () => {
    const id = generateIdentity();
    const stall = stallableEngine();
    const store = new JobStore({ identity: id, engine: stall.engine });
    const job = store.submit(makeReq(), formatPubkey(generateIdentity().publicKey));
    expect(job.status).toBe("queued");
    expect(job.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.createdAt).toBeGreaterThan(0);

    // After yielding, the processor will pick it up and mark it running
    await Promise.resolve();
    const polled = store.get(job.jobId);
    expect(polled?.status === "queued" || polled?.status === "running").toBe(true);

    stall.release();
    store.shutdown();
  });

  it("processes a job to completion + signs a verifiable receipt", async () => {
    const worker = generateIdentity();
    const requester = generateIdentity();
    const requesterPk = formatPubkey(requester.publicKey);
    const stall = stallableEngine();
    const store = new JobStore({ identity: worker, engine: stall.engine });

    const submitted = store.submit(makeReq(), requesterPk);
    await waitFor(() => store.get(submitted.jobId)?.status === "running");
    stall.release({ payload: { hello: "world" }, inputTokens: 13, outputTokens: 4 });
    await waitFor(() => store.get(submitted.jobId)?.status === "done");

    const done = store.get(submitted.jobId);
    expect(done?.status).toBe("done");
    expect(done?.result).toEqual({ hello: "world" });
    expect(done?.signedReceipt).toBeDefined();
    if (!done?.signedReceipt) throw new Error("no receipt");
    expect(verifyReceipt(done.signedReceipt)).toBe(true);
    expect(done.signedReceipt.receipt.requesterPubkey).toBe(requesterPk);
    expect(done.signedReceipt.receipt.workerPubkey).toBe(formatPubkey(worker.publicKey));
    expect(done.signedReceipt.receipt.inputTokens).toBe(13);
    expect(done.signedReceipt.receipt.outputTokens).toBe(4);
    expect(done.signedReceipt.receipt.nonce).toMatch(/^[0-9a-f]{32}$/);
    store.shutdown();
  });

  it("captures engine errors and marks job error", async () => {
    const worker = generateIdentity();
    const stall = stallableEngine();
    const store = new JobStore({ identity: worker, engine: stall.engine });
    const submitted = store.submit(makeReq(), "lob1xxx");
    await waitFor(() => store.get(submitted.jobId)?.status === "running");
    stall.fail(new Error("ollama exploded"));
    await waitFor(() => store.get(submitted.jobId)?.status === "error");
    const done = store.get(submitted.jobId);
    expect(done?.status).toBe("error");
    expect(done?.error?.message).toMatch(/ollama exploded/);
    expect(done?.signedReceipt).toBeUndefined();
    store.shutdown();
  });

  it("cancel works on queued jobs only", async () => {
    const worker = generateIdentity();
    const stall = stallableEngine();
    const store = new JobStore({ identity: worker, engine: stall.engine });
    // Submit two: first will start running (and stall), second stays queued
    const job1 = store.submit(makeReq(), "lob1xxx");
    const job2 = store.submit(makeReq(), "lob1xxx");
    await new Promise((r) => setImmediate(r));

    expect(store.cancel(job2.jobId)).toBe(true);
    expect(store.get(job2.jobId)?.status).toBe("error");
    expect(store.get(job2.jobId)?.error?.type).toBe("cancelled");

    // job1 is already running — cancel should be no-op
    expect(store.cancel(job1.jobId)).toBe(false);

    stall.release();
    store.shutdown();
  });

  it("size() reflects current state", async () => {
    const worker = generateIdentity();
    const stall = stallableEngine();
    const store = new JobStore({ identity: worker, engine: stall.engine });
    expect(store.size()).toEqual({ queued: 0, running: 0, done: 0, error: 0 });
    store.submit(makeReq(), "lob1xxx");
    store.submit(makeReq(), "lob1xxx");
    await new Promise((r) => setImmediate(r));
    const counts = store.size();
    // One running, one queued
    expect(counts.running + counts.queued).toBe(2);
    stall.release();
    store.shutdown();
  });
});
