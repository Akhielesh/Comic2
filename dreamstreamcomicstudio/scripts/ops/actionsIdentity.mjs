export async function githubIdentityToken(audience, env = process.env, fetcher = fetch) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('GitHub OIDC permission is unavailable');
  const identityUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (identityUrl.protocol !== 'https:' || !identityUrl.hostname.endsWith('.actions.githubusercontent.com')) {
    throw new Error('Unexpected GitHub OIDC endpoint');
  }
  identityUrl.searchParams.set('audience', audience);
  const identity = await fetcher(identityUrl, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000)
  });
  if (!identity.ok) throw new Error(`GitHub OIDC request failed (${identity.status})`);
  const { value: token } = await identity.json();
  if (typeof token !== 'string' || token.length > 16_000 || !token) throw new Error('GitHub returned no identity token');
  return token;
}
