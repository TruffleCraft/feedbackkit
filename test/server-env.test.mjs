import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEnvironment } from '../scripts/server-env.mjs';

test('the application sees its secrets and nothing else from the process environment', () => {
  const seen = appEnvironment({
    ADMIN_TOKEN: 'a', LLM_API_KEY: 'b', GITHUB_PAT_default: 'c', GITHUB_PAT_projects: 'd', TURNSTILE_SECRET_site: 'e', FK_RELEASE: '1.0.0',
    AWS_SECRET_ACCESS_KEY: 'fictional', HOME: '/home/fictional', PATH: '/usr/bin', FK_DATA_DIR: '/var/lib/feedbackkit', FK_PUBLIC_URL: 'https://x.example',
    GITHUB_TOKEN: 'fictional', GITHUB_PAT: 'fictional', FK_OAUTH_KV_ID: 'x', OAUTH_KV: 'x', FK_ACCESS_AUD: 'x', NODE_OPTIONS: '--x', SSH_AUTH_SOCK: '/tmp/x',
  });
  assert.deepEqual(Object.keys(seen).sort(), ['ADMIN_TOKEN', 'FK_RELEASE', 'GITHUB_PAT_default', 'GITHUB_PAT_projects', 'LLM_API_KEY', 'TURNSTILE_SECRET_site']);
});
