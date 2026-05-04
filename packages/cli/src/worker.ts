import {
  type Announcement,
  DEFAULT_WORKER_TIER,
  defaultIdentityPath,
  formatPubkey,
  fromHex,
  type Identity,
  isWorkerTier,
  loadOrCreateIdentity,
  signAnnouncement,
  sign,
  toHex,
  type WorkerTier,
} from "@lobstah/protocol";
import {
  DEFAULT_RELAYS,
  formatNostrNpub,
  publishAnnouncement,
  unpublishAnnouncement,
} from "@lobstah/transport-nostr";
import { startWorker } from "@lobstah/worker";

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const flagAll = (args: string[], name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const v = args[i + 1];
      if (v) out.push(v);
    }
  }
  return out;
};

const enc = new TextEncoder();

const announceOnce = async (
  identity: Identity,
  trackerUrl: string,
  announceUrl: string,
  label: string,
  ttlSeconds: number,
  models: string[],
  tier: WorkerTier,
): Promise<{ ok: boolean; error?: string }> => {
  const announcement: Announcement = {
    version: 1,
    pubkey: formatPubkey(identity.publicKey),
    url: announceUrl,
    label,
    models,
    tier,
    ttlSeconds,
    announcedAt: Date.now(),
  };
  const signed = signAnnouncement(announcement, identity.secretKey);
  try {
    const res = await fetch(`${trackerUrl.replace(/\/$/, "")}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${await res.text()}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const unannounce = async (
  identity: Identity,
  trackerUrl: string,
): Promise<void> => {
  const pubkey = formatPubkey(identity.publicKey);
  const timestamp = Date.now();
  const sig = sign(
    enc.encode(`unannounce:${pubkey}:${timestamp}`),
    identity.secretKey,
  );
  try {
    await fetch(`${trackerUrl.replace(/\/$/, "")}/unannounce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, timestamp, signature: toHex(sig) }),
    });
  } catch {
    // best effort
  }
};

