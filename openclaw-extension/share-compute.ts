// Two-way grid: in addition to consuming compute via the embedded
// router, this module spins up an in-process WORKER plus a cloudflared
// quick tunnel so the user's Mac advertises itself to the lobstah
// network. Toggle on/off via the /lobstah slash command.
//
// Lifecycle:
//   on:  spawn cloudflared, capture *.trycloudflare.com URL, start
//        in-process worker on 127.0.0.1:17474, publish signed Nostr
//        announcement, schedule heartbeat re-publish.
//   off: NIP-09-delete the announcement, stop the worker, kill the
//        cloudflared subprocess.
//
// State is in-memory. If openclaw restarts while sharing is on, the
// orphaned cloudflared process exits when the parent dies (we set
// detached: false), the worker process dies with the host, and the
// stale Nostr announcement expires on its own TTL (~5 min) — the user
// has to /lobstah share on again to come back online. Persisting and
// auto-resuming across restarts is a future polish item.

import { OllamaEngine } from "@lobstah/engine-ollama";
import {
  type Announcement,
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
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKER_PORT = 17474;
const ANNOUNCE_LABEL = "openclaw-shared";
const ANNOUNCE_TTL_SECONDS = 300;
const HEARTBEAT_MS = Math.floor((ANNOUNCE_TTL_SECONDS * 1000) / 2);

type ActiveShare = {
  startedAt: number;
  worker: RunningWorker;
  identity: Identity;
  cloudflared: ChildProcess;
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

// Light prerequisites probe: Ollama running locally + at least one
// model loaded + cloudflared on PATH. Returns missing prerequisites
// rather than throwing so the caller can render a tidy message.
export const checkPrerequisites = async (): Promise<{
  ok: boolean;
  reasons: string[];
}> => {
  const reasons: string[] = [];

  // Ollama API check
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) reasons.push("ollama responded with HTTP " + r.status);
    else {
      const body = (await r.json()) as { models?: { name: string }[] };
      if (!body.models || body.models.length === 0) {
        reasons.push("ollama is running but has no models pulled (try `ollama pull llama3.1:8b`)");
      }
    }
  } catch {
    reasons.push("ollama is not running on 127.0.0.1:11434 (install: https://ollama.com)");
  }

  // cloudflared on PATH
  const which = await new Promise<string | null>((resolve) => {
    const p = spawn("which", ["cloudflared"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    p.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    p.on("error", () => resolve(null));
  });
  if (!which) {
    reasons.push("cloudflared is not on PATH (install: `brew install cloudflared`)");
  }

  return { ok: reasons.length === 0, reasons };
};

// Spawn cloudflared, parse stdout for the trycloudflare URL. Resolves
// once the URL is in hand; rejects on cloudflared exit-before-URL or
// timeout.
const spawnCloudflaredTunnel = async (
  port: number,
  logPath: string,
): Promise<{ url: string; child: ChildProcess }> => {
  const child = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  return new Promise<{ url: string; child: ChildProcess }>((resolve, reject) => {
    const URL_RE = /https?:\/\/[a-z0-9.-]+\.trycloudflare\.com/i;
    let buffer = "";
    let timer: NodeJS.Timeout | undefined;
    let resolved = false;

    const onChunk = (chunk: Buffer) => {
      const s = String(chunk);
      buffer += s;
      // Forward all output to a log file for diagnostics. Best effort
      // — we don't await it.
      void mkdir(logPath.replace(/\/[^/]+$/, ""), { recursive: true })
        .catch(() => undefined)
        .then(() =>
          import("node:fs").then(({ appendFile }) => appendFile(logPath, s, () => undefined)),
        );
      const m = buffer.match(URL_RE);
      if (m && !resolved) {
        resolved = true;
        if (timer) clearTimeout(timer);
        resolve({ url: m[0], child });
      }
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk); // cloudflared writes the URL to stderr in some versions
    child.on("error", (e) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      reject(new Error(`cloudflared spawn failed: ${e.message}`));
    });
    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      reject(new Error(`cloudflared exited (code=${code}) before URL appeared`));
    });

    // Cloudflared takes ~3-6s to establish; cap at 30s to surface
    // network/auth issues quickly.
    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill();
      } catch {
        // best-effort
      }
      reject(new Error("timed out waiting for trycloudflare URL after 30s"));
    }, 30_000);
  });
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

export const enableShareCompute = async (
  opts: { announceLabel?: string } = {},
): Promise<EnableResult> => {
  if (active) {
    return {
      ok: true,
      tunnelUrl: active.tunnelUrl,
      pubkey: formatPubkey(active.identity.publicKey),
      ...(active.lastEventId ? { eventId: active.lastEventId } : {}),
    };
  }

  const pre = await checkPrerequisites();
  if (!pre.ok) return { ok: false, reasons: pre.reasons };

  const { identity } = await loadOrCreateIdentity();
  const logPath = join(homedir(), ".lobstah", "logs", "openclaw-share-cloudflared.log");

  // 1) Get the public URL first — without it we have nothing to
  //    announce on Nostr, and a worker reachable only at 127.0.0.1
  //    is useless to peers.
  let tunnel: { url: string; child: ChildProcess };
  try {
    tunnel = await spawnCloudflaredTunnel(WORKER_PORT, logPath);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reasons: [reason] };
  }

  // 2) Start the worker. The cloudflared tunnel forwards public
  //    traffic to 127.0.0.1, so binding the worker to loopback is
  //    fine and avoids exposing 17474 on every interface.
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
    try {
      tunnel.child.kill();
    } catch {
      // best-effort
    }
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reasons: [`worker start failed: ${reason}`] };
  }

  // 3) Publish the signed announcement.
  const announceLabel = opts.announceLabel ?? ANNOUNCE_LABEL;
  const cap = await fetchLocalModels(worker.port);
  const first = await announceOnce(identity, tunnel.url, announceLabel, cap);
  if ("reason" in first) {
    // Tear down before reporting; we don't want a half-up state.
    await worker.stop().catch(() => undefined);
    try {
      tunnel.child.kill();
    } catch {
      // best-effort
    }
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
      if (r.ok) active.lastEventId = r.eventId;
    })();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  active = {
    startedAt: Date.now(),
    worker,
    identity,
    cloudflared: tunnel.child,
    tunnelUrl: tunnel.url,
    announceLabel,
    heartbeat,
    lastEventId,
  };

  return {
    ok: true,
    tunnelUrl: tunnel.url,
    pubkey: formatPubkey(identity.publicKey),
    eventId: lastEventId,
  };
};

export type DisableResult = {
  ok: true;
  hadActiveShare: boolean;
  unpublished?: boolean;
};

export const disableShareCompute = async (): Promise<DisableResult> => {
  const handle = active;
  if (!handle) return { ok: true, hadActiveShare: false };
  active = undefined;
  clearInterval(handle.heartbeat);

  // 1) NIP-09 deletion of the latest announcement event so peers
  //    don't keep routing to a worker we're about to stop.
  let unpublished = false;
  if (handle.lastEventId) {
    try {
      await unpublishAnnouncement(handle.lastEventId, handle.identity.nostrSecretKey, {
        relays: DEFAULT_RELAYS,
      });
      unpublished = true;
    } catch {
      // best-effort — the event will eventually expire on TTL
    }
  }

  // 2) Stop the worker (drains in-flight jobs).
  await handle.worker.stop().catch(() => undefined);

  // 3) Kill the tunnel.
  try {
    handle.cloudflared.kill();
  } catch {
    // best-effort
  }

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
