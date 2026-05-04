import { canonicalize } from "./canonical.js";
import { fromHex, parsePubkey, sign, toHex, verify } from "./identity.js";

// Latency tier the worker volunteers to handle. Routers use this to bias
// peer selection: streaming chat completions prefer "interactive"; cargo
// jobs prefer "batch"; "best-effort" is the safe default for hardware that
// hasn't characterized itself either way.
//
// Workers self-report — there's no enforcement. Lying ("interactive" on a
// 30B-quant Mac mini) just hurts the worker's reputation when the routers
// see slow responses, which the future reputation layer will track.
export type WorkerTier = "interactive" | "batch" | "best-effort";

export const DEFAULT_WORKER_TIER: WorkerTier = "best-effort";

export const isWorkerTier = (s: unknown): s is WorkerTier =>
  s === "interactive" || s === "batch" || s === "best-effort";

export type Announcement = {
  version: 1;
  pubkey: string;
  url: string;
  label?: string;
  models?: string[];
  // Optional for back-compat: announcements without `tier` are treated as
  // "best-effort" by routers. Adding the field doesn't break old verifiers
  // (the signature still validates); it just lets newer routers route
  // smarter when both sides understand it.
  tier?: WorkerTier;
  ttlSeconds: number;
  announcedAt: number;
};

export type SignedAnnouncement = {
  announcement: Announcement;
  signature: string;
};

export const ANNOUNCEMENT_MAX_SKEW_MS = 5 * 60 * 1000;

const enc = new TextEncoder();

export const signAnnouncement = (
  announcement: Announcement,
  secretKey: Uint8Array,
): SignedAnnouncement => {
  const signature = sign(enc.encode(canonicalize(announcement)), secretKey);
  return { announcement, signature: toHex(signature) };
};

export const verifyAnnouncement = (signed: SignedAnnouncement): boolean => {
  try {
    const pk = parsePubkey(signed.announcement.pubkey);
    return verify(
      fromHex(signed.signature),
      enc.encode(canonicalize(signed.announcement)),
      pk,
    );
  } catch {
    return false;
  }
};

export type AnnouncementStatus = "ok" | "future" | "stale";

export const announcementStatus = (
  a: Announcement,
  now: number = Date.now(),
): AnnouncementStatus => {
  const skew = a.announcedAt - now;
  if (skew > ANNOUNCEMENT_MAX_SKEW_MS) return "future";
  const age = now - a.announcedAt;
  if (age > a.ttlSeconds * 1000) return "stale";
  return "ok";
};