const announceViaNostr = async (
  identity: Identity,
  announceUrl: string,
  label: string,
  ttlSeconds: number,
  models: string[],
  tier: WorkerTier,
  relays: ReadonlyArray<string>,
): Promise<{ ok: boolean; eventId?: string; accepted?: string[]; error?: string }> => {
  const announcement: Announcement = {
    version: 1,
    pubkey: formatPubkey(identity.publicKey),
    url: announceUrl,
    label,
    models,
    tier,
    ttlSeconds,
    announcedAt: Date.now(),
  };
  const signed = signAnnouncement(announcement, identity.secretKey);
  try {
    const result = await publishAnnouncement(signed, identity.nostrSecretKey, { relays });
    if (result.acceptedBy.length === 0) {
      return {
        ok: false,
        error: `no relays accepted (rejected by ${result.rejectedBy.length})`,
      };
    }
    return { ok: true, eventId: result.eventId, accepted: result.acceptedBy };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const fetchLocalModels = async (port: number): Promise<string[]> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/capacity`);
    if (!r.ok) return [];
    const cap = (await r.json()) as { models?: string[] };
    return cap.models ?? [];
  } catch {
    return [];
  }
};

export const worker = async (args: string[]): Promise<void> => {
  const portArg = flag(args, "--port");
  const hostArg = flag(args, "--host");
  const announceTo = flag(args, "--announce-to");
  const announceUrl = flag(args, "--announce-url");
  const announceLabel = flag(args, "--announce-label") ?? "lobstah-worker";
  const announceTtl = Number(flag(args, "--announce-ttl") ?? "300");
  const publishViaNostr = args.includes("--publish-via-nostr");
  const nostrRelays = flagAll(args, "--nostr-relay");
  const tierArg = flag(args, "--tier") ?? DEFAULT_WORKER_TIER;
  if (!isWorkerTier(tierArg)) {
    process.stderr.write(
      `--tier must be one of: interactive, batch, best-effort (got "${tierArg}")\n`,
    );
    process.exit(2);
  }
  const tier: WorkerTier = tierArg;
  const concurrencyArg = flag(args, "--concurrency");
  const concurrency = concurrencyArg ? Number(concurrencyArg) : undefined;
  if (concurrencyArg !== undefined) {
    if (!Number.isInteger(concurrency) || (concurrency as number) < 1) {
      process.stderr.write(
        `--concurrency must be a positive integer (got "${concurrencyArg}")\n`,
      );
      process.exit(2);
    }
  }
  const port = portArg ? Number(portArg) : undefined;

  if (announceTo && !announceUrl) {
    process.stderr.write(
      "--announce-to requires --announce-url <reachable-url-of-this-worker>\n",
    );
    process.exit(2);
  }
  if (publishViaNostr && !announceUrl) {
    process.stderr.write(
      "--publish-via-nostr requires --announce-url <reachable-url-of-this-worker>\n",
    );
    process.exit(2);
  }

  const { identity } = await loadOrCreateIdentity();
  const pk = formatPubkey(identity.publicKey);
  const npub = formatNostrNpub(identity.nostrPublicKey);

  const w = await startWorker({ identity, port, host: hostArg, tier, concurrency });

  const effectiveHost = hostArg ?? "127.0.0.1";
  const isPublicHost = effectiveHost === "0.0.0.0" || effectiveHost === "::";

  process.stdout.write(`lobstah-worker listening on ${effectiveHost}:${w.port}\n`);
  if (isPublicHost) {
    process.stdout.write(
      "  WARNING: bound to all interfaces — the worker exposes Ollama-backed\n" +
        "           inference with no authentication. Make sure the network or\n" +
        "           firewall is restricting who can reach this port.\n",
    );
  }
  process.stdout.write(`  identity: ${defaultIdentityPath()}\n`);
  process.stdout.write(`  lobstah:  ${pk}\n`);
  process.stdout.write(`  nostr:    ${npub}\n`);
  process.stdout.write(`  engine:   ${w.engine}\n`);
  process.stdout.write(`  tier:     ${w.tier}\n`);
  process.stdout.write(`  jobs:     up to ${w.concurrency} in parallel\n`);
  process.stdout.write(`  ollama:   ${process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"}\n`);

  if ((announceTo || publishViaNostr) && !isPublicHost) {
    process.stdout.write(
      "  NOTE: announcing while bound to a loopback host — peers won't be able\n" +
        "        to reach this worker. Pass --host 0.0.0.0 (or a specific interface IP).\n",
    );
  }

  let trackerHeartbeat: NodeJS.Timeout | undefined;
  if (announceTo && announceUrl) {
    const models = await fetchLocalModels(w.port);
    const first = await announceOnce(
      identity,
      announceTo,
      announceUrl,
      announceLabel,
      announceTtl,
      models,
      tier,
    );
    process.stdout.write(
      `  tracker:  ${announceTo}  ${first.ok ? `(announced as ${announceUrl})` : `(FAILED: ${first.error})`}\n`,
    );
    const heartbeatMs = Math.max(Math.floor((announceTtl * 1000) / 2), 30_000);
    trackerHeartbeat = setInterval(() => {
      void (async () => {
        const m = await fetchLocalModels(w.port);
        const r = await announceOnce(
          identity,
          announceTo,
          announceUrl,
          announceLabel,
          announceTtl,
          m,
          tier,
        );
        if (!r.ok) process.stderr.write(`tracker heartbeat FAILED: ${r.error}\n`);
      })();
    }, heartbeatMs);
    trackerHeartbeat?.unref();
  }

  let nostrHeartbeat: NodeJS.Timeout | undefined;
  let lastNostrEventId: string | undefined;
  const activeNostrRelays: ReadonlyArray<string> =
    nostrRelays.length > 0 ? nostrRelays : DEFAULT_RELAYS;
  if (publishViaNostr && announceUrl) {
    const models = await fetchLocalModels(w.port);
    const first = await announceViaNostr(
      identity,
      announceUrl,
      announceLabel,
      announceTtl,
      models,
      tier,
      activeNostrRelays,
    );
    if (first.ok && first.eventId) {
      lastNostrEventId = first.eventId;
      process.stdout.write(
        `  nostr:    published to ${first.accepted?.length ?? 0}/${activeNostrRelays.length} relays (event ${first.eventId.slice(0, 12)}...)\n`,
      );
    } else {
      process.stdout.write(`  nostr:    initial publish FAILED: ${first.error}\n`);
    }
    process.stdout.write(`            relays: ${activeNostrRelays.join(", ")}\n`);
    const heartbeatMs = Math.max(Math.floor((announceTtl * 1000) / 2), 30_000);
    nostrHeartbeat = setInterval(() => {
      void (async () => {
        const m = await fetchLocalModels(w.port);
        const r = await announceViaNostr(
          identity,
          announceUrl,
          announceLabel,
          announceTtl,
          m,
          tier,
          activeNostrRelays,
        );
        if (r.ok && r.eventId) {
          lastNostrEventId = r.eventId;
        } else {
          process.stderr.write(`nostr heartbeat FAILED: ${r.error}\n`);
        }
      })();
    }, heartbeatMs);
    nostrHeartbeat?.unref();
  }

  const shutdown = async (sig: string): Promise<void> => {
    process.stdout.write(`\nreceived ${sig}, shutting down...\n`);
    if (trackerHeartbeat) clearInterval(trackerHeartbeat);
    if (nostrHeartbeat) clearInterval(nostrHeartbeat);
    if (announceTo) {
      process.stdout.write(`  unannouncing from ${announceTo}...\n`);
      await unannounce(identity, announceTo);
    }
    if (publishViaNostr && lastNostrEventId) {
      process.stdout.write("  publishing nostr deletion event (NIP-09)...\n");
      try {
        await unpublishAnnouncement(lastNostrEventId, identity.nostrSecretKey, {
          relays: activeNostrRelays,
        });
      } catch {
        // best effort
      }
    }
    await w.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};
