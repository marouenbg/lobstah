import { nip19 } from "nostr-tools";

// Bech32-encoded public-facing forms of the Nostr identity. These are what
// users typically see and paste between Nostr apps.
//
// Returned strings are like:
//   npub1qqqq...   (public)
//   nsec1qqqq...   (secret — handle carefully)

export const formatNostrNpub = (publicKey: Uint8Array): string =>
  nip19.npubEncode(bytesToHex(publicKey));

export const formatNostrNsec = (secretKey: Uint8Array): string =>
  nip19.nsecEncode(secretKey);

export const parseNostrNpub = (npub: string): Uint8Array => {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") {
    throw new Error(`expected npub, got ${decoded.type}`);
  }
  return hexToBytes(decoded.data);
};

export const parseNostrNsec = (nsec: string): Uint8Array => {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") {
    throw new Error(`expected nsec, got ${decoded.type}`);
  }
  return decoded.data;
};

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const hexToBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
