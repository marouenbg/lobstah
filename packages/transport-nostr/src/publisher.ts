import type { SignedAnnouncement } from "@lobstah/protocol";
import { type Event, finalizeEvent, type EventTemplate } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { useWebSocketImplementation } from "nostr-tools/relay";
import WebSocket from "ws";
import {
  DEFAULT_RELAYS,
  LOBSTAH_ANNOUNCEMENT_KIND,
  LOBSTAH_D_TAG,
  LOBSTAH_T_TAG,
} from "./relays.js";

// Node doesn't ship a global WebSocket; nostr-tools needs one wired in.
useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

export type PublishResult = {
  eventId: string;
  acceptedBy: string[];
  rejectedBy: { relay: string; reason: string }[];
};

export type PublishOptions = {
  relays?: ReadonlyArray<string>;
  pool?: SimplePool;
};

export const buildAnnouncementEvent = (
  signed: SignedAnnouncement,
  nostrSecretKey: Uint8Array,
): Event => {
  const template: EventTemplate = {
    kind: LOBSTAH_ANNOUNCEMENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", LOBSTAH_D_TAG],
      ["t", LOBSTAH_T_TAG],
      // 'lobstah_pubkey' tag lets subscribers filter without parsing the body.
      ["lobstah_pubkey", signed.announcement.pubkey],
    ],
    content: JSON.stringify(signed),
  };
  return finalizeEvent(template, nostrSecretKey);
};

export const publishAnnouncement = async (
  signed: SignedAnnouncement,
  nostrSecretKey: Uint8Array,
  opts: PublishOptions = {},
): Promise<PublishResult> => {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const pool = opts.pool ?? new SimplePool();
  const event = buildAnnouncementEvent(signed, nostrSecretKey);

  const accepted: string[] = [];
  const rejected: { relay: string; reason: string }[] = [];

  // pool.publish returns one promise per relay; settle all and bucket results.
  const promises = pool.publish([...relays], event);
  await Promise.all(
    promises.map((p, i) =>
      p
        .then((relayUrl: string) => {
          accepted.push(relayUrl);
        })
        .catch((e: unknown) => {
          const relay = relays[i];
          if (relay !== undefined) {
            rejected.push({
              relay,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }),
    ),
  );

  if (!opts.pool) pool.close([...relays]);
  return { eventId: event.id, acceptedBy: accepted, rejectedBy: rejected };
};

// NIP-09 deletion event. Tells relays to drop the prior announcement.
// Best-effort; not all relays honor deletion requests.
export const unpublishAnnouncement = async (
  eventIdToDelete: string,
  nostrSecretKey: Uint8Array,
  opts: PublishOptions = {},
): Promise<PublishResult> => {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const pool = opts.pool ?? new SimplePool();
  const template: EventTemplate = {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["e", eventIdToDelete]],
    content: "lobstah unannounce",
  };
  const event = finalizeEvent(template, nostrSecretKey);
  const accepted: string[] = [];
  const rejected: { relay: string; reason: string }[] = [];
  const promises = pool.publish([...relays], event);
  await Promise.all(
    promises.map((p, i) =>
      p
        .then((relayUrl: string) => {
          accepted.push(relayUrl);
        })
        .catch((e: unknown) => {
          const relay = relays[i];
          if (relay !== undefined) {
            rejected.push({
              relay,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }),
    ),
  );
  if (!opts.pool) pool.close([...relays]);
  return { eventId: event.id, acceptedBy: accepted, rejectedBy: rejected };
};
