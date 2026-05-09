import type { ChatResult, WorkerEngine } from "@lobstah/engine-ollama";
import {
  type ChatCompletionRequest,
  formatPubkey,
  generateIdentity,
  verifyReceipt,
} from "@lobstah/protocol";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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

// Engine that lets each individual chat() call be released independently.
// Useful for concurrency tests where we want to observe N runners holding
// open mid-flight.
const multiStallEngine = (
  models: string[] = ["llama3.1:8b"],
): {
  engine: WorkerEngine;
  callCount: () => number;
  releaseAll: (result?: ChatResult) => void;
} => {
  type Pending = { resolve: (r: ChatResult) => void; reject: (e: Error) => void };
  const pending: Pending[] = [];
  const engine: WorkerEngine = {
    name: "multi-stall",
    listModels: async () => models,
    chat: async (_: ChatCompletionRequest) =>
      new Promise<ChatResult>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    chatStream: async () => {
      throw new Error("not used");
    },
  };
  return {
    engine,
    callCount: () => pending.length,
    releaseAll: (r) => {
      const result = r ?? { payload: { ok: true }, inputTokens: 1, outputTokens: 1 };
      for (const p of pending.splice(0)) p.resolve(result);
    },
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

// Per-test ledger path. Each test pulls `ledgerPath` from this closure
// and passes it explicitly to `new JobStore({ ledgerPath })` — no
// reliance on process.env so the parallel vitest pool can't race
// between concurrent tests.
let ledgerPath = "";

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "lobstah-jobs-test-"));
  ledgerPath = join(dir, "ledger.jsonl");
});

