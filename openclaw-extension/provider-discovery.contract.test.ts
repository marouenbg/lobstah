import { beforeEach, describe, expect, it, vi } from "vitest";

// `openclaw/plugin-sdk/plugin-entry` is a virtual module resolved by the
// openclaw runtime at plugin install time — it doesn't exist on disk
// for vitest to load. We stub its surface so `import("./index.js")`
// works in this contract test.
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: <T,>(entry: T): T => entry,
}));

type OpenClawPluginApi = {
  registerProvider: (provider: unknown) => void;
  registerCommand: (cmd: unknown) => void;
  registerControlUiDescriptor: (desc: unknown) => void;
};

const buildLobstahProviderMock = vi.hoisted(() => vi.fn());
type DiscoverOpenAICompatibleSelfHostedProviderParams = {
  buildProvider: (args: { apiKey?: string }) => Promise<Record<string, unknown>>;
  ctx: {
    resolveProviderApiKey: () => {
      apiKey?: string;
    };
    resolveProviderAuth: () => {
      discoveryApiKey?: string;
    };
  };
  providerId: string;
};
const discoverOpenAICompatibleSelfHostedProviderMock = vi.hoisted(() =>
  vi.fn(async (params: DiscoverOpenAICompatibleSelfHostedProviderParams) => ({
    provider: {
      ...(await params.buildProvider({
        apiKey: params.ctx.resolveProviderAuth().discoveryApiKey,
      })),
      apiKey: params.ctx.resolveProviderApiKey().apiKey,
    },
  })),
);

vi.mock("./api.js", () => ({
  LOBSTAH_DEFAULT_API_KEY_ENV_VAR: "LOBSTAH_ROUTER_URL",
  LOBSTAH_DEFAULT_BASE_URL: "http://127.0.0.1:17475/v1",
  LOBSTAH_DEFAULT_NOSTR_RELAYS: ["wss://relay.test"],
  LOBSTAH_DEFAULT_WORKER_PORT: 17474,
  LOBSTAH_MODEL_PLACEHOLDER: "llama3.1:8b",
  LOBSTAH_PROVIDER_LABEL: "Lobstah",
  buildLobstahProvider: (...args: unknown[]) => buildLobstahProviderMock(...args),
}));

// The embedded router (and its Nostr gossip) does real network/IO work.
// Stubbing it here keeps this contract test focused on the plugin
// surface — the embedded-router behavior is covered separately.
vi.mock("./embedded-router.js", () => ({
  ensureEmbeddedRouter: vi.fn(async () => ({
    url: "http://127.0.0.1:17475",
    source: "embedded" as const,
  })),
  gossipFromNostrInBackground: vi.fn(async () => ({
    acceptedCount: 0,
    addedCount: 0,
    errored: false,
    skipped: true,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-setup", () => ({
  discoverOpenAICompatibleSelfHostedProvider: (
    params: DiscoverOpenAICompatibleSelfHostedProviderParams,
  ) => discoverOpenAICompatibleSelfHostedProviderMock(params),
}));

type ProviderDiscoveryRun = (ctx: {
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: () => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: () => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
  };
}) => Promise<unknown>;

type RegisteredLobstahProvider = {
  id: string;
  discovery?: {
    order?: string;
    run: ProviderDiscoveryRun;
  };
};

describe("lobstah provider discovery contract", () => {
  beforeEach(() => {
    buildLobstahProviderMock.mockReset();
    discoverOpenAICompatibleSelfHostedProviderMock.mockClear();
  });

  it("keeps self-hosted discovery provider-owned", async () => {
    const { default: plugin } = await import("./index.js");
    let provider: RegisteredLobstahProvider | undefined;
    plugin.register({
      registerProvider: (registeredProvider) => {
        provider = registeredProvider as RegisteredLobstahProvider;
      },
      // 0.0.11+ also calls these — stub them out for the contract test
      // so register() doesn't throw before reaching registerProvider.
      registerCommand: () => undefined,
      registerControlUiDescriptor: () => undefined,
    } as OpenClawPluginApi);
    expect(provider?.id).toBe("lobstah");
    expect(provider?.discovery?.order).toBe("late");
    const discovery = provider?.discovery;
    expect(discovery).toBeDefined();

    buildLobstahProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:17475/v1",
      api: "openai-completions",
      models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B" }],
    });

    await expect(
      discovery!.run({
        config: {},
        env: {
          LOBSTAH_ROUTER_URL: "env-lobstah-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({
          apiKey: "LOBSTAH_ROUTER_URL",
          discoveryApiKey: "env-lobstah-key",
        }),
        resolveProviderAuth: () => ({
          apiKey: "LOBSTAH_ROUTER_URL",
          discoveryApiKey: "env-lobstah-key",
          mode: "api_key",
          source: "env",
        }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "http://127.0.0.1:17475/v1",
        api: "openai-completions",
        apiKey: "LOBSTAH_ROUTER_URL",
        models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B" }],
      },
    });
    expect(buildLobstahProviderMock).toHaveBeenCalledWith({
      apiKey: "env-lobstah-key",
    });
    expect(discoverOpenAICompatibleSelfHostedProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "lobstah",
        buildProvider: expect.any(Function),
      }),
    );
  });
});
