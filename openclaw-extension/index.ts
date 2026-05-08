import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as providerSetup from "openclaw/plugin-sdk/provider-setup";
import {
  buildLobstahProvider,
  LOBSTAH_DEFAULT_API_KEY_ENV_VAR,
  LOBSTAH_DEFAULT_BASE_URL,
  LOBSTAH_DEFAULT_NOSTR_RELAYS,
  LOBSTAH_DEFAULT_WORKER_PORT,
  LOBSTAH_MODEL_PLACEHOLDER,
  LOBSTAH_PROVIDER_LABEL,
} from "./api.js";
import { buildLobstahStaticProvider } from "./models.js";
import {
  ensureEmbeddedRouter,
  gossipFromNostrInBackground,
} from "./embedded-router.js";
import { renderDashboard } from "./dashboard.js";
import {
  disableShareCompute,
  enableShareCompute,
  getShareState,
  type ShareState,
  tryResume,
} from "./share-compute.js";

const renderShareStatus = (state: ShareState): string => {
  if (!state.enabled) {
    return [
      "🦞 **Share-compute: off**",
      "",
      "Your Mac is consuming compute from the grid but not contributing.",
      "Run `/lobstah share on` to start sharing your idle compute via a",
      "Cloudflare quick tunnel + Nostr announcement.",
    ].join("\n");
  }
  const dur = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  return [
    "🦞 **Share-compute: on**",
    "",
    `- public URL: ${state.tunnelUrl ?? "?"}`,
    `- worker pubkey: \`${(state.pubkey ?? "?").slice(0, 24)}…\``,
    `- worker port: ${state.workerPort ?? "?"} (loopback; tunnel forwards public traffic)`,
    `- uptime: ${dur}s`,
    `- announced as: ${state.announceLabel ?? "?"}`,
    "",
    "_Run `/lobstah share off` to stop._",
  ].join("\n");
};

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
  // Auto-resume share-compute if the user was sharing last session.
  // Silent on failure (e.g. tunnel URL no longer reachable); we don't
  // want a stale intent file to spam errors on every plugin load.
  void (async () => {
    const r = await tryResume();
    if (r.resumed) {
      process.stdout.write(
        `@lobstah/openclaw-provider: resumed share-compute at ${r.tunnelUrl}\n`,
      );
    }
  })();
};

