import { type SignedAnnouncement, verifyAnnouncement } from "@lobstah/protocol";
import { type Event, verifyEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { useWebSocketImplementation } from "nostr-tools/relay";
import WebSocket from "ws";
import { DEFAULT_RELAYS, LOBSTAH_ANNOUNCEMENT_KIND } from "./relays.js";

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
