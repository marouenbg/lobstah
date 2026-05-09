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
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// In-memory job store + concurrent FIFO processor. Up to `concurrency` jobs
// run in parallel (default 1, matching the historic single-FIFO behavior).
// Operators with multi-engine setups (e.g. multiple Ollama instances behind
// a single worker, or a fast-enough single-Ollama box) can dial it up.
//
// Persistence: every state change appends a JSONL line to a log file
// (default ~/.lobstah/jobs.jsonl). On restart, the latest entry per jobId
// determines starting state; in-flight ("running") jobs reset to "queued"
// because we can't know if engine.chat completed before the crash.

export const defaultJobsLogPath = (): string =>
  process.env.LOBSTAH_JOBS_LOG ?? join(homedir(), ".lobstah", "jobs.jsonl");

export const DEFAULT_CONCURRENCY = 1;

export type JobStoreOptions = {
  identity: Identity;
  engine: WorkerEngine;
  // Path to the JSONL persistence log. Default: ~/.lobstah/jobs.jsonl
  // (or the LOBSTAH_JOBS_LOG env var). Pass `null` to disable persistence.
  jobsLogPath?: string | null;
  // How many jobs run in parallel. Default 1 (single-FIFO). Higher values
  // are only useful when the underlying engine can actually serve more
  // than one inference at a time (or you've fronted multiple engines
  // behind one worker).
  concurrency?: number;
  // Optional sink for newly-signed receipts. The server uses this to
  // publish each receipt to Nostr in the background. JobStore stays
  // ignorant of Nostr — it just hands the signed receipt to the
  // callback after appendLedger.
  onReceiptSigned?: (signed: import("@lobstah/protocol").SignedReceipt) => void;
  // Explicit ledger path. Defaults to LOBSTAH_LEDGER env / standard
  // home-dir location. Tests should pass this explicitly to avoid
  // process.env races in parallel test pools.
  ledgerPath?: string;
};

type InternalJob = JobRecord & {
  request: JobSubmitRequest;
  requesterPubkey: string;
};

