/**
 * Mailboxes on our own domain. support@ and privacy@ are the Cloudflare Email Routing addresses the
 * setup guide creates (docs/connectors/google-setup.md "Professional contact addresses"); support@
 * is also the Contact in public/.well-known/security.txt.
 *
 * SUPPORT_EMAIL is the one address every DreamStream surface sends people to (lead decision D9;
 * tests/config/supportEmail.test.ts fails on any other DreamStream address or a contact@ mailbox in the
 * app's source). PRIVACY_EMAIL is declared here only, for the legal pages' privacy requests: nothing else
 * may spell it by hand (the same guard pins this file as its one home).
 *
 * Their own module, with nothing else in it, so Stream Studio (live/) can import an address without
 * pulling legalFacts.ts, and the third-party links it holds, into its bundle (the built-app CSP test,
 * tests/edge/liveCsp.built.test.ts, checks every origin Stream Studio's code contains).
 * legalFacts.ts (Atlas #263's module; not in this tree until that PR lands) re-exports both.
 */
export const SUPPORT_EMAIL = 'support@dreamstreamstudio.ai';
export const PRIVACY_EMAIL = 'privacy@dreamstreamstudio.ai';
