// Config knobs resolved at module load, isolated from network code.
// This module intentionally has no imports of network primitives so
// ClawHub's plugin static-analysis scanner can be confident the env
// reads here are configuration, not exfiltration.
//
// Mutating the host environment after this module loads has no
// effect; restart the host to pick up new settings.

export const BLOCK_PRIVATE_NETWORK: boolean =
  // eslint-disable-next-line no-process-env
  globalThis.process?.env?.LOBSTAH_BLOCK_PRIVATE_ADDRS === "1";

// Privacy opt-out: when set, the embedded router skips the auto-gossip
// from Nostr at plugin activation. Subscribing to relays reveals
// nothing about the local identity (nothing is signed or sent
// outward), but some users may want to keep their machine fully off-
// network until they explicitly run `lobstah peers gossip-nostr`.
export const SKIP_NOSTR_AUTOGOSSIP: boolean =
  // eslint-disable-next-line no-process-env
  globalThis.process?.env?.LOBSTAH_OPENCLAW_NO_NOSTR === "1";
