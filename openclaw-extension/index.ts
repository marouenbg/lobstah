import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildLobstahProvider,
  LOBSTAH_DEFAULT_API_KEY_ENV_VAR,
  LOBSTAH_DEFAULT_BASE_URL,
  LOBSTAH_DEFAULT_NOSTR_RELAYS,
  LOBSTAH_DEFAULT_WORKER_PORT,
  LOBSTAH_MODEL_PLACEHOLDER,
  LOBSTAH_PROVIDER_LABEL,
} from "./api.js";

const PROVIDER_ID = "lobstah";

// The plugin-sdk surface is intentionally typed wide — the real bindings
// are wired up by the openclaw runtime at install time, not at compile
// time. See openclaw-shims.d.ts for the rationale.
async function loadProviderSetup(): Promise<Record<string, unknown> & {
  promptAndConfigureOpenAICompatibleSelfHostedProviderAuth?: (...args: unknown[]) => unknown;
  configureOpenAICompatibleSelfHostedProviderNonInteractive?: (...args: unknown[]) => unknown;
  discoverOpenAICompatibleSelfHostedProvider?: (...args: unknown[]) => unknown;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import("openclaw/plugin-sdk/provider-setup")) as any;
}

const INTRO_NOTE = [
  "Lobstah is a peer-to-peer compute grid.",
  "",
  "By default your machine stays invisible — nothing is published to any",
  "Nostr relay and you don't pull any peers from the network. We'll first",
  "connect openclaw to your local lobstah-router, then ask separately about",
  "(1) discovering compute providers via Nostr, and (2) advertising your",
  "machine via Nostr. Both default to no.",
].join("\n");

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Lobstah Provider",
  description:
    "Distributed P2P LLM inference grid for Apple Mac mini. Routes requests to peer workers via signed-receipt federated ledger.",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: LOBSTAH_PROVIDER_LABEL,
      docsPath: "/providers/lobstah",
      envVars: [LOBSTAH_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        {
          id: "custom",
          label: LOBSTAH_PROVIDER_LABEL,
          hint: "Federated P2P inference across Mac mini workers",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();

            await ctx.prompter.note(INTRO_NOTE, "Lobstah grid");

            const result = await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: LOBSTAH_PROVIDER_LABEL,
              defaultBaseUrl: LOBSTAH_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: LOBSTAH_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: LOBSTAH_MODEL_PLACEHOLDER,
            });

            // Opt-in: discover compute providers via Nostr.
            const wantsSync = await ctx.prompter.confirm({
              message: "Discover compute providers via the Nostr relay network?",
              initialValue: false,
            });
            if (wantsSync) {
              await ctx.prompter.confirm({
                message: `Use the default relays (${LOBSTAH_DEFAULT_NOSTR_RELAYS.join(", ")})?`,
                initialValue: true,
              });
              await ctx.prompter.note(
                [
                  "To pull the current peer list (and any time after), run:",
                  "",
                  "  lobstah peers gossip-nostr",
                  "",
                  "Add `--nostr-relay wss://your-preferred-relay` to use other relays.",
                  "",
                  "This is opt-in and revocable: peers expire from your local cache",
                  "when their TTL ends, and you can `lobstah peers remove <pubkey>`",
                  "any time. Subscribing reveals nothing about your identity to relays.",
                ].join("\n"),
                "Discover via Nostr",
              );
            }

            // Opt-in: advertise this machine via Nostr.
            const wantsAdvertise = await ctx.prompter.confirm({
              message: "Advertise this machine via Nostr so others can use your compute?",
              initialValue: false,
            });
            if (wantsAdvertise) {
              const advertiseUrl = await ctx.prompter.text({
                message: "Reachable URL of your worker (peers will connect here)",
                placeholder: `http://your-public-host:${LOBSTAH_DEFAULT_WORKER_PORT}`,
                validate: (v) =>
                  v.trim().length === 0 ? "URL is required" : undefined,
              });
              await ctx.prompter.confirm({
                message: `Publish to the default relays (${LOBSTAH_DEFAULT_NOSTR_RELAYS.join(", ")})?`,
                initialValue: true,
              });
              await ctx.prompter.note(
                [
                  "To start advertising, run:",
                  "",
                  "  lobstah worker start \\",
                  "      --host 0.0.0.0 \\",
                  "      --publish-via-nostr \\",
                  `      --announce-url ${advertiseUrl}`,
                  "",
                  "Add `--nostr-relay wss://your-preferred-relay` (repeatable) to publish",
                  "to additional or alternative relays.",
                  "",
                  "Stop the worker process to immediately unannounce (NIP-09 deletion).",
                  "The Nostr event also expires automatically after 5 minutes if",
                  "heartbeats stop. You can revoke at any time.",
                ].join("\n"),
                "Advertise via Nostr",
              );
            }

            return result;
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: LOBSTAH_PROVIDER_LABEL,
              defaultBaseUrl: LOBSTAH_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: LOBSTAH_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: LOBSTAH_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildLobstahProvider,
          });
        },
      },
      wizard: {
        setup: {
          choiceId: "lobstah",
          choiceLabel: "Lobstah grid",
          choiceHint: "Federated P2P inference",
          groupId: "lobstah",
          groupLabel: "Lobstah",
          groupHint: "Distributed compute grid (the lobster way)",
          methodId: "custom",
        },
        modelPicker: {
          label: "Lobstah grid",
          hint: "Point at a running lobstah-router (default http://127.0.0.1:17475/v1)",
          methodId: "custom",
        },
      },
      buildUnknownModelHint: () =>
        "Lobstah requires a running lobstah-router. " +
        "Start one with `lobstah router start` and run `openclaw configure`. " +
        "See: https://docs.openclaw.ai/providers/lobstah",
    });
  },
});
