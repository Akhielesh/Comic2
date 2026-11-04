// The connected-account privacy scope: how "this run carries connector content" reaches the
// OpenRouter request body without threading a flag through every engine signature.
//
// An entry point that decided a turn uses connector data (see ./connectorData.ts) runs the turn
// inside `runWithConnectorPrivacy(true, …)`. Every model call made inside it — the first call,
// each tool-loop round, the provider's own retries and fallback, the JSON repair round, the
// engine's timeout / empty-answer retry, and the nested model calls of meta-tools (swarm,
// delegation, deep research) — is made in the same async context, so ai/providers/openrouter.ts
// reads `connectorPrivacyActive()` and sends `provider.data_collection: 'deny'`.
//
// Sticky by design: a nested `runWithConnectorPrivacy(false, …)` never clears an enclosing scope.
// Same pattern as lib/accountContext.ts (AsyncLocalStorage, Node 22).

import { AsyncLocalStorage } from 'node:async_hooks';

type PrivacyStore = { readonly connectorData: true };

const store = new AsyncLocalStorage<PrivacyStore>();
const ACTIVE: PrivacyStore = Object.freeze({ connectorData: true as const });

/** True while running inside a turn that carries connected-account content. */
export const connectorPrivacyActive = (): boolean => store.getStore()?.connectorData === true;

/**
 * Run `fn` with connected-account privacy on when `connectorData` is true; otherwise run it as is
 * (an enclosing scope, if any, stays in force).
 */
export const runWithConnectorPrivacy = <T>(connectorData: boolean, fn: () => T): T =>
  connectorData && !connectorPrivacyActive() ? store.run(ACTIVE, fn) : fn();

// ── The request-level decision, for agent paths that start after prepareChat returned ─────────
// routes/chat.ts prepareChat decides once per request; /api/recipes then calls runRecipe outside
// any scope. The decision is bound to the request's clientContext object, which prepareChat hands
// to every agent path untouched (the same out-of-band pattern as ai/tools/platformDocs.ts), so
// runRecipe and the swarm read it with `connectorPrivacyBound(clientContext)`. Nothing is read from
// the object's own properties: a client cannot set it.
const BOUND = new WeakMap<object, true>();

/** Mark the request (by its clientContext object) as carrying connected-account content. */
export const bindConnectorPrivacy = (clientContext: object | undefined, connectorData: boolean): void => {
  if (clientContext && connectorData) BOUND.set(clientContext, true);
};

/** True when prepareChat decided this request carries connected-account content. */
export const connectorPrivacyBound = (clientContext: object | undefined): boolean =>
  Boolean(clientContext && BOUND.get(clientContext));
