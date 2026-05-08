// In-process dashboard renderer for the /lobstah slash command.
// Reads the same data sources the bash script at ~/.lobstah/bin/
// lobstah-dashboard reads, but doesn't shell out — uses the @lobstah
// libraries directly. Returns a markdown string ready to drop into
// a PluginCommandResult { text }.

import { computeBalances, readAll } from "@lobstah/ledger";
import { formatPubkey, loadOrCreateIdentity, type SignedReceipt } from "@lobstah/protocol";
import { loadPeers, type Peer } from "@lobstah/router";

const PROBE_TIMEOUT_MS = 4000;

type CapacitySnapshot = {
  reachable: boolean;
  models?: string[];
  tier?: string;
  queueDepth?: number;
  concurrency?: number;
  reason?: string;
};

const probeCapacity = async (peer: Peer): Promise<CapacitySnapshot> => {
  const url = `${peer.url.replace(/\/$/, "")}/capacity`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return { reachable: false, reason: `HTTP ${r.status}` };
    const cap = (await r.json()) as {
      models?: string[];
      tier?: string;
      queueDepth?: number;
      concurrency?: number;
    };
    return {
      reachable: true,
      models: cap.models ?? [],
      tier: cap.tier,
      queueDepth: cap.queueDepth,
      concurrency: cap.concurrency,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { reachable: false, reason };
  }
};

const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  return d.toISOString().slice(11, 19);
};

const truncatePubkey = (pk: string, head = 16): string =>
  pk.length > head ? `${pk.slice(0, head)}…` : pk;

export type DashboardShareState = {
  enabled: boolean;
  tunnelUrl?: string;
  startedAt?: number;
  pubkey?: string;
  announceLabel?: string;
};

export type DashboardOptions = {
  // Cap probe parallelism; default reasonable for a few peers.
  maxParallel?: number;
  // Optional snapshot of "are we sharing compute right now?" — surfaced
  // as a top-line banner. The plugin entry knows this; the dashboard
  // helper takes it as input rather than reaching back into the share-
  // compute module so it stays pure / testable.
  shareState?: DashboardShareState;
};

// Build the markdown body. Never throws — partial failures degrade
// gracefully (a section may be empty rather than the whole thing
// erroring out).
export const renderDashboard = async (opts: DashboardOptions = {}): Promise<string> => {
  const lines: string[] = [];
  lines.push("🦞 **Lobstah network status**");
  lines.push("");

  // ── Share-compute status banner ──────────────────────────────
  if (opts.shareState) {
    if (opts.shareState.enabled) {
      const dur = opts.shareState.startedAt
        ? Math.round((Date.now() - opts.shareState.startedAt) / 1000)
        : 0;
      lines.push(`📡 **Sharing compute** for ${dur}s · ${opts.shareState.tunnelUrl ?? "?"}`);
    } else {
      lines.push("📡 _Not sharing compute. `/lobstah share on` to start._");
    }
    lines.push("");
  }

  // ── Workers ──────────────────────────────────────────────────
  let peers: Peer[] = [];
  try {
    peers = await loadPeers();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    lines.push(`**Workers** — could not load peers.json (${reason})`);
    lines.push("");
  }

  if (peers.length === 0) {
    lines.push("**Workers**");
    lines.push("");
    lines.push(
      "_No peers configured. The plugin auto-gossips at activation; if you keep seeing this, run `lobstah peers gossip-nostr` from a terminal._",
    );
    lines.push("");
  } else {
    lines.push(`**Workers** (${peers.length})`);
    lines.push("");
    const snapshots = await Promise.all(peers.map((p) => probeCapacity(p)));
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i]!;
      const snap = snapshots[i]!;
      const labelTag = peer.label ? ` _${peer.label}_` : "";
      const head = `- \`${truncatePubkey(peer.pubkey, 24)}\`${labelTag}`;
      lines.push(head);
      lines.push(`  ${peer.url}`);
      if (snap.reachable) {
        const models = (snap.models ?? []).join(", ") || "_(none advertised)_";
        const bits = [
          `models: ${models}`,
          snap.tier ? `tier: ${snap.tier}` : null,
          snap.concurrency != null ? `concurrency: ${snap.concurrency}` : null,
          snap.queueDepth != null ? `queue: ${snap.queueDepth}` : null,
        ].filter((s): s is string => s !== null);
        lines.push(`  ✓ live · ${bits.join(" · ")}`);
      } else {
        lines.push(`  ✗ unreachable (${snap.reason ?? "unknown"})`);
      }
    }
    lines.push("");
  }

  // ── Your balance ─────────────────────────────────────────────
  let myPubkey: string | undefined;
  try {
    const { identity } = await loadOrCreateIdentity();
    myPubkey = formatPubkey(identity.publicKey);
  } catch {
    // Without an identity we still render the rest of the dashboard.
  }

  let receipts: SignedReceipt[] = [];
  try {
    receipts = await readAll();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    lines.push(`**Balance** — ledger read failed (${reason})`);
    lines.push("");
  }

  if (receipts.length > 0 && myPubkey) {
    const summary = computeBalances(receipts);
    const me = summary.perPeer.get(myPubkey) ?? {
      pubkey: myPubkey,
      earned: 0,
      spent: 0,
      net: 0,
    };
    lines.push("**Your balance**");
    lines.push("");
    lines.push(
      `_${truncatePubkey(myPubkey, 24)}_ · earned **${me.earned}** · spent **${me.spent}** · net **${me.net >= 0 ? "+" : ""}${me.net}** tokens`,
    );
    const totalTokens = summary.totals.earned + summary.totals.spent;
    lines.push(
      `_(${summary.totals.receipts} total receipts in ledger, ${totalTokens} tokens metered network-wide)_`,
    );
    lines.push("");
  }

  // ── Recent receipts ──────────────────────────────────────────
  if (receipts.length > 0) {
    const recent = receipts.slice(-5).reverse();
    lines.push("**Recent receipts**");
    lines.push("");
    for (const signed of recent) {
      const r = signed.receipt;
      const time = fmtTime(r.completedAt);
      const direction =
        myPubkey === r.requesterPubkey
          ? `→ \`${truncatePubkey(r.workerPubkey)}\``
          : myPubkey === r.workerPubkey
            ? `← \`${truncatePubkey(r.requesterPubkey)}\``
            : `\`${truncatePubkey(r.workerPubkey)}\``;
      lines.push(
        `- ${time} · ${r.model} · in=${r.inputTokens} out=${r.outputTokens} · ${direction}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};
