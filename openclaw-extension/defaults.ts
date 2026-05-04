export const LOBSTAH_DEFAULT_BASE_URL = "http://127.0.0.1:17475/v1";
export const LOBSTAH_PROVIDER_LABEL = "Lobstah";
export const LOBSTAH_DEFAULT_API_KEY_ENV_VAR = "LOBSTAH_ROUTER_URL";
export const LOBSTAH_MODEL_PLACEHOLDER = "llama3.1:8b";

// Default Nostr relays for peer discovery. Anyone can publish a signed
// announcement; anyone can subscribe and receive the current peer set.
// Discovery is always opt-in: nothing happens unless the user explicitly
// chooses to publish (provider side) or sync (consumer side). Both prompts
// default to "no" in onboarding.
export const LOBSTAH_DEFAULT_NOSTR_RELAYS: ReadonlyArray<string> = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

// Centralized HTTP tracker fallback for environments where Nostr WebSockets
// are blocked. No canonical hosted instance — operators run their own.
export const LOBSTAH_DEFAULT_TRACKER_URL_PLACEHOLDER = "https://your-tracker.example.com";
export const LOBSTAH_DEFAULT_WORKER_PORT = 17474;
