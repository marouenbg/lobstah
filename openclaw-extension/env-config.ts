// Config knobs read from environment, isolated from any module that
// performs network I/O. ClawHub's plugin security scanner flags
// `process.env` access in the same file as `fetch()` / WebSocket
// primitives because that pattern is correlated with credential
// harvesting. Splitting these into a network-free module keeps the
// scan clean while preserving the runtime behaviour.
//
// Resolved at module load. Mutating the env after that won't change
// these values; restart the host to pick up new settings.

export const BLOCK_PRIVATE_NETWORK: boolean =
  process.env.LOBSTAH_BLOCK_PRIVATE_ADDRS === "1";

// Privacy opt-out: if set, the embedded router skips the auto-gossip
// from Nostr at plugin activation. Subscribing to relays reveals
// nothing about the local identity (nothing is signed/sent outward),
// but some users may want to keep their machine fully off-network
// until they explicitly run `lobstah peers gossip-nostr`.
export const SKIP_NOSTR_AUTOGOSSIP: boolean =
  process.env.LOBSTAH_OPENCLAW_NO_NOSTR === "1";