describe("JobStore", () => {
  it("submit + immediately-poll returns queued or running", async () => {
    const id = generateIdentity();
    const stall = stallableEngine();
    const store = new JobStore({ identity: id, engine: stall.engine, jobsLogPath: null, ledgerPath });
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
    const store = new JobStore({ identity: worker, engine: stall.engine, jobsLogPath: null, ledgerPath });

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
    const store = new JobStore({ identity: worker, engine: stall.engine, jobsLogPath: null, ledgerPath });
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
    const store = new JobStore({ identity: worker, engine: stall.engine, jobsLogPath: null, ledgerPath });
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
    const store = new JobStore({ identity: worker, engine: stall.engine, jobsLogPath: null, ledgerPath });
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

  it("default concurrency is 1 (single in-flight)", async () => {
    const worker = generateIdentity();
    const multi = multiStallEngine();
    const store = new JobStore({
      identity: worker,
      engine: multi.engine,
      jobsLogPath: null, ledgerPath,
    });
    expect(store.getConcurrency()).toBe(1);
    store.submit(makeReq(), "lob1xxx");
    store.submit(makeReq(), "lob1xxx");
    store.submit(makeReq(), "lob1xxx");
    await waitFor(() => multi.callCount() >= 1);
    // Even after settling, only one engine.chat call should be in flight.
    await new Promise((r) => setTimeout(r, 30));
    expect(multi.callCount()).toBe(1);
    expect(store.size().running).toBe(1);
    expect(store.size().queued).toBe(2);
    // Release in three cycles — each release frees the slot, the next
    // runner registers a new pending, then we release that one.
    for (let i = 1; i <= 3; i++) {
      multi.releaseAll();
      await waitFor(() => store.size().done >= i);
    }
    await store.shutdown();
  });

  it("concurrency > 1 runs N jobs in parallel", async () => {
    const worker = generateIdentity();
    const multi = multiStallEngine();
    const store = new JobStore({
      identity: worker,
      engine: multi.engine,
      jobsLogPath: null, ledgerPath,
      concurrency: 3,
    });
    expect(store.getConcurrency()).toBe(3);
    store.submit(makeReq(), "lob1xxx");
    store.submit(makeReq(), "lob1xxx");
    store.submit(makeReq(), "lob1xxx");
    store.submit(makeReq(), "lob1xxx"); // 4th — should stay queued
    await waitFor(() => multi.callCount() >= 3);
    // Settle a tick — the 4th must NOT have started yet.
    await new Promise((r) => setTimeout(r, 30));
    expect(multi.callCount()).toBe(3);
    expect(store.size().running).toBe(3);
    expect(store.size().queued).toBe(1);

    // Release all 3 in flight; 4th should pick up after a slot frees.
    multi.releaseAll();
    await waitFor(() => store.size().done === 3 && multi.callCount() === 1);
    expect(store.size().running).toBe(1);
    expect(store.size().queued).toBe(0);

    multi.releaseAll();
    await waitFor(() => store.size().done === 4);
    await store.shutdown();
  });

  it("rejects invalid concurrency at construction", () => {
    const worker = generateIdentity();
    const multi = multiStallEngine();
    expect(
      () =>
        new JobStore({
          identity: worker,
          engine: multi.engine,
          jobsLogPath: null, ledgerPath,
          concurrency: 0,
        }),
    ).toThrow(/concurrency/);
    expect(
      () =>
        new JobStore({
          identity: worker,
          engine: multi.engine,
          jobsLogPath: null, ledgerPath,
          concurrency: -1,
        }),
    ).toThrow(/concurrency/);
    expect(
      () =>
        new JobStore({
          identity: worker,
          engine: multi.engine,
          jobsLogPath: null, ledgerPath,
          concurrency: 1.5,
        }),
    ).toThrow(/concurrency/);
  });
});

describe("JobStore persistence", () => {
  it("persists submit + completion to JSONL log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lobstah-jobs-persist-"));
    const logPath = join(dir, "jobs.jsonl");
    const worker = generateIdentity();
    const stall = stallableEngine();
    const store = new JobStore({
      identity: worker,
      engine: stall.engine,
      jobsLogPath: logPath, ledgerPath,
    });
    const submitted = store.submit(makeReq(), "lob1xxx");
    await waitFor(() => store.get(submitted.jobId)?.status === "running");
    stall.release({ payload: { ok: true }, inputTokens: 5, outputTokens: 2 });
    await waitFor(() => store.get(submitted.jobId)?.status === "done");
    await store.shutdown();

    const log = await readFile(logPath, "utf8");
    const lines = log.split("\n").filter((l) => l.length > 0);
    // Three entries: queued, running, done.
    expect(lines.length).toBe(3);
    const states = lines.map((l) => JSON.parse(l).status);
    expect(states).toEqual(["queued", "running", "done"]);
  });

  it("hydrates done jobs from a prior run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lobstah-jobs-hydrate-"));
    const logPath = join(dir, "jobs.jsonl");
    const worker = generateIdentity();
    const stall = stallableEngine();

    // First "process": run a job to completion
    const a = new JobStore({
      identity: worker,
      engine: stall.engine,
      jobsLogPath: logPath, ledgerPath,
    });
    const submitted = a.submit(makeReq(), "lob1xxx");
    await waitFor(() => a.get(submitted.jobId)?.status === "running");
    stall.release({ payload: { hi: true }, inputTokens: 3, outputTokens: 1 });
    await waitFor(() => a.get(submitted.jobId)?.status === "done");
    await a.shutdown();

    // Second "process": fresh store, same log → should recover
    const b = new JobStore({
      identity: worker,
      engine: stall.engine,
      jobsLogPath: logPath, ledgerPath,
    });
    const result = await b.hydrate();
    expect(result.loaded).toBe(1);
    expect(result.requeued).toBe(0); // already done
    const got = b.get(submitted.jobId);
    expect(got?.status).toBe("done");
    expect((got?.result as { hi?: boolean })?.hi).toBe(true);
    b.shutdown();
  });

  it("requeues a 'running' entry on hydrate (crashed mid-run)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lobstah-jobs-crash-"));
    const logPath = join(dir, "jobs.jsonl");
    const worker = generateIdentity();

    // Manually craft a log with a 'running' entry (simulate a worker that
    // started a job and then crashed before completion).
    const crashedJob = {
      jobId: "crash-job-1",
      status: "running",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
      request: { model: "llama3.1:8b", messages: [{ role: "user", content: "x" }] },
      requesterPubkey: "lob1xxx",
    };
    await writeFile(logPath, `${JSON.stringify(crashedJob)}\n`);

    const stall2 = stallableEngine();
    const store = new JobStore({
      identity: worker,
      engine: stall2.engine,
      jobsLogPath: logPath, ledgerPath,
    });
    const result = await store.hydrate();
    expect(result.loaded).toBe(1);
    expect(result.requeued).toBe(1);
    const job = store.get("crash-job-1");
    // Reset to queued; new attempt will pick it up via the processor tick.
    expect(["queued", "running"]).toContain(job?.status);
    stall2.release();
    store.shutdown();
  });
});
