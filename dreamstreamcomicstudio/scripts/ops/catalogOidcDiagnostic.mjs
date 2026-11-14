import { createPublicKey, verify } from 'node:crypto';
const audience = 'urn:dreamstream:catalog-maintenance';
const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
url.searchParams.set('audience', audience);
const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: 'error' });
if (!response.ok) throw new Error('OIDC_REQUEST_FAILED');
const { value } = await response.json();
const [h, p, s] = value.split('.');
const header = JSON.parse(Buffer.from(h, 'base64url'));
const c = JSON.parse(Buffer.from(p, 'base64url'));
const jwksResponse = await fetch('https://token.actions.githubusercontent.com/.well-known/jwks', { redirect: 'error' });
const jwks = await jwksResponse.json();
const key = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig');
const now = Math.floor(Date.now() / 1000);
const ref = 'refs/heads/codex/catalog-oidc-diagnostic';
console.log(JSON.stringify({
  diagnostic: 'non-secret-policy-checks-only',
  headerAlgorithm: header.alg, headerType: header.typ, hasCriticalHeader: header.crit !== undefined,
  issuerMatches: c.iss === 'https://token.actions.githubusercontent.com', audienceMatches: c.aud === audience,
  repositoryMatches: c.repository === 'Akhielesh/Comic2', repositoryIdMatches: c.repository_id === '1151761968',
  ownerMatches: c.repository_owner === 'Akhielesh', ownerIdMatches: c.repository_owner_id === '102168504',
  refMatches: c.ref === ref, refType: c.ref_type,
  workflowMatches: c.workflow_ref === `Akhielesh/Comic2/.github/workflows/refresh-model-catalog.yml@${ref}`,
  defaultSubjectMatches: c.sub === `repo:Akhielesh/Comic2:ref:${ref}`,
  hasJobWorkflowRef: c.job_workflow_ref !== undefined, jobWorkflowRefMatchesSelf: c.job_workflow_ref === c.workflow_ref,
  event: c.event_name, runnerEnvironment: c.runner_environment,
  jtiValid: typeof c.jti === 'string' && c.jti.length >= 8 && c.jti.length <= 200,
  timeTypes: [c.iat,c.nbf,c.exp].map(v => typeof v), lifetimeSeconds: c.exp-c.iat,
  ageSeconds: now-c.iat, notBeforeOffsetSeconds: c.nbf-now, expiresInSeconds: c.exp-now,
  runIdValid: /^\d+$/.test(String(c.run_id)), attemptValid: /^\d+$/.test(String(c.run_attempt)),
  publicSigningKeyFound: !!key,
  signatureVerified: !!key && verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({key, format:'jwk'}), Buffer.from(s,'base64url'))
}));
