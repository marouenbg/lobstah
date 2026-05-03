import { describe, expect, it } from "vitest";
import { assertSafeUrl } from "./url-safety.js";

const stubResolver = (map: Record<string, string[]>) => {
  return async (hostname: string): Promise<string[]> => {
    const ips = map[hostname];
    if (!ips) throw new Error(`unknown host ${hostname}`);
    return ips;
  };
};

const ok = async (
  url: string,
  resolver?: (h: string) => Promise<string[]>,
  blockPrivateNetwork = false,
) => assertSafeUrl(url, { resolver, blockPrivateNetwork });

describe("assertSafeUrl — schemes", () => {
  it("rejects unparseable URLs", async () => {
    const r = await ok("not a url");
    expect(r.ok).toBe(false);
  });

  it("rejects file: scheme", async () => {
    const r = await ok("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scheme/);
  });

  it("rejects javascript: scheme", async () => {
    const r = await ok("javascript:alert(1)");
    expect(r.ok).toBe(false);
  });

  it("rejects ftp:", async () => {
    const r = await ok("ftp://example.com/x");
    expect(r.ok).toBe(false);
  });
});

describe("assertSafeUrl — IPv4 blocklist", () => {
  it("rejects 127.0.0.1", async () => {
    const r = await ok("http://127.0.0.1:8080/admin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/loopback/);
  });

  it("rejects 127.x.x.x", async () => {
    const r = await ok("http://127.99.99.99/");
    expect(r.ok).toBe(false);
  });

  it("rejects AWS metadata 169.254.169.254", async () => {
    const r = await ok("http://169.254.169.254/latest/meta-data/iam/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/link-local|metadata/);
  });

  it("rejects 0.0.0.0", async () => {
    const r = await ok("http://0.0.0.0/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unspecified/);
  });

  it("allows public IPv4 like 8.8.8.8", async () => {
    const r = await ok("http://8.8.8.8/");
    expect(r.ok).toBe(true);
  });

  it("allows RFC1918 by default (Tailscale-friendly)", async () => {
    const r = await ok("http://10.0.0.5:17474/");
    expect(r.ok).toBe(true);
  });

  it("rejects RFC1918 when blockPrivateNetwork is on", async () => {
    const r = await assertSafeUrl("http://10.0.0.5:17474/", { blockPrivateNetwork: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/RFC1918|private/);
  });

  it("rejects 100.64.x (CGNAT) when blockPrivateNetwork is on", async () => {
    const r = await assertSafeUrl("http://100.64.0.1/", { blockPrivateNetwork: true });
    expect(r.ok).toBe(false);
  });
});

describe("assertSafeUrl — IPv6 blocklist", () => {
  it("rejects ::1", async () => {
    const r = await ok("http://[::1]:8080/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/loopback/);
  });

  it("rejects link-local fe80::", async () => {
    const r = await ok("http://[fe80::1]:8080/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/link-local/);
  });

  it("rejects IPv4-mapped IPv6 loopback ::ffff:127.0.0.1", async () => {
    const r = await ok("http://[::ffff:127.0.0.1]/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/loopback|IPv4-mapped/);
  });

  it("allows public IPv6", async () => {
    const r = await ok("http://[2001:4860:4860::8888]/");
    expect(r.ok).toBe(true);
  });

  it("rejects ULA fc00::/7 when blockPrivateNetwork is on", async () => {
    const r = await assertSafeUrl("http://[fd00::1]/", { blockPrivateNetwork: true });
    expect(r.ok).toBe(false);
  });
});

describe("assertSafeUrl — hostname resolution", () => {
  it("rejects when DNS lookup fails", async () => {
    const r = await ok("http://nonexistent.example/", stubResolver({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/DNS lookup failed/);
  });

  it("rejects when ANY resolved address is blocked", async () => {
    const r = await ok(
      "http://multi.example/",
      stubResolver({ "multi.example": ["8.8.8.8", "127.0.0.1"] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/127\.0\.0\.1/);
  });

  it("accepts when all resolved addresses are public", async () => {
    const r = await ok(
      "http://safe.example/",
      stubResolver({ "safe.example": ["8.8.8.8", "1.1.1.1"] }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects DNS rebinding attempt where a public hostname resolves to loopback", async () => {
    const r = await ok(
      "http://attacker.example/",
      stubResolver({ "attacker.example": ["127.0.0.1"] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/loopback/);
  });
});
