import { z } from "zod";
import { ChatCompletionRequestSchema } from "./messages.js";
import type { SignedReceipt } from "./receipt.js";

// Async-job API for cargo-shaped workloads (overnight agents, batch
// processing, multi-agent orchestration). The same chat completion shape as
// /v1/chat/completions but submitted-and-polled instead of held open.
//
// Lifecycle:
//   queued → running → done | error
//
// Workers process jobs in submission order (FIFO). Routers translate
// client-facing job IDs to (peer, worker-job-id) mappings, so consumers
// only ever see a single opaque jobId regardless of routing.

export type JobStatus = "queued" | "running" | "done" | "error";

// What clients submit — same shape as a normal chat completion request.
// We disable streaming (jobs are inherently non-streaming).
export const JobSubmitRequestSchema = ChatCompletionRequestSchema.omit({
  stream: true,
}).extend({
  // Optional client-side job tag for later filtering / logs. Ignored if absent.
  metadata: z.record(z.string(), z.string()).optional(),
});

export type JobSubmitRequest = z.infer<typeof JobSubmitRequestSchema>;

// What workers + routers return.
export type JobRecord = {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  // Set when status === "done":
  result?: unknown; // OpenAI-format chat completion response
  // Signed receipt issued by the worker on completion. Routers strip this
  // before returning to the client (they record it locally to the ledger
  // instead). Workers may still return it on polls; nonce dedupe protects
  // against double-counting.
  signedReceipt?: SignedReceipt;
  // Set when status === "error":
  error?: { type: string; message: string };
  // Optional client-supplied metadata, passed through.
  metadata?: Record<string, string>;
};

// Response shape for POST /v1/jobs (submit) and GET /v1/jobs/:id (poll).
export type JobSubmitResponse = Pick<JobRecord, "jobId" | "status" | "createdAt">;
export type JobPollResponse = JobRecord;

// Maximum age of a completed job kept in memory before eviction.
export const JOB_DONE_TTL_MS = 60 * 60 * 1000;
export const JOB_ERROR_TTL_MS = 30 * 60 * 1000;

export const JOBS_PATH = "/v1/jobs";
