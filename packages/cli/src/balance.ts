import { computeBalances, readAll } from "@lobstah/ledger";
import {
  BOOTSTRAP_ALLOWANCE_TOKENS,
  formatPubkey,
  loadOrCreateIdentity,
  type SignedReceipt,
} from "@lobstah/protocol";
import { collectReceipts, DEFAULT_RELAYS } from "@lobstah/transport-nostr";

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

export const balance = async (args: string[]): Promise<void> => {
  const networkMode = args.includes("--network");
  const customRelays = flagAll(args, "--nostr-relay");
  const relays = customRelays.length > 0 ? customRelays : [...DEFAULT_RELAYS];

  const { identity } = await loadOrCreateIdentity();
  const ourPk = formatPubkey(identity.publicKey);

  // Pull receipts from local ledger AND optionally Nostr. Combining
  // both gives the fullest picture: local witnesses what flows
  // through this node, Nostr witnesses what every other node
  // published.
  const localReceipts = await readAll();
  let networkReceipts: SignedReceipt[] = [];
  if (networkMode) {
    process.stderr.write(
      `subscribing to ${relays.length} relay(s) for network receipts...\n`,
    );
    const start = Date.now();
    const { accepted, rejected } = await collectReceipts({ relays });
    const elapsed = Math.round((Date.now() - start) / 100) / 10;
    process.stderr.write(
      `received ${accepted.length} valid receipt event(s) in ${elapsed}s ` +
        `(${rejected.length} rejected)\n`,
    );
    networkReceipts = accepted.map((a) => a.signed);
  }

  // Dedupe by receipt nonce (local + network may overlap when our
  // worker has both ledgered and published the same receipt).
  const seen = new Set<string>();
  const all: SignedReceipt[] = [];
  for (const s of [...localReceipts, ...networkReceipts]) {
    if (seen.has(s.receipt.nonce)) continue;
    seen.add(s.receipt.nonce);
    all.push(s);
  }

  const summary = computeBalances(all);
  const self = summary.perPeer.get(ourPk) ?? {
    pubkey: ourPk,
    earned: 0,
    spent: 0,
    net: 0,
    allowance: BOOTSTRAP_ALLOWANCE_TOKENS,
    available: BOOTSTRAP_ALLOWANCE_TOKENS,
  };

  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

  const sourceLabel = networkMode
    ? `network view (local ledger + ${networkReceipts.length} receipts from Nostr)`
    : "local ledger only";

  process.stdout.write(`balance for ${ourPk}\n`);
  process.stdout.write(`  source:                ${sourceLabel}\n`);
  process.stdout.write(`  bootstrap allowance:   ${self.allowance} tokens\n`);
  process.stdout.write(`  earned (as worker):    ${self.earned} tokens\n`);
  process.stdout.write(`  spent  (as requester): ${self.spent} tokens\n`);
  process.stdout.write(`  net:                   ${sign(self.net)} tokens\n`);
  process.stdout.write(`  available credit:      ${self.available} tokens\n`);
  process.stdout.write("\nledger totals:\n");
  process.stdout.write(`  receipts: ${summary.totals.receipts}\n`);
  process.stdout.write(`  tokens:   ${summary.totals.earned}\n`);

  if (summary.perPeer.size > 1) {
    // Sort by available credit descending so the leaderboard makes sense.
    const sorted = Array.from(summary.perPeer.values()).sort(
      (a, b) => b.available - a.available,
    );
    process.stdout.write("\npublic accounts (sorted by available credit):\n");
    for (const b of sorted) {
      const tag = b.pubkey === ourPk ? " (you)" : "";
      process.stdout.write(`  ${b.pubkey}${tag}\n`);
      process.stdout.write(
        `    earned ${b.earned}, spent ${b.spent}, net ${sign(b.net)}, available ${b.available}\n`,
      );
    }
  }

  if (!networkMode) {
    process.stdout.write(
      "\n(use `lobstah balance --network` to also include receipts published to Nostr)\n",
    );
  }
};
