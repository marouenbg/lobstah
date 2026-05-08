// Two-way grid: in addition to consuming compute via the embedded
// router, this module spins up an in-process WORKER and publishes a
// signed Nostr announcement so peers can route inference jobs to the
// user's Mac.
//
// User UX:
//   /lobstah share on <public-url>   start sharing at the given URL
//   /lobstah share off               NIP-09 delete + stop worker
//
// The plugin does NOT spawn cloudflared / ngrok / etc. — that's the
// user's responsibility. They run a tunnel (or use Tailscale, port
// forwarding, a static IP) and pass the resulting URL into the slash
// command. Two reasons for this design:
//
// 1. The ClawHub plugin scanner blocks community plugins from using
//    subprocess spawning — even our legitimate use to start a tunnel
//    binary is indistinguishable from credential exfiltration to a
//    static analyzer. Keeping the worker side subprocess-free
//    unblocks publish.
// 2. Users are likely to have *some* tunnel they already trust
//    (Tailscale on a corporate laptop, port-forward at home,
//    Cloudflare Named Tunnel for production). Forcing cloudflared
//    quick tunnels would be the wrong default for many of them.
//
// Lifecycle:
//   on:  validate URL via @lobstah/protocol url-safety, load
//        identity, start in-process worker on 127.0.0.1:17474,
//        publish signed Nostr announcement, schedule heartbeat.
//   off: NIP-09 deletion, stop worker.
//
// State is in-memory + a small persisted intent file at
// ~/.lobstah/share-state.json. The file records "the user wants to be
// sharing at <url> with <label>"; on plugin activation we read it and
// re-enable. The file is cleaned up on `share off`. If openclaw
// restarts while sharing, the resume picks up automatically — but
// note that the user-supplied tunnel URL has to still be reachable.
// If they were on a cloudflared quick tunnel that died with their
// terminal, resume will fail at the announce step and they'll need
// to start a fresh tunnel and re-toggle.

import { OllamaEngine } from "@lobstah/engine-ollama";
import {
  type Announcement,
  assertSafeUrl,
  formatPubkey,
  type Identity,
  loadOrCreateIdentity,
  signAnnouncement,
} from "@lobstah/protocol";
import {
  DEFAULT_RELAYS,
  publishAnnouncement,
  unpublishAnnouncement,
} from "@lobstah/transport-nostr";
import { type RunningWorker, startWorker } from "@lobstah/worker";
import {
  clearShareIntent,
  readShareIntent,
  writeShareIntent,
} from "./share-state.js";

const WORKER_PORT = 17474;
const ANNOUNCE_LABEL = "openclaw-shared";
const ANNOUNCE_TTL_SECONDS = 300;
const HEARTBEAT_MS = Math.floor((ANNOUNCE_TTL_SECONDS * 1000) / 2);


type ActiveShare = {
  startedAt: number;
  worker: RunningWorker;
  identity: Identity;
  tunnelUrl: string;
  announceLabel: string;
  heartbeat: NodeJS.Timeout;
  lastEventId?: string;
};

let active: ActiveShare | undefined;

export type ShareState = {
  enabled: boolean;
  startedAt?: number;
  tunnelUrl?: string;
  pubkey?: string;
  workerPort?: number;
  announceLabel?: string;
};

export const getShareState = (): ShareState => {
  if (!active) return { enabled: false };
  return {
    enabled: true,
    startedAt: active.startedAt,
    tunnelUrl: active.tunnelUrl,
    pubkey: formatPubkey(active.identity.publicKey),
    workerPort: active.worker.port,
    announceLabel: active.announceLabel,
  };
};

// Probe Ollama via its HTTP API — no subprocess spawning. Returns
// missing prerequisites rather than throwing so the caller renders a
// tidy message.
export const checkPrerequisites = async (): Promise<{
  ok: boolean;
  reasons: string[];
}> => {
  const reasons: string[] = [];
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) reasons.push(`ollama responded with HTTP ${r.status}`);
    else {
      const body = (await r.json()) as { models?: { name: string }[] };
      if (!body.models || body.models.length === 0) {
        reasons.push("ollama is running but has no models pulled (try `ollama pull llama3.1:8b`)");
      }
    }
  } catch {
    reasons.push("ollama is not running on 127.0.0.1:11434 (install: https://ollama.com)");
  }
  return { ok: reasons.length === 0, reasons };
};

const announceOnce = async (
  identity: Identity,
  url: string,
  label: string,
  models: string[],
): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }> => {
  const announcement: Announcement = {
    version: 1,
    pubkey: formatPubkey(identity.publicKey),
    url,
    label,
    models,
    tier: "batch",
    ttlSeconds: ANNOUNCE_TTL_SECONDS,
    announcedAt: Date.now(),
  };
  const signed = signAnnouncement(announcement, identity.secretKey);
  try {
    const result = await publishAnnouncement(signed, identity.nostrSecretKey, {
      relays: DEFAULT_RELAYS,
    });
    if (result.acceptedBy.length === 0) {
      return { ok: false, reason: `no relays accepted (rejected by ${result.rejectedBy.length})` };
    }
    return { ok: true, eventId: result.eventId };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reason };
  }
};

