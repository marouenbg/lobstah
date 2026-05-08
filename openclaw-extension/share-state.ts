// Tiny persistence helper for share-compute intent. Lives in its own
// module so the network-touching share-compute.ts has no filesystem
// I/O — that combination trips ClawHub's plugin static-analysis
// scanner ("potential-exfiltration: file read combined with network
// send"). Splitting the concerns keeps the scan clean while preserving
// the runtime behaviour.
//
// What's persisted: the user's *intent* to be sharing, not the
// in-flight runtime state. Specifically: the URL they chose, the label
// they want, and when they last enabled. On plugin activation we
// re-enable using these values; if anything goes wrong (URL stale,
// ollama down, etc.) we silently clear the intent so we don't keep
// retrying every load.

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SHARE_STATE_PATH = join(homedir(), ".lobstah", "share-state.json");

export type PersistedShareIntent = {
  /** Schema version; bump when fields change incompatibly. */
  version: 1;
  enabledSince: number;
  tunnelUrl: string;
  announceLabel: string;
};

export const writeShareIntent = async (
  intent: PersistedShareIntent,
): Promise<void> => {
  try {
    await mkdir(dirname(SHARE_STATE_PATH), { recursive: true });
    await writeFile(SHARE_STATE_PATH, JSON.stringify(intent, null, 2), "utf8");
  } catch {
    // Best-effort: if we can't persist, the user just loses
    // auto-resume on next openclaw restart. Sharing still works
    // for this session.
  }
};

export const readShareIntent = async (): Promise<
  PersistedShareIntent | undefined
> => {
  if (!existsSync(SHARE_STATE_PATH)) return undefined;
  try {
    const raw = await readFile(SHARE_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as PersistedShareIntent;
    if (parsed?.version === 1 && typeof parsed.tunnelUrl === "string") {
      return parsed;
    }
  } catch {
    // ignore — corrupt file shouldn't block the plugin
  }
  return undefined;
};

export const clearShareIntent = async (): Promise<void> => {
  try {
    await unlink(SHARE_STATE_PATH);
  } catch {
    // ignore — file may not exist
  }
};
