#!/usr/bin/env node
import { balance } from "./balance.js";
import { keygen } from "./keygen.js";
import { peers } from "./peers.js";
import { router } from "./router.js";
import { tracker } from "./tracker.js";
import { worker } from "./worker.js";

const usage = `lobstah — distributed LLM inference grid

Usage:
  lobstah keygen [--force]                       Generate or show identity (lobstah + nostr keys)
  lobstah worker start [--port N] [--host H]     Start a worker daemon (Ollama-backed)
      Discovery flags (all opt-in):
        --publish-via-nostr                      Publish signed announcement to Nostr relays
        --nostr-relay <wss://url>                (repeatable; defaults to damus.io / nos.lol / nostr.band)
        --announce-to <tracker-url>              Or register with a centralized HTTP tracker
        --announce-url <reachable-url>           Required for either advertise mode
        --announce-label <name>                  Friendly name (default: "lobstah-worker")
        --announce-ttl <sec>                     Heartbeat TTL (default: 300)
  lobstah router start [--port N] [--host H]     Start a router (forwards to peers)
  lobstah tracker start [--port N] [--host H]    Run a centralized HTTP tracker (legacy alternative to Nostr)
  lobstah peers add <pubkey> <url> [label]       Manually add a peer
  lobstah peers remove <pubkey>                  Remove a peer
  lobstah peers list                             List configured peers
  lobstah peers sync <tracker-url>               Pull peer list from an HTTP tracker (opt-in)
  lobstah peers gossip-nostr                     Pull peer list from Nostr relays (opt-in)
      [--nostr-relay <wss://url>]                (repeatable; defaults as above)
  lobstah balance                                Show ledger balance

Env:
  LOBSTAH_IDENTITY  path to identity.json (default: ~/.lobstah/identity.json)
  LOBSTAH_PEERS     path to peers.json    (default: ~/.lobstah/peers.json)
  LOBSTAH_LEDGER    path to ledger.jsonl  (default: ~/.lobstah/ledger.jsonl)
  OLLAMA_HOST       Ollama base URL       (default: http://127.0.0.1:11434)
  LOBSTAH_BLOCK_PRIVATE_ADDRS=1            Block RFC1918/ULA/CGNAT in URL safety check
`;

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage);
    return;
  }

  switch (cmd) {
    case "keygen":
      await keygen(rest);
      return;
    case "worker": {
      const sub = rest[0];
      if (sub !== "start") {
        process.stderr.write(`unknown worker subcommand: ${sub ?? "(none)"}\n${usage}`);
        process.exit(2);
      }
      await worker(rest.slice(1));
      return;
    }
    case "router": {
      const sub = rest[0];
      if (sub !== "start") {
        process.stderr.write(`unknown router subcommand: ${sub ?? "(none)"}\n${usage}`);
        process.exit(2);
      }
      await router(rest.slice(1));
      return;
    }
    case "tracker":
      await tracker(rest);
      return;
    case "peers":
      await peers(rest);
      return;
    case "balance":
      await balance(rest);
      return;
    default:
      process.stderr.write(`unknown command: ${cmd}\n${usage}`);
      process.exit(2);
  }
};

main().catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
