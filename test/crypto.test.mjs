import { test } from 'node:test';
import assert from 'node:assert/strict';
import { split, combine } from '../public/js/shamir.js';
import * as llc from '../public/js/llcrypto.js';

test('shamir: any k of n shares rebuild the secret, fewer do not', () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const shares = split(secret, 5, 3);
  assert.equal(shares.length, 5);
  assert.deepEqual(combine([shares[0], shares[2], shares[4]]), secret);
  assert.deepEqual(combine([shares[3], shares[1], shares[0]]), secret);
  assert.deepEqual(combine(shares), secret);
  assert.notDeepEqual(combine([shares[0], shares[1]]), secret);
});

test('shamir: rejects bad input', () => {
  const secret = new Uint8Array([1, 2, 3]);
  assert.throws(() => split(secret, 1, 1));
  assert.throws(() => split(secret, 3, 4));
  const shares = split(secret, 3, 2);
  assert.throws(() => combine([shares[0], shares[0]]));
});

test('keeper codes survive sloppy typing', () => {
  const { raw, text } = llc.newKeeperCode();
  assert.match(text, /^LL-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{6}$/);
  assert.deepEqual(llc.parseKeeperCode(text), raw);
  assert.deepEqual(llc.parseKeeperCode(text.toLowerCase()), raw);
  assert.deepEqual(llc.parseKeeperCode(text.replace(/-/g, ' ')), raw);
  assert.deepEqual(llc.parseKeeperCode(text.replace(/0/g, 'O').replace(/1/g, 'I')), raw);
  assert.throws(() => llc.parseKeeperCode('LL-ABC'));
});

test('seal/open round-trips and detects tampering', async () => {
  const key = llc.newVaultKey();
  const sealed = await llc.sealJSON(key, { hello: 'world' });
  assert.deepEqual(await llc.openJSON(key, sealed), { hello: 'world' });
  const bytes = llc.fromB64(sealed);
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(llc.open(key, llc.toB64(bytes)));
  await assert.rejects(llc.open(llc.newVaultKey(), sealed));
});

test('account keys: same password gives same keys, auth and wrap keys are independent', async () => {
  const salt = llc.newSalt();
  const a = await llc.deriveAccountKeys('correct horse battery staple', salt, 1000);
  const b = await llc.deriveAccountKeys('correct horse battery staple', salt, 1000);
  const c = await llc.deriveAccountKeys('correct horse battery stapl3', salt, 1000);
  assert.equal(a.authKey, b.authKey);
  assert.deepEqual(a.wrapKey, b.wrapKey);
  assert.notEqual(a.authKey, c.authKey);
  assert.match(a.authKey, /^[0-9a-f]{64}$/);
  assert.equal(a.wrapKey.length, 32);
});

test('full keeper flow: codes open shares, shares rebuild the vault key', async () => {
  const vaultKey = llc.newVaultKey();
  const keepers = await llc.makeKeeperShares(vaultKey, 4, 2);
  const sealedShares = keepers.map((k) => k.encryptedShare);

  const { shares, unmatched } = await llc.openKeeperShares([keepers[1].codeText, keepers[3].codeText, 'LL-NOPE'], sealedShares);
  assert.equal(shares.length, 2);
  assert.equal(unmatched.length, 1);
  assert.deepEqual(llc.rebuildVaultKey(shares), vaultKey);

  // the same code twice is one share, not two
  const dup = await llc.openKeeperShares([keepers[0].codeText, keepers[0].codeText], sealedShares);
  assert.equal(dup.shares.length, 1);
});
