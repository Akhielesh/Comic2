/**
 * The support mailbox on our own domain (the Cloudflare Email Routing address the setup guide creates,
 * docs/connectors/google-setup.md "Professional contact addresses"; also the Contact in
 * public/.well-known/security.txt). Every DreamStream surface links here (lead decision D9).
 *
 * Its own module, with nothing else in it, so any surface can import the address without pulling in more.
 * This is Atlas #263's constant and module: when #263 lands, take its copy of this file.
 */
export const SUPPORT_EMAIL = 'support@dreamstreamstudio.ai';
