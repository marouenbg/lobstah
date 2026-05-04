import type { WorkerEngine } from "@lobstah/engine-ollama";
import { append as appendLedger } from "@lobstah/ledger";
import {
  type Identity,
  type JobRecord,
  type JobStatus,
  type JobSubmitRequest,
  type Receipt,
  formatPubkey,
  generateNonce,
  JOB_DONE_TTL_MS,
  JOB_ERROR_TTL_MS,
  signReceipt,
} from "@lobstah/protocol";
import { randomUUID } from "node:crypto";

// In-memory job store + single-worker FIFO processor. One job in flight at
// a time (matches the underlying single-engine assumption — Ollama does
// its own batching internally).
//
// Persistence is intentionally out of scope for this iteration: a worker
// restart drops the queue. Routers will see jobs go unfulfilled and the
// consumer will get a "no_capable_peer" or a stale poll result. For real
// production we'd persist to JSONL on disk and recover on startup.

export type JobStoreOptions = {
  identity: Identity;
  engine: WorkerEngine;
  // Optional: inject a custom requesterPubkey extractor (default reads from
  // the request as it would for /v1/chat/completions).
};

type InternalJob = JobRecord & {
  request: JobSubmitRequest;
  requesterPubkey: string;
  startedAtPerf?: number;
};

export class JobStore {
  private jobs = new Map<string, InternalJob>();
  private queue: string[] = [];
  private processing = false;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private opts: JobStoreOptions) {
    this.cleanupTimer = setInterval(() => this.evictExpired(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  submit(request: JobSubmitRequest, requesterPubkey: string): JobRecord {
    const jobId = randomUUID();
    const now = Date.now();
    const job: InternalJob = {
      jobId,
      status: "queued",
      createdAt: now,
      request,
      requesterPubkey,
      metadata: request.metadata,
    };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    // Defer to the next tick so submit() returns the job in "queued" status
    // before the processor synchronously mutates it to "running".
    setImmediate(() => void this.tick());
    return this.publicView(job);
  }

  get(jobId: string): JobRecord | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.publicView(job) : undefined;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status !== "queued") return false;
    job.status = "error";
    job.completedAt = Date.now();
    job.error = { type: "cancelled", message: "cancelled before processing" };
    const idx = this.queue.indexOf(jobId);
    if (idx >= 0) this.queue.splice(idx, 1);
    return true;
  }

  size(): { queued: number; running: number; done: number; error: number } {
    let queued = 0;
    let running = 0;
    let done = 0;
    let error = 0;
    for (const j of this.jobs.values()) {
      if (j.status === "queued") queued++;
      else if (j.status === "running") running++;
      else if (j.status === "done") done++;
      else if (j.status === "error") error++;
    }
    return { queued, running, done, error };
  }

  shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  // Strip the internal request/requesterPubkey before exposing.
  private publicView(job: InternalJob): JobRecord {
    const { request: _r, requesterPubkey: _p, startedAtPerf: _s, ...rest } = job;
    return rest;
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift();
        if (!jobId) break;
        const job = this.jobs.get(jobId);
        if (!job || job.status !== "queued") continue;
        await this.runOne(job);
      }
    } finally {
      this.processing = false;
    }
  }

  private async runOne(job: InternalJob): Promise<void> {
    const startedAt = Date.now();
    job.status = "running";
    job.startedAt = startedAt;

    let result;
    try {
      result = await this.opts.engine.chat({ ...job.request, stream: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      job.status = "error";
      job.completedAt = Date.now();
      job.error = { type: "engine_error", message: msg };
      return;
    }

    const completedAt = Date.now();
    const workerPubkey = formatPubkey(this.opts.identity.publicKey);
    const receipt: Receipt = {
      version: 1,
      jobId: job.jobId,
      nonce: generateNonce(),
      requesterPubkey: job.requesterPubkey,
      workerPubkey,
      model: job.request.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      startedAt,
      completedAt,
    };
    const signed = signReceipt(receipt, this.opts.identity.secretKey);
    await appendLedger(signed);

    job.status = "done";
    job.completedAt = completedAt;
    job.result = result.payload;
    job.signedReceipt = signed;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.status === "done" && job.completedAt && now - job.completedAt > JOB_DONE_TTL_MS) {
        this.jobs.delete(id);
        continue;
      }
      if (job.status === "error" && job.completedAt && now - job.completedAt > JOB_ERROR_TTL_MS) {
        this.jobs.delete(id);
      }
    }
  }
}

export const setStatus = (job: JobRecord, status: JobStatus): JobRecord => ({
  ...job,
  status,
});
