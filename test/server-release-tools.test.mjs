import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildBundle } from '../scripts/build-bundle.mjs';
import { differences } from '../scripts/compare-bundles.mjs';

const root = new URL('..', import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), 'fk-tools-'));

test('sign-release.sh signs with the key from the environment and the signature verifies', () => {
  const dir = tmp();
  try {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')]);
    writeFileSync(join(dir, 'SHA256SUMS'), 'abc  feedbackkit-v1.0.0.tar.gz\n');
    const env = { PATH: process.env.PATH, FK_RELEASE_SIGNING_KEY: readFileSync(join(dir, 'key'), 'utf8') };
    const run = spawnSync('sh', [join(root, 'scripts/sign-release.sh'), join(dir, 'SHA256SUMS')], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(dir, 'SHA256SUMS.sig')));
    const [type, blob] = readFileSync(join(dir, 'key.pub'), 'utf8').split(' ');
    writeFileSync(join(dir, 'allowed'), `release namespaces="feedbackkit-release" ${type} ${blob}\n`);
    const verify = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', join(dir, 'allowed'), '-I', 'release', '-n', 'feedbackkit-release', '-s', join(dir, 'SHA256SUMS.sig')], { input: readFileSync(join(dir, 'SHA256SUMS')), encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
    const other = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', join(dir, 'allowed'), '-I', 'release', '-n', 'another-namespace', '-s', join(dir, 'SHA256SUMS.sig')], { input: readFileSync(join(dir, 'SHA256SUMS')), encoding: 'utf8' });
    assert.notEqual(other.status, 0, 'the namespace is part of the signature');
    // Without the key variable it refuses.
    const none = spawnSync('sh', [join(root, 'scripts/sign-release.sh'), join(dir, 'SHA256SUMS')], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /FK_RELEASE_SIGNING_KEY is not set/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gen-release-keys.sh creates both pairs, prints the next steps and refuses an existing directory', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'new');
    const run = spawnSync('sh', [join(root, 'scripts/gen-release-keys.sh'), target], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(run.status, 0, run.stderr);
    for (const f of ['stable', 'stable.pub', 'dev', 'dev.pub']) assert.ok(existsSync(join(target, f)), f);
    assert.match(run.stdout, /FK_RELEASE_SIGNING_KEY/);
    assert.match(run.stdout, /SHA256:/);
    assert.notEqual(spawnSync('sh', [join(root, 'scripts/gen-release-keys.sh'), target], { encoding: 'utf8', env: { PATH: process.env.PATH } }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the stable bundle of a commit equals its dev bundle except the files that name the release', async () => {
  const dir = tmp();
  try {
    const dev = await buildBundle({ root, outDir: join(dir, 'dev'), release: '1.2.0-dev.3', epoch: 1_800_000_000 });
    const stable = await buildBundle({ root, outDir: join(dir, 'stable'), release: '1.2.0', epoch: 1_800_000_000 });
    assert.deepEqual(differences(join(dir, 'dev', dev.name), join(dir, 'stable', stable.name)), []);
    // The same release name on a different server is caught.
    const sources = join(dir, 'src'); mkdirSync(sources);
    execFileSync('tar', ['-xzf', join(dir, 'stable', stable.name), '-C', sources]);
    writeFileSync(join(sources, 'feedbackkit-v1.2.0', 'server.mjs'), readFileSync(join(sources, 'feedbackkit-v1.2.0', 'server.mjs'), 'utf8') + '\n// changed after the tests\n');
    execFileSync('tar', ['-czf', join(dir, 'changed.tar.gz'), '-C', sources, 'feedbackkit-v1.2.0']);
    assert.deepEqual(differences(join(dir, 'dev', dev.name), join(dir, 'changed.tar.gz')), ['server.mjs']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
