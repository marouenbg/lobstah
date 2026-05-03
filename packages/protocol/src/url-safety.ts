import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Defense against SSRF when fetching peer-controlled URLs:
// - Reject non-http(s) schemes.
// - Resolve the hostname and check every returned address against a blocklist.
// - Default blocklist covers loopback, link-local (incl. AWS/GCP/Azure metadata
//   service 169.254.169.254), and unspecified addresses.
// - RFC1918 private + ULA + Tailscale CGNAT are allowed by default because
//   lobstah is designed to run across overlay networks; opt-in
//   `blockPrivateNetwork` adds them to the blocklist for stricter setups.
//
// Callers MUST re-check at fetch time, not just at config time, because a
// hostname can resolve to a different IP later (DNS rebinding).

export type UrlSafetyOptions = {
  blockPrivateNetwork?: boolean;
  resolver?: (hostname: string) => Promise<string[]>;
};

export type UrlSafetyResult = { ok: true } | { ok: false; reason: string };

const ALWAYS_BLOCKED_V4_CIDRS: ReadonlyArray<readonly [string, string]> = [
  ["127.0.0.0", "8"],
  ["169.254.0.0", "16"],
  ["0.0.0.0", "8"],
];

const PRIVATE_BLOCKED_V4_CIDRS: ReadonlyArray<readonly [string, string]> = [
  ["10.0.0.0", "8"],
  ["172.16.0.0", "12"],
  ["192.168.0.0", "16"],
  ["100.64.0.0", "10"],
];

const v4ToInt = (ip: string): number =>
  ip.split(".").reduce((acc, b) => (acc * 256 + Number(b)) >>> 0, 0) >>> 0;

const ipv4InCidr = (ip: string, base: string, prefix: string): boolean => {
  const p = Number(prefix);
  if (p === 0) return true;
  const mask = (0xffffffff << (32 - p)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};

const checkIpv4 = (
  ip: string,
  blockPrivateNetwork: boolean,
): { blocked: false } | { blocked: true; cidr: string; category: string } => {
  for (const [base, prefix] of ALWAYS_BLOCKED_V4_CIDRS) {
    if (ipv4InCidr(ip, base, prefix)) {
      const category =
        base === "127.0.0.0"
          ? "loopback"
          : base === "169.254.0.0"
            ? "link-local / cloud metadata"
            : "unspecified";
      return { blocked: true, cidr: `${base}/${prefix}`, category };
    }
  }
  if (blockPrivateNetwork) {
    for (const [base, prefix] of PRIVATE_BLOCKED_V4_CIDRS) {
      if (ipv4InCidr(ip, base, prefix)) {
        return {
          blocked: true,
          cidr: `${base}/${prefix}`,
          category: base === "100.64.0.0" ? "CGNAT (Tailscale)" : "RFC1918 private",
        };
      }
    }
  }
  return { blocked: false };
};

const checkIpv6 = (
  ip: string,
  blockPrivateNetwork: boolean,
): { blocked: false } | { blocked: true; cidr: string; category: string } => {
  const lower = ip.toLowerCase();
  if (lower === "::1") return { blocked: true, cidr: "::1", category: "loopback" };
  if (lower === "::" || lower === "::0")
    return { blocked: true, cidr: "::", category: "unspecified" };
  // link-local fe80::/10 covers fe80..febf
  if (/^fe[89ab][0-9a-f]?:/.test(lower))
    return { blocked: true, cidr: "fe80::/10", category: "link-local" };
  // IPv4-mapped IPv6: accept both dotted (::ffff:127.0.0.1) and the hex form
  // that URL parsing typically normalizes to (::ffff:7f00:1).
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    let v4: string | null = null;
    if (tail.includes(".") && isIP(tail) === 4) {
      v4 = tail;
    } else {
      const parts = tail.split(":");
      const p0 = parts[0];
      const p1 = parts[1];
      if (parts.length === 2 && p0 !== undefined && p1 !== undefined) {
        const hi = Number.parseInt(p0, 16);
        const lo = Number.parseInt(p1, 16);
        if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
          const candidate = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          if (isIP(candidate) === 4) v4 = candidate;
        }
      }
    }
    if (v4) {
      const inner = checkIpv4(v4, blockPrivateNetwork);
      if (inner.blocked) {
        return {
          blocked: true,
          cidr: `::ffff:${inner.cidr}`,
          category: `${inner.category} (IPv4-mapped)`,
        };
      }
    }
  }
  if (blockPrivateNetwork) {
    // ULA fc00::/7 — fc.. or fd..
    if (/^f[cd][0-9a-f]{2}:/.test(lower))
      return { blocked: true, cidr: "fc00::/7", category: "ULA private" };
  }
  return { blocked: false };
};

const checkAddress = (
  ip: string,
  blockPrivateNetwork: boolean,
): { blocked: false } | { blocked: true; cidr: string; category: string } => {
  const family = isIP(ip);
  if (family === 4) return checkIpv4(ip, blockPrivateNetwork);
  if (family === 6) return checkIpv6(ip, blockPrivateNetwork);
  return { blocked: false };
};

const defaultResolver = async (hostname: string): Promise<string[]> => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export const assertSafeUrl = async (
  url: string,
  opts: UrlSafetyOptions = {},
): Promise<UrlSafetyResult> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `unparseable URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `disallowed scheme ${parsed.protocol} (only http/https allowed)` };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname.length === 0) {
    return { ok: false, reason: "URL has no hostname" };
  }

  const blockPrivateNetwork = opts.blockPrivateNetwork ?? false;

  let ips: string[];
  if (isIP(hostname)) {
    ips = [hostname];
  } else {
    try {
      const resolver = opts.resolver ?? defaultResolver;
      ips = await resolver(hostname);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `DNS lookup failed for ${hostname}: ${msg}` };
    }
  }
  if (ips.length === 0) {
    return { ok: false, reason: `no addresses returned for ${hostname}` };
  }

  for (const ip of ips) {
    const result = checkAddress(ip, blockPrivateNetwork);
    if (result.blocked) {
      return {
        ok: false,
        reason: `${hostname} resolves to ${ip} which is in ${result.cidr} (${result.category})`,
      };
    }
  }
  return { ok: true };
};
