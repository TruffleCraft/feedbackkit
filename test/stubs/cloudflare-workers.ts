// Stand-in for the workerd built-in module "cloudflare:workers" under Node
// (vitest). workers-oauth-provider imports WorkerEntrypoint only to tell class
// handlers from object handlers; the gateway passes objects.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