export class JobStore {
  private jobs = new Map<string, InternalJob>();
  private queue: string[] = [];
  private cleanupTimer?: NodeJS.Timeout;
  private logPath: string | null;
  private concurrency: number;
  // Tracks in-flight runOne promises so shutdown() can drain them.
  private inFlight = new Set<Promise<void>>();
  // Persist calls are fire-and-forget from the caller's POV, but
  // serialized internally on a single promise chain. Two reasons:
  //  1) shutdown() awaits the tail of the chain to drain;
  //  2) two parallel `appendFile`s to the same path can interleave at the
  //     OS level (writes < PIPE_BUF are atomic, but the underlying open()
  //     + write() + close() cycle in Node's implementation is not).
  //     Chaining gives us a hard ordering guarantee that the on-disk log
  //     reflects the order of state mutations.
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private opts: JobStoreOptions) {
    this.logPath = opts.jobsLogPath === undefined ? defaultJobsLogPath() : opts.jobsLogPath;
    const c = opts.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(c) || c < 1) {
      throw new Error(`concurrency must be a positive integer (got ${c})`);
    }
    this.concurrency = c;
    this.cleanupTimer = setInterval(() => this.evictExpired(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  // Read the persistence log + reconstruct in-memory state. Idempotent;
  // safe to call before submit() etc.
  async hydrate(): Promise<{
    loaded: number;
    requeued: number;
    droppedExpired: number;
  }> {
    if (!this.logPath || !existsSync(this.logPath)) {
      return { loaded: 0, requeued: 0, droppedExpired: 0 };
    }
    const raw = await readFile(this.logPath, "utf8");
    const latest = new Map<string, InternalJob>();
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const job = JSON.parse(line) as InternalJob;
        if (typeof job?.jobId !== "string") continue;
        latest.set(job.jobId, job);
      } catch {
        // skip malformed (e.g., partial write at crash time)
      }
    }
    const now = Date.now();
    let requeued = 0;
    let droppedExpired = 0;
    for (const [id, job] of latest) {
      if (
        job.status === "done" &&
        job.completedAt &&
        now - job.completedAt > JOB_DONE_TTL_MS
      ) {
        droppedExpired += 1;
        continue;
      }
      if (
        job.status === "error" &&
        job.completedAt &&
        now - job.completedAt > JOB_ERROR_TTL_MS
      ) {
        droppedExpired += 1;
        continue;
      }
      // "running" entries from a previous run get reset — the engine call
      // may or may not have completed; safest to re-process. New attempt
      // gets a fresh receipt; nonce dedupe protects the original from
      // double-spending if it ever made it back.
      if (job.status === "running") {
        job.status = "queued";
        job.startedAt = undefined;
      }
      this.jobs.set(id, job);
      if (job.status === "queued") {
        this.queue.push(id);
        requeued += 1;
      }
    }
    if (this.queue.length > 0) setImmediate(() => this.tick());
    return { loaded: this.jobs.size, requeued, droppedExpired };
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
    void this.persist(job);
    // Defer to the next tick so submit() returns the job in "queued" status
    // before the processor synchronously mutates it to "running".
    setImmediate(() => this.tick());
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
    void this.persist(job);
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

  shutdown(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    // Wait for any in-flight runners to settle (so their final "done" or
    // "error" persist gets a chance to fire), then drain the persist
    // chain. New persists submitted after shutdown is called still go
    // through; startWorker / tests treat the returned promise as the
    // flush point for everything queued so far.
    return Promise.allSettled([...this.inFlight]).then(() =>
      this.persistChain.then(() => undefined),
    );
  }

  // Strip the internal request/requesterPubkey before exposing.
  private publicView(job: InternalJob): JobRecord {
    const { request: _r, requesterPubkey: _p, ...rest } = job;
    return rest;
  }

  private persist(job: InternalJob): Promise<void> {
    if (!this.logPath) return Promise.resolve();
    // Snapshot synchronously: the job object gets mutated in place as it
    // moves through queued → running → done, and persist() yields on
    // mkdir/appendFile. Without this snapshot the line written can reflect
    // a later state than the one the caller intended to record.
    const line = `${JSON.stringify(job)}\n`;
    const logPath = this.logPath;
    const jobId = job.jobId;
    // Append onto the chain. .catch swallows so one failure doesn't
    // poison subsequent writes (we still log to stderr inside).
    const next = this.persistChain.then(async () => {
      try {
        await mkdir(dirname(logPath), { recursive: true });
        await appendFile(logPath, line);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`worker: failed to persist job ${jobId}: ${msg}\n`);
      }
    });
    this.persistChain = next;
    return next;
  }

  // Pull jobs off the queue and start runners until either the queue
  // empties or we hit the concurrency cap. Each runner re-ticks on
  // completion to keep the pipeline full.
  private tick(): void {
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) break;
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") continue;
      const p = this.runOne(job);
      this.inFlight.add(p);
      p.finally(() => {
        this.inFlight.delete(p);
        // A slot freed up — see if anything else can start.
        this.tick();
      });
    }
  }

  private async runOne(job: InternalJob): Promise<void> {
    const startedAt = Date.now();
    job.status = "running";
    job.startedAt = startedAt;
    void this.persist(job);

    let result;
    try {
      result = await this.opts.engine.chat({ ...job.request, stream: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      job.status = "error";
      job.completedAt = Date.now();
      job.error = { type: "engine_error", message: msg };
      void this.persist(job);
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
    await appendLedger(signed, this.opts.ledgerPath);
    this.opts.onReceiptSigned?.(signed);

    job.status = "done";
    job.completedAt = completedAt;
    job.result = result.payload;
    job.signedReceipt = signed;
    void this.persist(job);
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
