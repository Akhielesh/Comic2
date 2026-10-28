#!/usr/bin/env node
// Make the live Worker's DEVICE_TOKEN_JWK secret: a fresh P-256 private key (ES256) as a JWK,
// with kid = its RFC 7638 thumbprint. It signs device grants and 10-minute device access tokens
// (live-worker/src/auth/deviceToken.ts; ADR 0006 D4.4).
//
//   node scripts/ops/genDeviceTokenKey.mjs | (cd live-worker && npx wrangler secret put DEVICE_TOKEN_JWK)
//
// Rotation (grants live 30 days): put the new key first and keep the old one verifying —
//
//   node scripts/ops/genDeviceTokenKey.mjs --previous old.json | (cd live-worker && npx wrangler secret put DEVICE_TOKEN_JWK)
//
// prints {"keys":[NEW, …old]}. After 30 days set it to NEW alone. `old.json` holds the current
// secret value (a JWK or {"keys":[…]}); keep it off disk afterwards.
//
// The key goes to stdout only — never into the repo, a log or a ticket. Instructions go to stderr.

import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const subtle = webcrypto.subtle;

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7638 thumbprint of an EC public key. */
export async function thumbprint(jwk) {
  const canon = `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(canon))));
}

/** A new P-256 private JWK ready for DEVICE_TOKEN_JWK. */
export async function makeDeviceTokenJwk() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  const kid = await thumbprint(jwk);
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid, alg: 'ES256', use: 'sig' };
}

/** The secret value: the new key alone, or first among the previous ones while rotating. */
export function secretValue(next, previous) {
  if (!previous) return next;
  const old = Array.isArray(previous.keys) ? previous.keys : [previous];
  const keep = old.filter((k) => k && k.kid !== next.kid && k.kty === 'EC' && k.d);
  return { keys: [next, ...keep] };
}

async function main(argv) {
  const at = argv.indexOf('--previous');
  let previous = null;
  if (at >= 0) {
    const file = argv[at + 1];
    if (!file) {
      process.stderr.write('usage: genDeviceTokenKey.mjs [--previous <file with the current secret>]\n');
      process.exit(2);
    }
    previous = JSON.parse(readFileSync(file, 'utf8'));
  }
  const next = await makeDeviceTokenJwk();
  process.stdout.write(JSON.stringify(secretValue(next, previous)));
  process.stderr.write(`\nNew device-token key ${next.kid}. Pipe this into: npx wrangler secret put DEVICE_TOKEN_JWK (in live-worker/).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err?.message || err}\n`);
    process.exit(1);
  });
}
