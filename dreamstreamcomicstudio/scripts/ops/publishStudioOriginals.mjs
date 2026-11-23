import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { githubIdentityToken } from './actionsIdentity.mjs';

const endpoint = 'https://dreamstream-api.akhieleshsrirangam.workers.dev/api/internal/originals/';
const keys = ['tide', 'orchard', 'fox', 'table-nine'];
const audience = 'urn:dreamstream:originals-publisher';

export async function publish(key, env = process.env, fetcher = fetch) {
  if (!keys.includes(key)) throw new Error('Select one registered Studio Original.');
  for (let poll = 0; poll < 100; poll++) {
    const token = await githubIdentityToken(audience, env, fetcher);
    const reply = await fetcher(endpoint + key, {
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
    return 'https://comics.dreamstreamstudio.ai/c/' + result.slug;
  }
  throw new Error('Timed out waiting for ' + key);
}
// A content release may start before its matching backend image reaches production.
async function waitForRevision(revision) {
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_EVENT_NAME === 'push') await waitForRevision(process.env.GITHUB_SHA);
  console.log(await publish(process.env.ORIGINAL_BOOK));
}
