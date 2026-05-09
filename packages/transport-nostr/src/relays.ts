// Default relay set. Same shape openclaw uses for its `nostr` channel
// extension; well-established free public relays. Operators can override.

export const DEFAULT_RELAYS: ReadonlyArray<string> = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

// Custom event "kind" for lobstah peer announcements.
// Range 30000-39999 is the "parameterized replaceable" range per NIP-33:
// publishing a new event with the same (pubkey, kind, d-tag) overwrites the
// previous one — perfect for heartbeats.
export const LOBSTAH_ANNOUNCEMENT_KIND = 31474;

// 'd' tag is the parameterized-replaceable identifier; we set it to the
// announcer's lobstah pubkey so each peer has at most one live event per
// relay regardless of how often it heartbeats.
export const LOBSTAH_D_TAG = "lobstah-peer";

// Tag also marking the announcement so subscribers can filter cheaply.
export const LOBSTAH_T_TAG = "lobstah";

// Custom event "kind" for lobstah signed-receipt records.
// Range 1000-9999 is the "regular" range per NIP-01: relays SHOULD
// keep these indefinitely (vs replaceable kinds, which only retain
// the latest per (kind, pubkey, d-tag)). We want every receipt
// preserved as a public record, so regular-range fits.
export const LOBSTAH_RECEIPT_KIND = 1474;

// Tag value for receipt events. Same convention as announcements
// (`["t", "lobstah"]`) so a single subscription can filter both.
export const LOBSTAH_RECEIPT_T_TAG = "lobstah-receipt";
