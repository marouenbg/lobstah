import {
  assertSafeUrl,
  type SignedAnnouncement,
  verifyAnnouncement,
} from "@lobstah/protocol";
import { addPeer, loadPeers, removePeer } from "@lobstah/router";
import { collectAnnouncements, DEFAULT_RELAYS } from "@lobstah/transport-nostr";

const blockPrivateNetwork = (): boolean =>
  process.env.LOBSTAH_BLOCK_PRIVATE_ADDRS === "1";

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

export const peers = async (args: string[]): Promise<void> => {
  const sub = args[0];
  switch (sub) {
    case "add": {
      const pubkey = args[1];
      const url = args[2];
      const label = args[3];
      if (!pubkey || !url) {
        process.stderr.write("usage: lobstah peers add <pubkey> <url> [label]\n");
        process.exit(2);
      }
      const safe = await assertSafeUrl(url, { blockPrivateNetwork: blockPrivateNetwork() });
      if (!safe.ok) {
        process.stderr.write(`refusing to add peer: ${safe.reason}\n`);
        process.stderr.write(
          "(set LOBSTAH_BLOCK_PRIVATE_ADDRS=0 or =1 to adjust the URL safety policy)\n",
        );
        process.exit(2);
      }
      const list = await addPeer({ pubkey, url, label });
      process.stdout.write(`added peer ${pubkey} -> ${url}\n`);
      process.stdout.write(`(${list.length} peer${list.length === 1 ? "" : "s"} total)\n`);
      return;
    }
    case "remove": {
      const pubkey = args[1];
      if (!pubkey) {
        process.stderr.write("usage: lobstah peers remove <pubkey>\n");
        process.exit(2);
      }
      const list = await removePeer(pubkey);
      process.stdout.write(`removed peer ${pubkey}\n`);
      process.stdout.write(`(${list.length} peer${list.length === 1 ? "" : "s"} remaining)\n`);
      return;
    }
    case "sync": {
      const trackerUrl = args[1];
      if (!trackerUrl) {
        process.stderr.write("usage: lobstah peers sync <tracker-url>\n");
        process.exit(2);
      }
      let res: Response;
      try {
        res = await fetch(`${trackerUrl.replace(/\/$/, "")}/peers`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`could not reach tracker at ${trackerUrl}: ${msg}\n`);
        process.exit(1);
      }
      if (!res.ok) {
        process.stderr.write(`tracker ${res.status}: ${await res.text()}\n`);
        process.exit(1);
      }
      const data = (await res.json()) as { peers?: SignedAnnouncement[] };
      const incoming = data.peers ?? [];
      let added = 0;
      let rejectedSig = 0;
      let rejectedUrl = 0;
      const policy = { blockPrivateNetwork: blockPrivateNetwork() };
      for (const signed of incoming) {
        if (!verifyAnnouncement(signed)) {
          rejectedSig += 1;
          continue;
        }
        const a = signed.announcement;
        const safe = await assertSafeUrl(a.url, policy);
        if (!safe.ok) {
          rejectedUrl += 1;
          process.stderr.write(`  skipping ${a.pubkey.slice(0, 16)}: ${safe.reason}\n`);
          continue;
        }
        await addPeer({ pubkey: a.pubkey, url: a.url, label: a.label });
        added += 1;
      }
      const tail: string[] = [];
      if (rejectedSig) tail.push(`${rejectedSig} bad-signature`);
      if (rejectedUrl) tail.push(`${rejectedUrl} unsafe-url`);
      process.stdout.write(
        `synced ${added} peer(s) from ${trackerUrl}` +
          (tail.length ? ` (rejected ${tail.join(", ")})` : "") +
          "\n",
      );
      return;
    }
    case "gossip-nostr": {
      const customRelays = flagAll(args, "--nostr-relay");
      const relays = customRelays.length > 0 ? customRelays : [...DEFAULT_RELAYS];
      process.stdout.write(`subscribing to ${relays.length} relay(s):\n`);
      for (const r of relays) process.stdout.write(`  ${r}\n`);
      const start = Date.now();
      const { accepted, rejected } = await collectAnnouncements({ relays });
      const elapsed = Math.round((Date.now() - start) / 100) / 10;
      process.stdout.write(
        `received ${accepted.length} valid announcement(s) in ${elapsed}s ` +
          `(${rejected.length} rejected)\n`,
      );

      let added = 0;
      let rejectedUrl = 0;
      const policy = { blockPrivateNetwork: blockPrivateNetwork() };

      // Relays may return multiple events for the same pubkey when a
      // worker has heartbeated more than once and old events haven't
      // expired yet. Dedupe by pubkey, keeping the announcement with
      // the latest `announcedAt`. Without this, addPeer's last-write-
      // wins behavior makes the resolved URL non-deterministic when
      // a worker has changed announce-url between heartbeats (e.g.
      // restarted with a fresh tunnel URL).
      const latestByPubkey = new Map<string, typeof accepted[number]>();
      for (const ingested of accepted) {
        const a = ingested.signed.announcement;
        const prev = latestByPubkey.get(a.pubkey);
        if (!prev || a.announcedAt > prev.signed.announcement.announcedAt) {
          latestByPubkey.set(a.pubkey, ingested);
        }
      }

      for (const ingested of latestByPubkey.values()) {
        const a = ingested.signed.announcement;
        const safe = await assertSafeUrl(a.url, policy);
        if (!safe.ok) {
          rejectedUrl += 1;
          process.stderr.write(`  skipping ${a.pubkey.slice(0, 16)}: ${safe.reason}\n`);
          continue;
        }
        await addPeer({ pubkey: a.pubkey, url: a.url, label: a.label });
        added += 1;
      }
      const tail: string[] = [];
      if (rejected.length) tail.push(`${rejected.length} nostr-rejected`);
      if (rejectedUrl) tail.push(`${rejectedUrl} unsafe-url`);
      process.stdout.write(
        `merged ${added} peer(s) into local peers.json` +
          (tail.length ? ` (rejected ${tail.join(", ")})` : "") +
          "\n",
      );
      return;
    }
    case "list":
    case undefined: {
      const list = await loadPeers();
      if (list.length === 0) {
        process.stdout.write("no peers configured\n");
        return;
      }
      for (const p of list) {
        const lbl = p.label ? `  [${p.label}]` : "";
        process.stdout.write(`  ${p.pubkey}\n    ${p.url}${lbl}\n`);
      }
      return;
    }
    default:
      process.stderr.write(`unknown peers subcommand: ${sub}\n`);
      process.exit(2);
  }
};
