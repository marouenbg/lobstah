import {
  type SignedAnnouncement,
  type SignedReceipt,
  verifyAnnouncement,
  verifyReceipt,
} from "@lobstah/protocol";
import { type Event, verifyEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { useWebSocketImplementation } from "nostr-tools/relay";
import WebSocket from "ws";
import {
  DEFAULT_RELAYS,
  LOBSTAH_ANNOUNCEMENT_KIND,
  LOBSTAH_RECEIPT_KIND,
} from "./relays.js";

useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

export type IngestedAnnouncement = {
  signed: SignedAnnouncement;
  receivedFromRelay: string;
  nostrEventId: string;
  nostrPubkey: string;
};

export type RejectedAnnouncement = {
  reason: string;
  relay: string;
  raw?: Event;
};

export type SubscribeOptions = {
  relays?: ReadonlyArray<string>;
  // How long after the most recent event we should keep listening before
  // closing the subscription, in ms. Default: 8s — relay buffers usually
  // drain within 1-3s, but allow extra slack.
  quietIdleMs?: number;
  // Hard timeout regardless of activity (ms). Default 30s.
  hardTimeoutMs?: number;
  pool?: SimplePool;
};

// Subscribe, drain the relay buffer + wait for a quiet idle period, then close.
// Returns all valid signed announcements collected from the relays.
export const collectAnnouncements = async (
  opts: SubscribeOptions = {},
): Promise<{
  accepted: IngestedAnnouncement[];
  rejected: RejectedAnnouncement[];
}> => {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const pool = opts.pool ?? new SimplePool();
  const quietIdleMs = opts.quietIdleMs ?? 8_000;
  const hardTimeoutMs = opts.hardTimeoutMs ?? 30_000;

  const accepted: IngestedAnnouncement[] = [];
  const rejected: RejectedAnnouncement[] = [];
  const seenEventIds = new Set<string>();

  await new Promise<void>((resolve) => {
    let idleTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let closed = false;

    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try {
        sub.close();
      } catch {
        // best-effort
      }
      resolve();
    };

    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, quietIdleMs);
    };

    hardTimer = setTimeout(finish, hardTimeoutMs);
    resetIdle();

    const sub = pool.subscribeMany(
      [...relays],
      { kinds: [LOBSTAH_ANNOUNCEMENT_KIND] },
      {
        onevent(event: Event) {
          resetIdle();
          if (seenEventIds.has(event.id)) return;
          seenEventIds.add(event.id);

          if (!verifyEvent(event)) {
            rejected.push({
              reason: "nostr signature invalid",
              relay: "(unknown)",
              raw: event,
            });
            return;
          }
          let signed: SignedAnnouncement;
          try {
            signed = JSON.parse(event.content) as SignedAnnouncement;
          } catch {
            rejected.push({ reason: "content is not JSON", relay: "(unknown)", raw: event });
            return;
          }
          if (!verifyAnnouncement(signed)) {
            rejected.push({
              reason: "lobstah announcement signature invalid",
              relay: "(unknown)",
              raw: event,
            });
            return;
          }
          accepted.push({
            signed,
            receivedFromRelay: "(pool)",
            nostrEventId: event.id,
            nostrPubkey: event.pubkey,
          });
        },
        oneose() {
          // End-of-stored-events marker — relay has drained its buffer for this
          // subscription. We still wait for the idle window in case more events
          // straggle in from other relays.
        },
      },
    );
  });

  if (!opts.pool) pool.close([...relays]);
  return { accepted, rejected };
};

// ─── Receipts ───────────────────────────────────────────────────────────

export type IngestedReceipt = {
  signed: SignedReceipt;
  receivedFromRelay: string;
  nostrEventId: string;
  nostrPubkey: string;
};

export type RejectedReceipt = {
  reason: string;
  relay: string;
  raw?: Event;
};

// Subscribe to lobstah receipt events (kind 1474), drain the relay
// buffers + wait for a quiet idle period, then close. Returns all
// valid signed receipts the relays gave us, deduplicated by
// receipt nonce.
//
// Used by routers to compute the network-wide balance and by the
// `lobstah balance --network` CLI command for the public-account
// view.
export const collectReceipts = async (
  opts: SubscribeOptions = {},
): Promise<{
  accepted: IngestedReceipt[];
  rejected: RejectedReceipt[];
}> => {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const pool = opts.pool ?? new SimplePool();
  const quietIdleMs = opts.quietIdleMs ?? 8_000;
  const hardTimeoutMs = opts.hardTimeoutMs ?? 30_000;

  const accepted: IngestedReceipt[] = [];
  const rejected: RejectedReceipt[] = [];
  const seenEventIds = new Set<string>();
  const seenNonces = new Set<string>();

  await new Promise<void>((resolve) => {
    let idleTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let closed = false;

    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try {
        sub.close();
      } catch {
        // best-effort
      }
      resolve();
    };

    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, quietIdleMs);
    };

    hardTimer = setTimeout(finish, hardTimeoutMs);
    resetIdle();

    const sub = pool.subscribeMany(
      [...relays],
      { kinds: [LOBSTAH_RECEIPT_KIND] },
      {
        onevent(event: Event) {
          resetIdle();
          if (seenEventIds.has(event.id)) return;
          seenEventIds.add(event.id);

          if (!verifyEvent(event)) {
            rejected.push({
              reason: "nostr signature invalid",
              relay: "(unknown)",
              raw: event,
            });
            return;
          }
          let signed: SignedReceipt;
          try {
            signed = JSON.parse(event.content) as SignedReceipt;
          } catch {
            rejected.push({ reason: "content is not JSON", relay: "(unknown)", raw: event });
            return;
          }
          if (!verifyReceipt(signed)) {
            rejected.push({
              reason: "lobstah receipt signature invalid",
              relay: "(unknown)",
              raw: event,
            });
            return;
          }
          // Receipt-level dedup: if two relays carried the same
          // receipt under different Nostr event ids (e.g., the
          // worker re-published due to a relay error), only keep
          // one. The receipt nonce is the canonical identifier.
          if (seenNonces.has(signed.receipt.nonce)) return;
          seenNonces.add(signed.receipt.nonce);

          accepted.push({
            signed,
            receivedFromRelay: "(pool)",
            nostrEventId: event.id,
            nostrPubkey: event.pubkey,
          });
        },
        oneose() {
          // EOSE — wait for the idle window in case more events
          // straggle in from other relays.
        },
      },
    );
  });

  if (!opts.pool) pool.close([...relays]);
  return { accepted, rejected };
};
