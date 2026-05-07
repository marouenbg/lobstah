import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import { LOBSTAH_DEFAULT_BASE_URL, LOBSTAH_PROVIDER_LABEL } from "./defaults.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export async function buildLobstahProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || LOBSTAH_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    apiKey: params?.apiKey,
    label: LOBSTAH_PROVIDER_LABEL,
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}

// Static catalog used by `openclaw infer model providers` and the
// pre-configured model picker. Mirrors the modelCatalog in
// openclaw.plugin.json — same models, same metadata. Stays narrow on
// purpose: we only list models we commit to keeping reachable on the
// network. `buildLobstahProvider` (live discovery) supplements this
// with whatever else peers happen to advertise at request time.
export function buildLobstahStaticProvider(): ProviderConfig {
  return {
    baseUrl: LOBSTAH_DEFAULT_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "llama3.1:8b",
        name: "Llama 3.1 8B (via lobstah grid)",
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 4096,
      },
      {
        id: "qwen2.5:7b",
        name: "Qwen 2.5 7B (via lobstah grid)",
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 4096,
      },
    ],
  };
}
