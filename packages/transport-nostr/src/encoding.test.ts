import { generateIdentity } from "@lobstah/protocol";
import { describe, expect, it } from "vitest";
import {
  formatNostrNpub,
  formatNostrNsec,
  parseNostrNpub,
  parseNostrNsec,
} from "./encoding.js";

describe("nostr key encoding", () => {
  it("npub round-trip", () => {
    const id = generateIdentity();
    const npub = formatNostrNpub(id.nostrPublicKey);
    expect(npub).toMatch(/^npub1[02-9ac-hj-np-z]+$/);
    expect(parseNostrNpub(npub)).toEqual(id.nostrPublicKey);
  });

  it("nsec round-trip", () => {
    const id = generateIdentity();
    const nsec = formatNostrNsec(id.nostrSecretKey);
    expect(nsec).toMatch(/^nsec1[02-9ac-hj-np-z]+$/);
    expect(parseNostrNsec(nsec)).toEqual(id.nostrSecretKey);
  });

  it("rejects npub when given an nsec", () => {
    const id = generateIdentity();
    const nsec = formatNostrNsec(id.nostrSecretKey);
    expect(() => parseNostrNpub(nsec)).toThrow();
  });

  it("rejects nsec when given an npub", () => {
    const id = generateIdentity();
    const npub = formatNostrNpub(id.nostrPublicKey);
    expect(() => parseNostrNsec(npub)).toThrow();
  });
});
