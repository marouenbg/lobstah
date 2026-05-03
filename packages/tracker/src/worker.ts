// Cloudflare Workers deployment of the lobstah tracker.
//
// Uses Workers KV (free tier) for storage. Each peer is stored under
// `peer:<pubkey>` with KV's expirationTtl matching the announcement's
// ttlSeconds, so dead peers fall off automatically without a sweeper job.
//
// Deploy:
//   wrangler login
//   wrangler kv:namespace create REGISTRY
//   # paste the returned id into wrangler.toml under [[kv_namespaces]].id
//   wrangler deploy
//
// Anyone can run their own. The default canonical tracker (if/when one
// exists) is the operator's own deploy.

import {
  type SignedAnnouncement,
  announcementStatus,
  fromHex,
  parsePubkey,
  verify,
  verifyAnnouncement,
} from "@lobstah/protocol";

type Env = {
  REGISTRY: KVNamespace;
};

const KV_PREFIX = "peer:";
const MAX_TTL_SECONDS = 600;
const KV_MIN_TTL_SECONDS = 60; // Cloudflare KV minimum
const enc = new TextEncoder();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const text = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

const handleRoot = async (env: Env): Promise<Response> => {
  const { keys } = await env.REGISTRY.list({ prefix: KV_PREFIX });
  return text(`lobstah-tracker (live peers: ${keys.length})\n`);
};

const handlePeers = async (env: Env): Promise<Response> => {
  const { keys } = await env.REGISTRY.list({ prefix: KV_PREFIX });
  const peers: SignedAnnouncement[] = [];
  for (const k of keys) {
    const value = await env.REGISTRY.get(k.name);
    if (!value) continue;
    try {
      const signed = JSON.parse(value) as SignedAnnouncement;
      if (announcementStatus(signed.announcement) !== "ok") continue;
      peers.push(signed);
    } catch {
      // skip malformed
    }
  }
  return json({ version: 1, count: peers.length, peers });
};

const handleAnnounce = async (req: Request, env: Env): Promise<Response> => {
  let body: SignedAnnouncement;
  try {
    body = (await req.json()) as SignedAnnouncement;
  } catch {
    return json({ error: { type: "bad_json" } }, 400);
  }
  if (!verifyAnnouncement(body)) {
    return json({ error: { type: "rejected", reason: "bad-signature" } }, 400);
  }
  const status = announcementStatus(body.announcement);
  if (status !== "ok") {
    return json({ error: { type: "rejected", reason: status } }, 400);
  }
  const ttl = Math.min(
    Math.max(body.announcement.ttlSeconds, KV_MIN_TTL_SECONDS),
    MAX_TTL_SECONDS,
  );
  await env.REGISTRY.put(`${KV_PREFIX}${body.announcement.pubkey}`, JSON.stringify(body), {
    expirationTtl: ttl,
  });
  return json({
    ok: true,
    pubkey: body.announcement.pubkey,
    ttlSeconds: ttl,
  });
};

const handleUnannounce = async (req: Request, env: Env): Promise<Response> => {
  let body: { pubkey: string; timestamp: number; signature: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: { type: "bad_json" } }, 400);
  }
  if (Math.abs(Date.now() - body.timestamp) > 5 * 60 * 1000) {
    return json({ error: { type: "rejected", reason: "stale" } }, 400);
  }
  try {
    const pk = parsePubkey(body.pubkey);
    const msg = enc.encode(`unannounce:${body.pubkey}:${body.timestamp}`);
    if (!verify(fromHex(body.signature), msg, pk)) {
      return json({ error: { type: "rejected", reason: "bad-signature" } }, 400);
    }
  } catch {
    return json({ error: { type: "rejected", reason: "bad-signature" } }, 400);
  }
  await env.REGISTRY.delete(`${KV_PREFIX}${body.pubkey}`);
  return json({ ok: true });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (request.method === "GET" && path === "/") return handleRoot(env);
    if (request.method === "GET" && path === "/peers") return handlePeers(env);
    if (request.method === "POST" && path === "/announce")
      return handleAnnounce(request, env);
    if (request.method === "POST" && path === "/unannounce")
      return handleUnannounce(request, env);

    return json({ error: { type: "not_found", path } }, 404);
  },
};
