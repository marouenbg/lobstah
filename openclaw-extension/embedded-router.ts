import {
  assertSafeUrl,
  loadOrCreateIdentity,
  verifyAnnouncement,
} from "@lobstah/protocol";
import { addPeer, type RunningRouter, startRouter } from "@lobstah/router";
import { collectAnnouncements, DEFAULT_RELAYS } from "@lobstah/transport-nostr";

// In-process lobstah-router. Replaces the historic "you must run
// `lobstah router start` separately" step — when the openclaw-provider
// plugin loads, it bootstraps a router on 127.0.0.1 and (optionally)
// drains the Nostr relay buffer to populate peers.json.
//
// Why in-process:
//  - One install (`@lobstah/openclaw-provider` from ClawHub) instead of
//    two (plugin + `@lobstah/cli`)
//  - No second daemon for the user to remember to start after reboot
//  - The router is small (one Hono app, no native deps)
//
// Why not in-process:
//  - The router lives for the lifetime of the openclaw process. If
//    openclaw crashes or restarts, the in-flight job mappings are lost.
//    For cargo workloads this is fine — receipts are durable on disk.
//  - The router holds an HTTP port. We grab 17475 by default, but if
//    something else is on it (e.g. the user runs `lobstah router start`
//    in another window) we either defer to that one or fall back to a
//    fresh port. The plugin's resolved URL is what gets passed down to
//    the openclaw provider config.

export const DEFAULT_ROUTER_PORT = 17475;

type Embedded = {
  url: string;
  source: "external" | "embedded";
  stop?: () => Promise<void>;
};

let activeRouter: Promise<Embedded> | undefined;

const blockPrivateNetwork = (): boolean =>
  process.env.LOBSTAH_BLOCK_PRIVATE_ADDRS === "1";

// Probe a candidate URL: is something already serving the lobstah-router
// surface here? We read /pubkey because it's the cheapest healthcheck the
// router exposes and it's stable across versions.
const probeRouterAlive = async (port: number): Promise<boolean> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/pubkey`, {
      signal: AbortSignal.timeout(750),
    });
    if (!r.ok) return false;
    const body = (await r.json()) as { pubkey?: unknown };
    return typeof body.pubkey === "string" && body.pubkey.startsWith("lob1");
  } catch {
    return false;
  }
};

// Start a router on the first port we can grab. Tries the canonical
// 17475 first; on EADDRINUSE we fall back to an OS-assigned ephemeral
// port (port: 0 is honored by node:net via @hono/node-server).
const startWithFallback = async (
  identity: Awaited<ReturnType<typeof loadOrCreateIdentity>>["identity"],
): Promise<RunningRouter> => {
  try {
    return await startRouter({ identity, port: DEFAULT_ROUTER_PORT });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("EADDRINUSE")) throw e;
    // Try an alternative offset; if THAT fails the user has a stuck
    // process they need to investigate.
    return await startRouter({ identity, port: DEFAULT_ROUTER_PORT + 1 });
  }
};

// Idempotent: subsequent calls return the same instance.
export const ensureEmbeddedRouter = async (): Promise<Embedded> => {
  if (activeRouter) return activeRouter;
  activeRouter = (async () => {
    // External-router-already-running case: defer to it. Lets the user
    // run `lobstah router start` in a terminal alongside openclaw and
    // get the same UX without contention.
    if (await probeRouterAlive(DEFAULT_ROUTER_PORT)) {
      return {
        url: `http://127.0.0.1:${DEFAULT_ROUTER_PORT}`,
        source: "external" as const,
      };
    }
    const { identity } = await loadOrCreateIdentity();
    const running = await startWithFallback(identity);
    return {
      url: `http://127.0.0.1:${running.port}`,
      source: "embedded" as const,
      stop: running.stop,
    };
  })();
  // If startup fails, clear the cache so a retry can try again.
  activeRouter.catch(() => {
    activeRouter = undefined;
  });
  return activeRouter;
};

// Best-effort Nostr drain. Runs in the background — never blocks plugin
// activation, never throws into the host. If relays are blocked or the
// network is unreachable, the user simply doesn't get any new peers
// merged this session; they can still use any peers already in
// peers.json (or `lobstah peers add` manually).
//
// Privacy opt-out: setting LOBSTAH_OPENCLAW_NO_NOSTR=1 disables the
// auto-gossip entirely. Subscribing to relays reveals nothing about
// the local identity (we don't sign or send anything), but some users
// may still want to keep their machine fully off-network until they
// explicitly run `lobstah peers gossip-nostr` themselves.
//
// Returns a snapshot suitable for logging.
export const gossipFromNostrInBackground = async (
  relays: ReadonlyArray<string> = DEFAULT_RELAYS,
): Promise<{
  acceptedCount: number;
  addedCount: number;
  errored: boolean;
  skipped: boolean;
}> => {
  if (process.env.LOBSTAH_OPENCLAW_NO_NOSTR === "1") {
    return { acceptedCount: 0, addedCount: 0, errored: false, skipped: true };
  }
  try {
    const { accepted } = await collectAnnouncements({ relays });
    const policy = { blockPrivateNetwork: blockPrivateNetwork() };
    let added = 0;
    for (const ingested of accepted) {
      const a = ingested.signed.announcement;
      if (!verifyAnnouncement(ingested.signed)) continue;
      const safe = await assertSafeUrl(a.url, policy);
      if (!safe.ok) continue;
      await addPeer({ pubkey: a.pubkey, url: a.url, label: a.label });
      added += 1;
    }
    return { acceptedCount: accepted.length, addedCount: added, errored: false, skipped: false };
  } catch {
    return { acceptedCount: 0, addedCount: 0, errored: true, skipped: false };
  }
};

// Test/teardown helper: not invoked by openclaw at runtime (the openclaw
// host process owns plugin lifetime), but useful for unit tests and
// future plugin-manager hooks.
export const stopEmbeddedRouter = async (): Promise<void> => {
  if (!activeRouter) return;
  const settled = await activeRouter;
  activeRouter = undefined;
  if (settled.source === "embedded" && settled.stop) {
    await settled.stop();
  }
};
