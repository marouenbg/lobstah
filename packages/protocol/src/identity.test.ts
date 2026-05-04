import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatPubkey,
  generateIdentity,
  loadIdentity,
  parsePubkey,
  saveIdentity,
  sign,
  verify,
} from "./identity.js";

describe("identity", () => {
  it("generates lobstah Ed25519 + Nostr Schnorr keypairs", () => {
    const id = generateIdentity();
    expect(id.publicKey).toBeInstanceOf(Uint8Array);
    expect(id.publicKey.length).toBe(32);
    expect(id.secretKey).toBeInstanceOf(Uint8Array);
    expect(id.secretKey.length).toBe(32);
    expect(id.nostrPublicKey).toBeInstanceOf(Uint8Array);
    expect(id.nostrPublicKey.length).toBe(32);
    expect(id.nostrSecretKey).toBeInstanceOf(Uint8Array);
    expect(id.nostrSecretKey.length).toBe(32);
    // The two keypairs must be independent.
    expect(id.secretKey).not.toEqual(id.nostrSecretKey);
    expect(id.publicKey).not.toEqual(id.nostrPublicKey);
  });

  it("signs and verifies a message", () => {
    const id = generateIdentity();
    const msg = new TextEncoder().encode("hello world");
    const sig = sign(msg, id.secretKey);
    expect(sig.length).toBe(64);
    expect(verify(sig, msg, id.publicKey)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const id = generateIdentity();
    const msg = new TextEncoder().encode("hello world");
    const sig = sign(msg, id.secretKey);
    const tampered = new TextEncoder().encode("hello world!");
    expect(verify(sig, tampered, id.publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const msg = new TextEncoder().encode("hi");
    const sigByA = sign(msg, a.secretKey);
    expect(verify(sigByA, msg, b.publicKey)).toBe(false);
  });

  it("formats and parses a pubkey round-trip", () => {
    const id = generateIdentity();
    const formatted = formatPubkey(id.publicKey);
    expect(formatted).toMatch(/^lob1[0-9a-f]{64}$/);
    expect(parsePubkey(formatted)).toEqual(id.publicKey);
  });

  it("rejects malformed pubkeys", () => {
    expect(() => parsePubkey("badkey")).toThrow();
    expect(() => parsePubkey("lob1xx")).toThrow();
  });

  it("save + load round-trips a v2 identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lobstah-identity-test-"));
    const path = join(dir, "identity.json");
    const original = generateIdentity();
    await saveIdentity(original, path);
    const loaded = await loadIdentity(path);
    expect(loaded.publicKey).toEqual(original.publicKey);
    expect(loaded.secretKey).toEqual(original.secretKey);
    expect(loaded.nostrPublicKey).toEqual(original.nostrPublicKey);
    expect(loaded.nostrSecretKey).toEqual(original.nostrSecretKey);
  });

  it("auto-migrates a v1 identity file to v2 (adds Nostr keys, persists)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lobstah-identity-test-"));
    const path = join(dir, "identity.json");
    // Hand-craft a v1 file (no Nostr keys).
    const v1 = generateIdentity();
    const v1Json = {
      version: 1,
      publicKey: formatPubkey(v1.publicKey),
      secretKey: Array.from(v1.secretKey, (x) => x.toString(16).padStart(2, "0")).join(""),
    };
    await writeFile(path, JSON.stringify(v1Json));

    const loaded = await loadIdentity(path);
    expect(loaded.publicKey).toEqual(v1.publicKey);
    expect(loaded.secretKey).toEqual(v1.secretKey);
    // Newly-generated Nostr keys.
    expect(loaded.nostrPublicKey.length).toBe(32);
    expect(loaded.nostrSecretKey.length).toBe(32);

    // File on disk should now be v2 (so we don't re-migrate next load).
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.version).toBe(2);
    expect(typeof onDisk.nostrPublicKey).toBe("string");
    expect(typeof onDisk.nostrSecretKey).toBe("string");
  });
});
