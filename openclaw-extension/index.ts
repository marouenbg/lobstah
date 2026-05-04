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
import {
  ensureEmbeddedRouter,
  gossipFromNostrInBackground,
} from "./embedded-router.js";

const PROVIDER_ID = "lobstah";

// Resolved by the embedded router on plugin activation. Falls back to
// the static default if the router hasn't reported in yet (which only
// happens during a small startup window).
let resolvedRouterBaseUrl = LOBSTAH_DEFAULT_BASE_URL;

const getRouterBaseUrl = (): string => resolvedRouterBaseUrl;

// Boot the router (and kick off Nostr gossip) once per process. We
// don't block plugin registration on either; the openclaw runtime can
// pick up the resolved URL by the time a request fires, and worst case
// the static default is correct because the router landed on 17475.
const bootSideEffects = (): void => {
  void (async () => {
    try {
      const r = await ensureEmbeddedRouter();
      resolvedRouterBaseUrl = `${r.url}/v1`;
    } catch (e) {
      // Plugin still works if the router fails to start — openclaw
      // will surface a "no_capable_peer" or connect-refused later
      // and we keep the default URL so error messages stay sane.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`@lobstah/openclaw-provider: router boot failed: ${msg}\n`);
    }
  })();
  // Background gossip — fire-and-forget. Doesn't matter if it
  // succeeds; the user can still use any peers already in peers.json.
  void gossipFromNostrInBackground();
};

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
  "We just started a local lobstah-router in this openclaw process —",
  "no separate `lobstah router start` needed. Your machine stays",
  "invisible by default; nothing is published to any Nostr relay and",
  "you can opt into discovery + advertising in the next two prompts.",
  "Both default to no.",
].join("\n");

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Lobstah Provider",
  description:
    "Distributed P2P LLM inference grid for Apple Mac mini. Routes requests to peer workers via signed-receipt federated ledger.",
  register(api: OpenClawPluginApi) {
    // Kick off router boot + background Nostr gossip. Fire-and-forget;
    // `register` is allowed to return synchronously while the side
    // effects run in the background.
    bootSideEffects();

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
              defaultBaseUrl: getRouterBaseUrl(),
              defaultApiKeyEnvVar: LOBSTAH_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: LOBSTAH_MODEL_PLACEHOLDER,
            });

            // Discovery via Nostr now happens automatically in the
            // background when the plugin loads (see bootSideEffects).
            // We surface that as a one-line FYI rather than a confirm
            // prompt so the auth flow stays short. Users who want to
            // disable it set LOBSTAH_OPENCLAW_NO_NOSTR=1 (read inside
            // gossipFromNostrInBackground via env), or `lobstah peers
            // remove <pubkey>` afterward.
            await ctx.prompter.note(
              [
                `Discovery: pulling peer announcements from ${LOBSTAH_DEFAULT_NOSTR_RELAYS.length} default Nostr relays`,
                `(${LOBSTAH_DEFAULT_NOSTR_RELAYS.join(", ")}).`,
                "",
                "This is opt-out: peers expire from your local cache when their",
                "TTL ends, and you can `lobstah peers remove <pubkey>` at any",
                "time. Subscribing reveals nothing about your identity to relays.",
              ].join("\n"),
              "Discover via Nostr (auto)",
            );

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
                  "Advertising requires running a worker process — the consumer",
                  "side (this plugin) is already in-process, but the worker is",
                  "a separate long-running daemon that lives outside openclaw.",
                  "",
                  "  npm install -g @lobstah/cli   # one-time",
                  "  lobstah worker start \\",
                  "      --host 0.0.0.0 \\",
                  "      --publish-via-nostr \\",
                  `      --announce-url ${advertiseUrl}`,
                  "",
                  "Stop the worker process to immediately unannounce (NIP-09",
                  "deletion). The Nostr event also expires after 5 minutes if",
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
          hint: "Auto-routed via the embedded lobstah-router (defaults to 127.0.0.1:17475)",
          methodId: "custom",
        },
      },
      buildUnknownModelHint: () =>
        "Lobstah needs at least one peer worker advertising this model. " +
        "Try `lobstah peers gossip-nostr` to refresh the peer list, or " +
        "`lobstah peers add <pubkey> <url>` to add a known worker manually. " +
        "See: https://docs.openclaw.ai/providers/lobstah",
    });
  },
});