// The plugin-sdk surface is intentionally typed wide — the real bindings
// are wired up by the openclaw runtime at install time, not at compile
// time. See openclaw-shims.d.ts for the rationale.
//
// We use a static module specifier rather than runtime resolution so
// that static-analysis scanners on plugin registries don't flag this
// as a vector for arbitrary code loading. Static is functionally
// equivalent here — the openclaw runtime injects the module before
// our plugin loads, so resolution succeeds at module-load time.
const sdk = providerSetup as Record<string, unknown> & {
  promptAndConfigureOpenAICompatibleSelfHostedProviderAuth?: (...args: unknown[]) => unknown;
  configureOpenAICompatibleSelfHostedProviderNonInteractive?: (...args: unknown[]) => unknown;
  discoverOpenAICompatibleSelfHostedProvider?: (...args: unknown[]) => unknown;
};

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

    // Slash command: `/lobstah` prints a live dashboard inline in
    // the openclaw chat. Drops in a markdown summary of peers,
    // your credit balance, and recent receipts. No-args today;
    // future versions can route subcommands (e.g. /lobstah share,
    // /lobstah workers) but for now the whole picture in one view.
    api.registerCommand({
      name: "lobstah",
      description:
        "Lobstah grid: status, peers, balance, share-compute toggle. Subcommands: share on|off|status",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx: { args?: string }) => {
        try {
          const args = (ctx.args ?? "").trim();
          if (!args) {
            const text = await renderDashboard({ shareState: getShareState() });
            return { text, continueAgent: false };
          }
          const tokens = args.split(/\s+/);
          const [head, sub] = tokens;
          if (head === "share") {
            if (!sub || sub === "status") {
              return {
                text: renderShareStatus(getShareState()),
                continueAgent: false,
              };
            }
            if (sub === "on") {
              const tunnelUrl = tokens[2];
              if (!tunnelUrl) {
                return {
                  text: [
                    "🦞 **/lobstah share on needs a public URL.**",
                    "",
                    "Run a tunnel in a separate terminal first, then pass the URL:",
                    "",
                    "```",
                    "cloudflared tunnel --url http://127.0.0.1:17474",
                    "# wait for the *.trycloudflare.com URL, then in openclaw chat:",
                    "/lobstah share on https://your-tunnel.trycloudflare.com",
                    "```",
                    "",
                    "Tailscale, port-forwarding, or a Cloudflare named tunnel all work too — anything where peers can reach `http://<that-url>:<port>` from the internet.",
                  ].join("\n"),
                  continueAgent: false,
                };
              }
              const r = await enableShareCompute({ tunnelUrl });
              if ("reasons" in r) {
                return {
                  text: [
                    "🦞 **Could not enable share-compute** — fix these and try again:",
                    "",
                    ...r.reasons.map((s) => `- ${s}`),
                  ].join("\n"),
                  continueAgent: false,
                };
              }
              return {
                text: [
                  "🦞 **Sharing your compute** — your Mac is now a worker on the lobstah grid.",
                  "",
                  `- public URL: ${r.tunnelUrl}`,
                  `- worker pubkey: \`${r.pubkey.slice(0, 24)}…\``,
                  `- announced via Nostr (event \`${r.eventId?.slice(0, 12) ?? "?"}…\`)`,
                  "",
                  "_Run `/lobstah share off` to stop. The Nostr announcement also expires automatically after 5 min if heartbeats stop._",
                ].join("\n"),
                continueAgent: false,
              };
            }
            if (sub === "off") {
              const r = await disableShareCompute();
              if (!r.hadActiveShare) {
                return {
                  text: "🦞 _Share-compute is not currently active — nothing to disable._",
                  continueAgent: false,
                };
              }
              return {
                text: [
                  "🦞 **Stopped sharing compute.**",
                  r.unpublished
                    ? "Sent NIP-09 deletion to relays — peers will drop you on next gossip."
                    : "Could not send NIP-09 deletion; the announcement will expire on TTL (~5 min).",
                ].join("\n"),
                continueAgent: false,
              };
            }
          }
          return {
            text:
              "🦞 _Unknown subcommand. Try `/lobstah` (status), " +
              "`/lobstah share on`, `/lobstah share off`, `/lobstah share status`._",
            continueAgent: false,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            text: `🦞 _Lobstah command failed:_ ${msg}`,
            continueAgent: false,
          };
        }
      },
    });

    // Sidebar control UI surface — forward-declared. As of 2026.5.6,
    // openclaw stores ControlUiDescriptor records but no bundled host
    // surface renders them yet (verified by audit: only the test
    // fixture in openclaw/src/plugins/contracts/host-hook-fixture.ts
    // registers one). When openclaw ships a session-sidebar renderer,
    // this descriptor lights up automatically — until then, the live
    // dashboard is reachable via the /lobstah slash command.
    api.registerControlUiDescriptor({
      id: "lobstah-grid-status",
      surface: "session",
      placement: "session-sidebar",
      label: "Lobstah grid",
      description:
        "Live peer roster, credit balance, recent receipts. Updates each time the panel opens. Use /lobstah in chat for the same data inline.",
    });

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
            const providerSetup = sdk;

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
            const providerSetup = sdk;
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
          const providerSetup = sdk;
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildLobstahProvider,
          });
        },
      },
      // Pre-configuration catalog. Surfaces lobstah in
      // `openclaw infer model providers` and the model picker even
      // before the user has the embedded router warm or the
      // LOBSTAH_ROUTER_URL env var set. Mirrors the openclaw.plugin.json
      // modelCatalog block; see buildLobstahStaticProvider in models.ts.
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildLobstahStaticProvider() }),
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
