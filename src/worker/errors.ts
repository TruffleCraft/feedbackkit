// Named error classes — no catch-all handlers (hardening baseline). Each carries
// enough context to log { what was attempted } without leaking secrets.
export class ConfigError extends Error {
  override name = "ConfigError";
}
export class BindingError extends Error {
  override name = "BindingError";
  constructor(binding: string) {
    super(`Binding ${binding} missing — check wrangler.toml / build variables`);
  }
}
export class OriginError extends Error {
  override name = "OriginError";
}
export class RateLimitError extends Error {
  override name = "RateLimitError";
}
