// Ambient type stubs for the openclaw plugin SDK.
//
// These modules are not real npm packages — they're virtual paths that the
// openclaw runtime resolves from its own bundled plugin-sdk at install
// time (see openclaw/extensions/tsconfig.package-boundary.paths.json in
// the openclaw monorepo). Inside that monorepo, tsconfig `paths` maps them
// onto the SDK source. Outside it (e.g. this standalone repo), we just
// need TypeScript to stop complaining so `tsc` emits JS — the runtime
// resolution still happens correctly because openclaw's loader provides
// the bindings at execution time.
//
// We type the surface we actually consume; everything else is `any`.
// All `openclaw/plugin-sdk/*` modules are wide-open: their concrete
// surface depends on the host's plugin-sdk version. We let TypeScript
// treat every import as `any` so `tsc` emits JS; the runtime resolver in
// openclaw provides the real bindings at install time. The actual
// contract is exercised by provider-discovery.contract.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "openclaw/plugin-sdk/plugin-entry" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anything: any;
  // Named re-exports resolve through the wide-open surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const definePluginEntry: any;
  export type OpenClawPluginApi = any;
  export type ProviderAuthMethodNonInteractiveContext = any;
  export default anything;
}

declare module "openclaw/plugin-sdk/provider-setup" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anything: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const discoverOpenAICompatibleLocalModels: any;
  export default anything;
}

declare module "openclaw/plugin-sdk/config-types" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type OpenClawConfig = any;
}
