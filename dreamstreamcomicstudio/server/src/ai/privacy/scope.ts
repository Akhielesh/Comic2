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

/**
 * What actually left for a model during a scoped run. The deny decision is made up front (a turn
 * that MAY carry connector content); whether connector content was really SENT is only known at
 * the egress point, ai/providers/openrouter.ts, which reports it here (`noteConnectorEgress`) when
 * a request body carries connector content (the connector context block, a connector tool's call
 * or output: ./connectorData.ts messagesCarryConnectorData). routes/chat.ts marks a reply as
 * connected content (`connectorData: true`, the provenance store) only when its probe saw that.
 */
export type ConnectorEgressProbe = { sent: boolean };

/** A fresh probe for one run. */
export const connectorEgressProbe = (): ConnectorEgressProbe => ({ sent: false });

type PrivacyStore = { readonly connectorData: boolean; readonly probes: readonly ConnectorEgressProbe[] };

const store = new AsyncLocalStorage<PrivacyStore>();
const ACTIVE: PrivacyStore = Object.freeze({ connectorData: true, probes: Object.freeze([]) as readonly ConnectorEgressProbe[] });

/** True while running inside a turn that carries connected-account content. */
export const connectorPrivacyActive = (): boolean => store.getStore()?.connectorData === true;

/**
 * Run `fn` with connected-account privacy on when `connectorData` is true; otherwise run it as is
 * (an enclosing scope, if any, stays in force). `probe` (optional) learns whether any model call
 * inside the scope actually sent connector content; a nested scope reports to every enclosing
 * probe as well.
 *
 * A probe is registered even when this run is not flagged (`connectorData` false, no enclosing
 * scope): the run itself denies nothing, but a nested flagged run inside it (the swarm's connector
 * agents, a recipe's connector run) reports to it, so the route still learns that connector content
 * was sent and marks the reply.
 */
export const runWithConnectorPrivacy = <T>(connectorData: boolean, fn: () => T, probe?: ConnectorEgressProbe): T => {
  const current = store.getStore();
  // Sticky: an enclosing flagged scope stays in force; a nested flag turns it on.
  const active = connectorData || current?.connectorData === true;
  const probes = probe ? [...(current?.probes || []), probe] : current?.probes || [];
  if (current && current.connectorData === active && !probe) return fn();
  if (!current && !active && !probe) return fn();
  return store.run(active && !probes.length ? ACTIVE : { connectorData: active, probes }, fn);
};

/** Called by the provider when a scoped request body carries connector content. */
export const noteConnectorEgress = (): void => {
  for (const probe of store.getStore()?.probes || []) probe.sent = true;
};

// ── The request-level decision, for agent paths that start after prepareChat returned ─────────
// routes/chat.ts prepareChat decides once per request; /api/recipes then calls runRecipe outside
// any scope. The decision is bound to the request's clientContext object, which prepareChat hands
// to every agent path untouched (the same out-of-band pattern as ai/tools/platformDocs.ts), so
// runRecipe and the swarm read it with `connectorPrivacyBound(clientContext)`. Nothing is read from
// the object's own properties: a client cannot set it.
//
// The whole decision is bound, not just the flag: `freeTurn` (the turn runs on a free model, so
// connector tools were withheld) lets runRecipe use prepareChat's own answer — which also knows a
// pinned model the catalog prices at $0 without a `:free` suffix — instead of re-deriving it.

/** prepareChat's privacy decision for one request. */
export type ConnectorTurnDecision = { connectorData: boolean; freeTurn: boolean };

const BOUND = new WeakMap<object, ConnectorTurnDecision>();

/** Mark the request (by its clientContext object) as carrying connected-account content. */
export const bindConnectorPrivacy = (clientContext: object | undefined, connectorData: boolean): void => {
  if (clientContext && connectorData) BOUND.set(clientContext, { freeTurn: BOUND.get(clientContext)?.freeTurn ?? false, connectorData: true });
};

/** True when prepareChat decided this request carries connected-account content. */
export const connectorPrivacyBound = (clientContext: object | undefined): boolean =>
  Boolean(clientContext && BOUND.get(clientContext)?.connectorData);

/** Bind prepareChat's whole decision (flag and free turn) to the request. */
export const bindConnectorTurnDecision = (clientContext: object | undefined, decision: ConnectorTurnDecision): void => {
  if (clientContext) BOUND.set(clientContext, { connectorData: decision.connectorData, freeTurn: decision.freeTurn });
};

/** prepareChat's decision for this request, when one was bound. */
export const connectorTurnDecision = (clientContext: object | undefined): ConnectorTurnDecision | undefined =>
  clientContext ? BOUND.get(clientContext) : undefined;
