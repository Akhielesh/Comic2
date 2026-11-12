/**
 * Mailboxes on our own domain. support@ and privacy@ are the Cloudflare Email Routing addresses the
 * setup guide creates (docs/connectors/google-setup.md "Professional contact addresses"); support@
 * is also the Contact in public/.well-known/security.txt.
 *
 * Their own module, with nothing else in it, so Stream Studio (live/) can import an address without
 * pulling legalFacts.ts, and the third-party links it holds, into its bundle (the built-app CSP test,
 * tests/edge/liveCsp.built.test.ts, checks every origin Stream Studio's code contains).
 * legalFacts.ts re-exports both.
 */
export const SUPPORT_EMAIL = 'support@dreamstreamstudio.ai';
export const PRIVACY_EMAIL = 'privacy@dreamstreamstudio.ai';
