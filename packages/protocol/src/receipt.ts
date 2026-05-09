import { canonicalize } from "./canonical.js";
import { fromHex, parsePubkey, sign, toHex, verify } from "./identity.js";

export type Receipt = {
  version: 1;
  jobId: string;
  nonce: string;
  requesterPubkey: string;
  workerPubkey: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  completedAt: number;
};

export type SignedReceipt = {
  receipt: Receipt;
  signature: string;
};

export const MAX_RECEIPT_AGE_MS = 5 * 60 * 1000;

// Per-pubkey bootstrap allowance. Every account starts with this many
// tokens of compute credit. Workers MUST refuse requests that would
// drive a requester's balance below zero. New accounts join the
// network with this fresh allowance — no faucet, no gatekeeper.
//
// Pre-alpha disclosure: this is per-pubkey, not per-human. There is
// no Sybil resistance yet — a determined attacker can mint identities
// to claim arbitrary credits. Sybil resistance (web of trust, PoW,
// social attestation) is a roadmap item; the credit system here is
// designed to be additive once it lands. For demo / hobby use, the
// 10K allowance is "enough to feel free, not enough to abuse."
export const BOOTSTRAP_ALLOWANCE_TOKENS = 10_000;

export const generateNonce = (): string => {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return toHex(buf);
};

const enc = new TextEncoder();

export const signReceipt = (receipt: Receipt, workerSecretKey: Uint8Array): SignedReceipt => {
  const signature = sign(enc.encode(canonicalize(receipt)), workerSecretKey);
  return { receipt, signature: toHex(signature) };
};

export const verifyReceipt = (signed: SignedReceipt): boolean => {
  try {
    const workerPk = parsePubkey(signed.receipt.workerPubkey);
    return verify(fromHex(signed.signature), enc.encode(canonicalize(signed.receipt)), workerPk);
  } catch {
    return false;
  }
};

export const isReceiptFresh = (r: Receipt, now: number = Date.now()): boolean => {
  return now - r.completedAt <= MAX_RECEIPT_AGE_MS && r.completedAt - now <= MAX_RECEIPT_AGE_MS;
};

export const totalTokens = (r: Receipt): number => r.inputTokens + r.outputTokens;
