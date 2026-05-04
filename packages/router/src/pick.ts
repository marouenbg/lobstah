import { DEFAULT_WORKER_TIER, type WorkerTier } from "@lobstah/protocol";
import { getCapacity, isHealthy } from "./peer-state.js";
import type { Peer } from "./peers.js";

let cursor = 0;

export const pickPeer = (peers: Peer[]): Peer | undefined => {
  if (peers.length === 0) return undefined;
  const peer = peers[cursor % peers.length];
  cursor += 1;
  return peer;
};

export const candidatesForModel = async (
  peers: Peer[],
  model: string,
): Promise<Peer[]> => {
  const out: Peer[] = [];
  for (const peer of peers) {
    if (!isHealthy(peer.pubkey)) continue;
    const cap = await getCapacity(peer);
    if (cap && cap.models.includes(model)) {
      out.push(peer);
    }
  }
  return out;
};

export const orderCandidates = (candidates: Peer[]): Peer[] => {
  if (candidates.length <= 1) return candidates;
  const offset = cursor % candidates.length;
  cursor += 1;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)];
};

// Bias selection toward a preferred tier without ever refusing to serve
// when no tier-matched peer exists. Matched peers come first (in their
// existing rotation order), unmatched peers second. Workers that don't
// advertise a tier are treated as `DEFAULT_WORKER_TIER` ("best-effort").
//
// The fallback matters: a router that strictly enforced "interactive
// only" would refuse a chat completion just because every reachable peer
// labelled itself "batch" — defeating the point of having peers at all.
export const preferTier = async (
  candidates: Peer[],
  preferred: WorkerTier,
): Promise<Peer[]> => {
  if (candidates.length <= 1) return candidates;
  const matched: Peer[] = [];
  const other: Peer[] = [];
  for (const peer of candidates) {
    const cap = await getCapacity(peer);
    const tier = cap?.tier ?? DEFAULT_WORKER_TIER;
    (tier === preferred ? matched : other).push(peer);
  }
  return [...matched, ...other];
};

export const resetCursor = (): void => {
  cursor = 0;
};
