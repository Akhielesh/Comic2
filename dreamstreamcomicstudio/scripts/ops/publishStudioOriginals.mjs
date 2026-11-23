import { setTimeout as delay } from 'node:timers/promises';
import { githubIdentityToken } from './actionsIdentity.mjs';

const endpoint = 'https://dreamstream-api.akhieleshsrirangam.workers.dev/api/internal/originals/';
const keys = ['tide', 'orchard', 'fox', 'table-nine'];
const audience = 'urn:dreamstream:originals-publisher';

async function publish(key) {
  for (let poll = 0; poll < 100; poll++) {
    const token = await githubIdentityToken(audience);
    const reply = await fetch(endpoint + key, {
      method: 'POST', headers: {Authorization: 'Bearer ' + token, Accept: 'application/json'},
      redirect: 'error', signal: AbortSignal.timeout(45_000)
    });
    if (reply.status === 202 || reply.status === 409 || reply.status === 429) {
      await delay(12_000);
      continue;
    }
    if (!reply.ok) {
      const error = await reply.json().catch(() => null);
      const code = typeof error?.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : 'REQUEST_FAILED';
      throw new Error('Publishing ' + key + ' returned HTTP ' + reply.status + ' (' + code + ')');
    }
    const result = await reply.json();
    if (result.state !== 'published' || !/^[a-zA-Z0-9]{17}$/.test(result.slug)) {
      throw new Error('Publishing ' + key + ' returned an incomplete result.');
    }
    console.log(key + ' https://comics.dreamstreamstudio.ai/c/' + result.slug);
    return;
  }
  throw new Error('Timed out waiting for ' + key);
}
// A content release may start before its matching backend image reaches production.
if (process.env.GITHUB_EVENT_NAME === 'push') {
  const revision = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Missing production revision.');
  let ready = false;
  for (let attempt = 0; attempt < 180 && !ready; attempt++) {
    try {
      const version = await fetch('https://dreamstream-api.akhieleshsrirangam.workers.dev/api/system/version', {
        redirect: 'error', signal: AbortSignal.timeout(12_000)
      });
      ready = version.ok && (await version.json()).gitSha === revision;
    } catch { /* A new image may still be starting. */ }
    if (!ready) await delay(15_000);
  }
  if (!ready) throw new Error('The reviewed backend revision is not serving yet.');
}
for (const key of keys) await publish(key);
