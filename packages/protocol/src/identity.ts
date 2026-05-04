import { ed25519 } from "@noble/curves/ed25519";
import { schnorr } from "@noble/curves/secp256k1";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Lobstah peers carry two keypairs.
//
// 1. Lobstah identity (Ed25519): signs receipts and announcements. This is
//    the "trust" key; receipts attribute compute earned/spent to its pubkey.
// 2. Nostr identity (secp256k1 / BIP340 Schnorr, x-only pubkey): signs the
//    outer envelope when announcements are published over Nostr relays.
//    Required by the Nostr protocol; lives entirely at the transport layer.
//
// Files saved as version 1 (lobstah-only) are auto-migrated to version 2 on
// next load; we generate a Nostr key and re-save the file in place.

export type Identity = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  nostrPublicKey: Uint8Array;
  nostrSecretKey: Uint8Array;
};

export const defaultIdentityPath = (): string =>
  process.env.LOBSTAH_IDENTITY ?? join(homedir(), ".lobstah", "identity.json");

export const generateIdentity = (): Identity => {
  const secretKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  const nostrSecretKey = schnorr.utils.randomPrivateKey();
  const nostrPublicKey = schnorr.getPublicKey(nostrSecretKey);
  return { publicKey, secretKey, nostrPublicKey, nostrSecretKey };
};

export const sign = (message: Uint8Array, secretKey: Uint8Array): Uint8Array =>
  ed25519.sign(message, secretKey);

export const verify = (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean => ed25519.verify(signature, message, publicKey);

export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const fromHex = (s: string): Uint8Array => {
  if (s.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export const formatPubkey = (pk: Uint8Array): string => `lob1${toHex(pk)}`;

export const parsePubkey = (s: string): Uint8Array => {
  if (!s.startsWith("lob1")) throw new Error(`bad pubkey (missing lob1 prefix): ${s}`);
  const hex = s.slice(4);
  if (hex.length !== 64) throw new Error(`bad pubkey (expected 64 hex chars, got ${hex.length})`);
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`bad pubkey (non-hex chars in body)`);
  return fromHex(hex);
};

// Nostr keys are typically formatted as 64-char hex (BIP340 x-only pubkey or
// 32-byte secret). Bech32 encoding (npub1.../nsec1...) lives in
// @lobstah/transport-nostr to keep this package free of bech32 deps.
export const formatNostrPubkeyHex = (pk: Uint8Array): string => toHex(pk);
export const formatNostrSecretHex = (sk: Uint8Array): string => toHex(sk);

type SerializedIdentityV1 = {
  version: 1;
  publicKey: string;
  secretKey: string;
};

type SerializedIdentityV2 = {
  version: 2;
  publicKey: string;
  secretKey: string;
  nostrPublicKey: string;
  nostrSecretKey: string;
};

type SerializedIdentity = SerializedIdentityV1 | SerializedIdentityV2;

const serialize = (id: Identity): SerializedIdentityV2 => ({
  version: 2,
  publicKey: formatPubkey(id.publicKey),
  secretKey: toHex(id.secretKey),
  nostrPublicKey: toHex(id.nostrPublicKey),
  nostrSecretKey: toHex(id.nostrSecretKey),
});

const deserialize = (s: SerializedIdentity): { identity: Identity; migrated: boolean } => {
  if (s.version === 1) {
    // Migrate: keep lobstah keys, generate fresh Nostr keys.
    const nostrSecretKey = schnorr.utils.randomPrivateKey();
    const nostrPublicKey = schnorr.getPublicKey(nostrSecretKey);
    return {
      identity: {
        publicKey: parsePubkey(s.publicKey),
        secretKey: fromHex(s.secretKey),
        nostrPublicKey,
        nostrSecretKey,
      },
      migrated: true,
    };
  }
  if (s.version === 2) {
    return {
      identity: {
        publicKey: parsePubkey(s.publicKey),
        secretKey: fromHex(s.secretKey),
        nostrPublicKey: fromHex(s.nostrPublicKey),
        nostrSecretKey: fromHex(s.nostrSecretKey),
      },
      migrated: false,
    };
  }
  throw new Error(`unsupported identity version: ${(s as { version: number }).version}`);
};

export const saveIdentity = async (
  id: Identity,
  path: string = defaultIdentityPath(),
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(serialize(id), null, 2));
  await chmod(path, 0o600);
};

export const loadIdentity = async (
  path: string = defaultIdentityPath(),
): Promise<Identity> => {
  const raw = await readFile(path, "utf8");
  const { identity, migrated } = deserialize(JSON.parse(raw) as SerializedIdentity);
  if (migrated) {
    // Persist the v2-upgraded form so we don't migrate again on the next load.
    await saveIdentity(identity, path);
  }
  return identity;
};

export const loadOrCreateIdentity = async (
  path: string = defaultIdentityPath(),
): Promise<{ identity: Identity; created: boolean }> => {
  if (existsSync(path)) {
    return { identity: await loadIdentity(path), created: false };
  }
  const identity = generateIdentity();
  await saveIdentity(identity, path);
  return { identity, created: true };
};
