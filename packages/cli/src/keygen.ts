import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  defaultIdentityPath,
  formatPubkey,
  loadOrCreateIdentity,
} from "@lobstah/protocol";
import { formatNostrNpub } from "@lobstah/transport-nostr";

export const keygen = async (args: string[]): Promise<void> => {
  const force = args.includes("--force");
  const path = defaultIdentityPath();

  if (force && existsSync(path)) {
    await unlink(path);
  }

  const { identity, created } = await loadOrCreateIdentity(path);
  const pk = formatPubkey(identity.publicKey);
  const npub = formatNostrNpub(identity.nostrPublicKey);

  process.stdout.write(`${created ? "created" : "loaded"} identity\n`);
  process.stdout.write(`  path:    ${path}\n`);
  process.stdout.write(`  lobstah: ${pk}\n`);
  process.stdout.write(`  nostr:   ${npub}\n`);
  if (created) {
    process.stdout.write("\n");
    process.stdout.write("  Two keypairs were generated:\n");
    process.stdout.write("    - lobstah (Ed25519): signs receipts and announcements (the trust key)\n");
    process.stdout.write("    - nostr (Schnorr): signs the outer envelope when publishing over Nostr relays\n");
  }
};
