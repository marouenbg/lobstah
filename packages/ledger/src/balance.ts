import {
  BOOTSTRAP_ALLOWANCE_TOKENS,
  type SignedReceipt,
  totalTokens,
  verifyReceipt,
} from "@lobstah/protocol";

export type Balance = {
  pubkey: string;
  earned: number;
  spent: number;
  /** earned - spent. Can go negative when spend > earn. */
  net: number;
  /** Bootstrap allowance for this account. Per-pubkey constant. */
  allowance: number;
  /**
   * Available credit = allowance + net. The amount this account can
   * still spend on compute before workers refuse service. 0 means
   * "exactly at the floor" (no further compute possible until the
   * account earns more by serving).
   */
  available: number;
};

export type BalanceTotals = {
  earned: number;
  spent: number;
  receipts: number;
};

export type BalanceSummary = {
  perPeer: Map<string, Balance>;
  totals: BalanceTotals;
};

const ensure = (m: Map<string, Balance>, pk: string): Balance => {
  let b = m.get(pk);
  if (!b) {
    b = {
      pubkey: pk,
      earned: 0,
      spent: 0,
      net: 0,
      allowance: BOOTSTRAP_ALLOWANCE_TOKENS,
      available: BOOTSTRAP_ALLOWANCE_TOKENS,
    };
    m.set(pk, b);
  }
  return b;
};

export const computeBalances = (signedReceipts: SignedReceipt[]): BalanceSummary => {
  const perPeer = new Map<string, Balance>();
  const totals: BalanceTotals = { earned: 0, spent: 0, receipts: 0 };
  for (const s of signedReceipts) {
    if (!verifyReceipt(s)) continue;
    const t = totalTokens(s.receipt);
    const worker = ensure(perPeer, s.receipt.workerPubkey);
    const requester = ensure(perPeer, s.receipt.requesterPubkey);
    worker.earned += t;
    worker.net += t;
    worker.available = worker.allowance + worker.net;
    requester.spent += t;
    requester.net -= t;
    requester.available = requester.allowance + requester.net;
    totals.earned += t;
    totals.spent += t;
    totals.receipts += 1;
  }
  return { perPeer, totals };
};

/**
 * Quick lookup: how many tokens does this pubkey have left to spend?
 * Returns the bootstrap allowance for accounts not yet seen in the
 * ledger (effectively "new account default"). Used by workers to
 * decide whether to serve a request before doing the work.
 */
export const availableCredits = (
  pubkey: string,
  signedReceipts: ReadonlyArray<SignedReceipt>,
): number => {
  let net = 0;
  for (const s of signedReceipts) {
    if (!verifyReceipt(s)) continue;
    const t = totalTokens(s.receipt);
    if (s.receipt.workerPubkey === pubkey) net += t;
    if (s.receipt.requesterPubkey === pubkey) net -= t;
  }
  return BOOTSTRAP_ALLOWANCE_TOKENS + net;
};
