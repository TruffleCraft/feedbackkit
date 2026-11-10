/**
 * The environment the application sees. The application resolves the secret
 * names in a project's settings against it, so it must not receive the whole
 * process environment (cloud credentials, paths, FK_DATA_DIR) as well.
 */
const ALLOWED = /^(ADMIN_TOKEN|LLM_API_KEY|FK_RELEASE|(GITHUB_PAT|TURNSTILE_SECRET)_[A-Za-z0-9_]+)$/;

export function appEnvironment(processEnv) {
  return Object.fromEntries(Object.entries(processEnv).filter(([name, value]) => ALLOWED.test(name) && value !== undefined));
}
