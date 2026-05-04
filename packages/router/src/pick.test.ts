import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markFailed, MAX_CONSECUTIVE_FAILURES, resetPeerState } from "./peer-state.js";
import type { Peer } from "./peers.js";
import { candidatesForModel, orderCandidates, preferTier, resetCursor } from "./pick.js";

const peer = (suffix: string, label?: string): Peer => ({
  pubkey: `lob1${suffix.padStart(64, "0")}`.slice(0, 68),
  // Use a literal IP from RFC5737 TEST-NET-1 so assertSafeUrl skips DNS lookup.
  url: `http://192.0.2.1/${suffix}`,
  label,
});

const capFor = (models: string[]) =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ pubkey: "lob1x", models, queueDepth: 0 }),
  } as unknown as Response);

describe("candidatesForModel", () => {
  beforeEach(() => {
    resetPeerState();
    resetCursor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes only peers whose capacity reports the model", async () => {
    const a = peer("a");
    const b = peer("b");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: ["llama3.1:8b"] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: ["qwen2.5:7b"] }) });
    vi.stubGlobal("fetch", fetchMock);
    const out = await candidatesForModel([a, b], "llama3.1:8b");
    expect(out).toEqual([a]);
  });

  it("excludes unhealthy peers without re-fetching capacity", async () => {
    const a = peer("a");
    const b = peer("b");
    const fetchMock = capFor(["llama3.1:8b"]);
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) markFailed(a.pubkey);
    const out = await candidatesForModel([a, b], "llama3.1:8b");
    expect(out).toEqual([b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty when no peer has the model", async () => {
    const a = peer("a");
    vi.stubGlobal("fetch", capFor(["something-else"]));
    const out = await candidatesForModel([a], "llama3.1:8b");
    expect(out).toEqual([]);
  });
});

describe("orderCandidates", () => {
  beforeEach(() => {
    resetCursor();
  });

  it("returns candidates unchanged when 0 or 1", () => {
    expect(orderCandidates([])).toEqual([]);
    const a = peer("a");
    expect(orderCandidates([a])).toEqual([a]);
  });

  it("rotates start position across calls (round-robin)", () => {
    const a = peer("a");
    const b = peer("b");
    const c = peer("c");
    const list = [a, b, c];
    const r0 = orderCandidates(list);
    const r1 = orderCandidates(list);
    const r2 = orderCandidates(list);
    expect(r0[0]).toBe(a);
    expect(r1[0]).toBe(b);
    expect(r2[0]).toBe(c);
  });

  it("preserves the candidate set (just rotates)", () => {
    const list = [peer("a"), peer("b"), peer("c")];
    const sorted = (xs: Peer[]) => [...xs].sort((x, y) => x.pubkey.localeCompare(y.pubkey));
    expect(sorted(orderCandidates(list))).toEqual(sorted(list));
  });
});

describe("preferTier", () => {
  beforeEach(() => {
    resetPeerState();
    resetCursor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Each call to peer-state.getCapacity() runs assertSafeUrl + a /capacity
  // fetch. We mock fetch to return a per-peer tier so we can drive
  // preferTier deterministically.
  const stubCapacityByPubkey = (
    map: Record<string, { models: string[]; tier?: string }>,
  ): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        // peer URLs are http://192.0.2.1/<suffix>; the suffix matches the
        // last 64 chars of pubkey (zero-padded). Resolve by suffix.
        const suffix = new URL(input).pathname.split("/").filter(Boolean)[0];
        const entry = Object.entries(map).find(([pk]) => pk.endsWith(suffix));
        if (!entry) throw new Error(`no stub for ${input}`);
        const [pubkey, body] = entry;
        return {
          ok: true,
          json: async () => ({ pubkey, queueDepth: 0, ...body }),
        } as unknown as Response;
      }),
    );
  };

  it("returns input unchanged when 0 or 1 candidates", async () => {
    expect(await preferTier([], "interactive")).toEqual([]);
    const a = peer("a");
    expect(await preferTier([a], "interactive")).toEqual([a]);
  });

  it("puts tier-matched peers first, others second", async () => {
    const a = peer("a");
    const b = peer("b");
    const c = peer("c");
    stubCapacityByPubkey({
      [a.pubkey]: { models: ["m"], tier: "batch" },
      [b.pubkey]: { models: ["m"], tier: "interactive" },
      [c.pubkey]: { models: ["m"], tier: "batch" },
    });
    const out = await preferTier([a, b, c], "interactive");
    expect(out[0]).toBe(b);
    expect(new Set(out)).toEqual(new Set([a, b, c]));
  });

  it("falls through to all candidates when no peer matches", async () => {
    const a = peer("a");
    const b = peer("b");
    stubCapacityByPubkey({
      [a.pubkey]: { models: ["m"], tier: "batch" },
      [b.pubkey]: { models: ["m"], tier: "best-effort" },
    });
    const out = await preferTier([a, b], "interactive");
    // No interactive peer → returns the original set, no peer dropped.
    expect(new Set(out)).toEqual(new Set([a, b]));
    expect(out.length).toBe(2);
  });

  it("treats missing tier as best-effort", async () => {
    const a = peer("a");
    const b = peer("b");
    stubCapacityByPubkey({
      [a.pubkey]: { models: ["m"] }, // no tier field
      [b.pubkey]: { models: ["m"], tier: "interactive" },
    });
    // Asking for best-effort should match the untiered peer first.
    const out = await preferTier([a, b], "best-effort");
    expect(out[0]).toBe(a);
  });
});