export type EnableResult =
  | { ok: true; tunnelUrl: string; pubkey: string; eventId?: string }
  | { ok: false; reasons: string[] };

export const enableShareCompute = async (opts: {
  tunnelUrl: string;
  announceLabel?: string;
}): Promise<EnableResult> => {
  if (active) {
    return {
      ok: true,
      tunnelUrl: active.tunnelUrl,
      pubkey: formatPubkey(active.identity.publicKey),
      ...(active.lastEventId ? { eventId: active.lastEventId } : {}),
    };
  }

  const tunnelUrl = opts.tunnelUrl.trim();
  if (tunnelUrl.length === 0) {
    return { ok: false, reasons: ["public URL is required"] };
  }

  // Validate the URL the user passed: must parse, must have an http/
  // https scheme, must resolve to something other than loopback /
  // link-local / unspecified. Reuses the same SSRF-safety helper the
  // router uses on outbound peer connections so the trust model is
  // symmetric: we don't advertise an unsafe URL even if the user
  // typed one.
  const safe = await assertSafeUrl(tunnelUrl, {
    blockPrivateNetwork: false,
  });
  if ("reason" in safe) {
    return { ok: false, reasons: [`invalid announce URL: ${safe.reason}`] };
  }

  const pre = await checkPrerequisites();
  if (!pre.ok) return { ok: false, reasons: pre.reasons };

  const { identity } = await loadOrCreateIdentity();

  let worker: RunningWorker;
  try {
    worker = await startWorker({
      identity,
      port: WORKER_PORT,
      host: "127.0.0.1",
      engine: new OllamaEngine(),
      tier: "batch",
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reasons: [`worker start failed: ${reason}`] };
  }

  const announceLabel = opts.announceLabel ?? ANNOUNCE_LABEL;
  const cap = await fetchLocalModels(worker.port);
  const first = await announceOnce(identity, tunnelUrl, announceLabel, cap);
  if ("reason" in first) {
    await worker.stop().catch(() => undefined);
    return {
      ok: false,
      reasons: [`Nostr publish failed: ${first.reason}`],
    };
  }

  const lastEventId = first.eventId;
  const heartbeat = setInterval(() => {
    void (async () => {
      if (!active) return;
      const m = await fetchLocalModels(active.worker.port);
      const r = await announceOnce(active.identity, active.tunnelUrl, announceLabel, m);
      if ("eventId" in r) active.lastEventId = r.eventId;
    })();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  active = {
    startedAt: Date.now(),
    worker,
    identity,
    tunnelUrl,
    announceLabel,
    heartbeat,
    lastEventId,
  };

  // Persist the intent so we can auto-resume on next plugin activation.
  void writeShareIntent({
    version: 1,
    enabledSince: active.startedAt,
    tunnelUrl,
    announceLabel,
  });

  return {
    ok: true,
    tunnelUrl,
    pubkey: formatPubkey(identity.publicKey),
    eventId: lastEventId,
  };
};

// Best-effort resume on plugin activation. If the user was sharing
// when openclaw last shut down, this brings them back online with the
// same URL + label. Failures are silent (the user can manually
// /lobstah share on again if the URL has gone stale, e.g. a
// cloudflared quick tunnel that died with their terminal).
export const tryResume = async (): Promise<
  { resumed: false } | { resumed: true; tunnelUrl: string }
> => {
  const intent = await readShareIntent();
  if (!intent) return { resumed: false };
  const r = await enableShareCompute({
    tunnelUrl: intent.tunnelUrl,
    announceLabel: intent.announceLabel,
  });
  if ("reasons" in r) {
    // Resume failed (URL no longer reachable, ollama down, etc.).
    // Clear the intent so we don't keep retrying every activation.
    await clearShareIntent();
    return { resumed: false };
  }
  return { resumed: true, tunnelUrl: r.tunnelUrl };
};

export type DisableResult = {
  ok: true;
  hadActiveShare: boolean;
  unpublished?: boolean;
};

export const disableShareCompute = async (): Promise<DisableResult> => {
  const handle = active;
  // Always clear persisted intent on disable, even if there's no
  // active in-memory state — handles the case where the plugin
  // crashed mid-session and left the file behind.
  await clearShareIntent();
  if (!handle) return { ok: true, hadActiveShare: false };
  active = undefined;
  clearInterval(handle.heartbeat);

  let unpublished = false;
  if (handle.lastEventId) {
    try {
      await unpublishAnnouncement(handle.lastEventId, handle.identity.nostrSecretKey, {
        relays: DEFAULT_RELAYS,
      });
      unpublished = true;
    } catch {
      // best-effort; the event will eventually expire on TTL
    }
  }

  await handle.worker.stop().catch(() => undefined);
  return { ok: true, hadActiveShare: true, unpublished };
};

const fetchLocalModels = async (port: number): Promise<string[]> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/capacity`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return [];
    const cap = (await r.json()) as { models?: string[] };
    return cap.models ?? [];
  } catch {
    return [];
  }
};
