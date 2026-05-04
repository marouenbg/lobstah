import {
  type Announcement,
  formatPubkey,
  generateIdentity,
  signAnnouncement,
  verifyAnnouncement,
} from "@lobstah/protocol";
import { verifyEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { LOBSTAH_ANNOUNCEMENT_KIND, LOBSTAH_D_TAG } from "./relays.js";
import { buildAnnouncementEvent } from "./publisher.js";

describe("buildAnnouncementEvent", () => {
  it("wraps a signed lobstah announcement in a valid Nostr event", () => {
    const id = generateIdentity();
    const announcement: Announcement = {
      version: 1,
      pubkey: formatPubkey(id.publicKey),
      url: "http://192.0.2.1:17474",
      label: "test",
      models: ["llama3.1:8b"],
      ttlSeconds: 300,
      announcedAt: Date.now(),
    };
    const signed = signAnnouncement(announcement, id.secretKey);

    const event = buildAnnouncementEvent(signed, id.nostrSecretKey);

    expect(event.kind).toBe(LOBSTAH_ANNOUNCEMENT_KIND);
    expect(event.tags).toContainEqual(["d", LOBSTAH_D_TAG]);
    expect(event.tags).toContainEqual(["lobstah_pubkey", announcement.pubkey]);

    // Outer Nostr signature must verify.
    expect(verifyEvent(event)).toBe(true);

    // Inner lobstah announcement (the content) round-trips and verifies.
    const inner = JSON.parse(event.content);
    expect(verifyAnnouncement(inner)).toBe(true);
    expect(inner.announcement.url).toBe(announcement.url);
  });
});
