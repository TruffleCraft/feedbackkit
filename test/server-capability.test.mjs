import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../scripts/server-storage.mjs';
import { recordCapabilitySql } from '../scripts/record-capability.mjs';
import { codeDeliveryCapability } from '../scripts/delivery-capability.mjs';

// The statement that pnpm deploy runs against the remote D1, tried on a database
// with the same schema.
test('recording the delivery capability sets it on a fresh install and never lowers it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fk-capability-'));
  const store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  const value = () => store.sqlite.prepare("SELECT value FROM meta WHERE key='delivery_capability'").get()?.value;
  try {
    assert.equal(value(), undefined, 'a fresh database records nothing yet');
    store.sqlite.exec(recordCapabilitySql(codeDeliveryCapability()));
    assert.equal(value(), String(codeDeliveryCapability()));
    store.sqlite.exec(recordCapabilitySql(1));
    assert.equal(value(), String(codeDeliveryCapability()), 'an older release does not lower it');
    store.sqlite.exec("UPDATE meta SET value='1' WHERE key='delivery_capability'");
    store.sqlite.exec(recordCapabilitySql(2));
    assert.equal(value(), '2', 'a newer release raises it');
    assert.equal(typeof value(), 'string');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
