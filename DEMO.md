# 🦞 Lobstah — 5-minute demo

A walkthrough for showing the network end-to-end. Assumes the watcher
already has openclaw installed; if not, see the [openclaw install
docs](https://docs.openclaw.ai) first.

## What you're showing

A federated, signed-receipt-accounted P2P inference grid where:

1. **Consumers** discover workers via Nostr (no central registry, no
   account anywhere)
2. **Workers** advertise themselves via signed Nostr events
3. **Receipts** are Ed25519-signed by the worker, validated + ledgered
   by the consumer
4. **Routing** happens locally — the consumer's router picks the next
   peer round-robin among healthy candidates

## Prereqs (one-time)

```sh
brew install ollama       # local inference engine
ollama serve &            # background
ollama pull llama3.1:8b   # ~4.7 GB

# Already have openclaw? Skip to "Demo".
npm install -g openclaw
```

## Demo

### 1 · Install lobstah inside openclaw (one command)

```sh
openclaw plugins install clawhub:@lobstah/openclaw-provider
```

Point at the ClawHub listing as you run this:
<https://clawhub.ai/plugins/@lobstah/openclaw-provider>

What happens automatically:

- Plugin lands in `~/.openclaw/extensions/lobstah/`
- On activation: embedded router boots on 127.0.0.1:17475, identity
  generated under `~/.lobstah/`, peers.json populated by gossiping the
  default Nostr relays (damus.io, nos.lol, relay.nostr.band)

### 2 · Show the network status from inside openclaw

```
openclaw chat
```

Type:

```
/lobstah
```

Inline output: peers + their reachability + your credit balance + last
5 receipts. The output should include at minimum the AWS anchor at
`ec2-3-150-123-235.us-east-2.compute.amazonaws.com` (always-on, ~$53/mo
Linux ARM).

### 3 · Run a chat completion

In openclaw, pick **Lobstah grid** as your provider. Send any prompt:

> "What's the difference between an llm router and an llm gateway?"

The completion comes from a peer worker — by default, the AWS anchor.
Watch the response stream in.

### 4 · Show the ledger

Drop to a separate terminal:

```sh
cat ~/.lobstah/ledger.jsonl | tail -1 | jq .
```

You'll see the signed receipt: `requesterPubkey` (you), `workerPubkey`
(the AWS anchor), `inputTokens`, `outputTokens`, `nonce`, `signature`.

```sh
lobstah balance
```

Your accumulated debt to each peer + total tokens metered network-wide.

### 5 · (Optional) Become a worker yourself

In a separate terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:17474
# wait for the *.trycloudflare.com URL
```

Back in openclaw chat:

```
/lobstah share on https://YOUR-TUNNEL.trycloudflare.com
```

Now your laptop is an advertised worker on the grid. Anyone running
`lobstah peers gossip-nostr` from anywhere will see you.

```
/lobstah share off
```

NIP-09 deletion sent + worker stopped. Clean exit.

## What to point at

- **npm**: <https://www.npmjs.com/org/lobstah> — 9 packages, latest
  0.0.4 (cli, router, worker, …) and 0.0.13 (openclaw-provider)
- **GitHub**: <https://github.com/marouenbg/lobstah>
- **ClawHub**: <https://clawhub.ai/plugins/@lobstah/openclaw-provider>
- **AWS anchor**: serving `llama3.1:8b` and `qwen2.5:7b` 24/7,
  systemd-managed, advertised via Nostr

## Honest framing

Things worth being upfront about:

- **First-token latency is not the value prop.** A consumer-grade Mac
  is 3-10× slower than a hyperscaler API. Lobstah is for batch /
  agentic / cargo workloads where the LLM is a worker, not a chat
  partner.
- **Cooperative trust model.** Workers are assumed not to lie about
  output. Adversarial protections (redundant execution + reputation)
  are roadmap.
- **No end-to-end encryption to the worker.** The worker has to read
  the prompt to feed it to Ollama. The TUNNEL hop is encrypted (TLS),
  the worker still sees plaintext. That's fundamental to P2P
  inference.
- **NAT traversal is not solved yet.** Workers must be reachable at
  the URL they advertise (cloudflared, Tailscale, port forward, named
  tunnel). The Nostr-relayed-traffic roadmap item would let workers
  participate without an external URL.
- **ClawHub scanner shows "suspicious" verdict** on the plugin —
  community channel default, doesn't block install. The flag is
  almost certainly the dynamic `import()` we use to lazy-load the
  openclaw plugin SDK; valid pattern, false positive on regex
  scanners.
