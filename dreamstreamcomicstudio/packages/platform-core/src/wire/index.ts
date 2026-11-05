/**
 * The wire (plan §5.8, §5.9): canonical request signing, claims, poll tokens, headers and errors. Pure; crypto, fetch
 * and the clock are injected (`WireCrypto`, `FetchLike`, `WireClock`). The secret-holding client is `../client`.
 */
export * from './types.js';
export {
  asciiBytes,
  base64urlDecode,
  base64urlEncode,
  constantTimeEqual,
  constantTimeEqualText,
  fromHex,
  isBytes,
  toArrayBuffer,
  toHex,
  utf8Decode,
  utf8Encode,
} from './bytes.js';
export { WIRE_KEY_LABELS, decodeSecret, deriveWireKey, hmac, isUsableSecret, pseudonymousSub, sha256Hex, wireCryptoFromSubtle } from './crypto.js';
export type { SubtleCryptoLike } from './crypto.js';
export {
  canonicalPath,
  canonicalQuery,
  canonicalRequest,
  encodeQuery,
  formatCanonicalRequest,
  idempotencyScope,
  isIdempotencyKey,
  isTokenShaped,
  rfc3986Encode,
  signRequest,
  splitTarget,
  verifySignature,
} from './canonical.js';
export type { CanonicalFields, CanonicalResult, RequestToSign, SignResult, VerifySignatureResult } from './canonical.js';
export { claimOwner, mintServiceClaim, mintUserClaim, sealToken, verifyClaim } from './claim.js';
export type { ClaimKeyring, ClaimRequirement, MintClaimResult, ServiceClaimInput, UserClaimInput, VerifyClaimOptions, VerifyClaimResult } from './claim.js';
export { mintPollToken, verifyPollToken } from './pollToken.js';
export type { MintPollTokenResult, PollTokenInput, VerifyPollTokenOptions, VerifyPollTokenResult } from './pollToken.js';
export {
  PLATFORM_HEADERS,
  encodeWarnings,
  parseCostMicros,
  parseWarnings,
  preflightRequest,
  readHeader,
  signedRequestHeaders,
  verifyRequest,
  verifyRequestSignature,
} from './headers.js';
export type {
  IncomingRequest,
  Preflight,
  PreflightOptions,
  PreflightResult,
  ReceivedBody,
  SignedHeadersInput,
  SignedHeadersResult,
  SignedRequestFacts,
  VerifiedRequest,
  VerifiedRequestResult,
} from './headers.js';
export {
  WIRE_REASON_CODES,
  errorResponse,
  failureFromResponse,
  inputFailure,
  internalFailure,
  networkFailure,
  parseErrorBody,
  wireFailure,
} from './errors.js';
