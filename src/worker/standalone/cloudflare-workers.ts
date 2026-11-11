// Stand-in for the workerd module "cloudflare:workers" on the standalone server.
// scripts/build-server.mjs and scripts/build-bundle.mjs alias the import to this
// file. @cloudflare/workers-oauth-provider imports WorkerEntrypoint only to tell a
// handler class from a handler object (the gateway passes objects), so an empty
// base class is all it needs.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

// On start the provider logs how to turn on Client ID Metadata Documents with a
// wrangler compatibility flag. The standalone server keeps them off on purpose
// (see oauth/provider.ts), so that advice is wrong here: drop exactly that line.
// This module is evaluated before the provider's own, so the filter is in place
// when the line would be printed.
const CIMD_ADVICE = "CIMD (Client ID Metadata Document) is disabled:";
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith(CIMD_ADVICE)) return;
  warn(...args);
};
