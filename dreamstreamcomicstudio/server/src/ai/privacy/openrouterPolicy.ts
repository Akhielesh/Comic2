// How an OpenRouter request that carries connected-account content is routed (pure helpers used
// by ai/providers/openrouter.ts).
//
// 1. `provider.data_collection: 'deny'` on the request body.
//    OpenRouter, "Provider Routing" docs (https://openrouter.ai/docs/features/provider-routing,
//    section "Requiring Providers to Comply with Data Policies"), read 2026-11-04:
//      `data_collection`: "allow" | "deny", default "allow" — "Control whether to use providers
//      that may store data." "allow": "(default) allow providers which store user data
//      non-transiently and may train on it"; "deny": "use only providers which do not collect
//      user data". The docs add that the Data Policy tag "is not a definitive source of third
//      party data policies".
//    Merged into any provider routing fields the body already has (none are set today).
//    UNVERIFIED (no network to openrouter.ai from the build sandbox): how `data_collection` combines
//    with the `models` fallback array (the docs do not say), and whether providers that retain
//    prompts only for abuse monitoring (no training) are excluded. A request that no compliant
//    endpoint can serve fails with a 404 "No endpoints found matching your data policy"; that
//    failure is reported honestly (`dataPolicyUnavailableError`), never retried on a free model.
//    A stricter per-request `zdr: true` ("only routed to ZDR endpoints") exists too; it is not set
//    here (owner decision, see docs/DATA_CONNECTORS.md).
// 2. No free (`:free`) model takes the request: free endpoints are the ones that may log or train.
//    Free members are dropped from `models` and `fallbackModel`. A free PRIMARY model is replaced by
//    the request's own paid `fallbackModel` (the paid net the caller already reserved for, the same
//    model the provider would retry on after a 404/429) — never on a free-only request (`freeOnly`),
//    which is refused instead: a free-only turn never moves to a paid model.
//    The chat routes already keep free models off connector turns; this is the backstop for the
//    agent engines that pick a free worker model on their own (delegation, deep research).

import { isFreeModelId } from './connectorData.js';

export const DATA_COLLECTION_DENY = { data_collection: 'deny' } as const;

/** `body` with `provider.data_collection: 'deny'` merged into any provider routing it already has. */
export const withDataCollectionDenied = <T extends Record<string, unknown>>(body: T): T & { provider: Record<string, unknown> } => {
  const existing = body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider)
    ? (body.provider as Record<string, unknown>)
    : {};
  return { ...body, provider: { ...existing, ...DATA_COLLECTION_DENY } };
};

type Routable = { model: string; models?: string[]; fallbackModel?: string; freeOnly?: boolean };

export type ConnectorRoute<T extends Routable> =
  | { ok: true; req: T; swappedFrom?: string }
  | { ok: false; error: Error & { status: number; publicCode: string; publicMessage: string } };

/** Error code + calm copy when a connector request could only have gone to a free model. */
export const CONNECTOR_FREE_MODEL_REFUSED = 'CONNECTED_DATA_NEEDS_STANDARD_MODEL';

const refusal = (): Error & { status: number; publicCode: string; publicMessage: string } =>
  Object.assign(new Error('connected-account content was not sent to a free model'), {
    status: 409,
    publicCode: CONNECTOR_FREE_MODEL_REFUSED,
    publicMessage:
      "This reply needs content from your connected accounts, and free models may keep or learn from what they receive, so it wasn't sent to one. " +
      'Nothing was sent. Switch to a standard model (turn off Free only), or ask without your connected content.'
  });

/** Route a request that carries connector content: no free model, ever (see the header). */
export const routeForConnectorData = <T extends Routable>(req: T): ConnectorRoute<T> => {
  const fallback = req.fallbackModel && !isFreeModelId(req.fallbackModel) ? req.fallbackModel : undefined;
  const chain = (req.models || []).filter((m) => !isFreeModelId(m));
  if (!isFreeModelId(req.model)) {
    const unchanged = req.fallbackModel === fallback && chain.length === (req.models || []).length;
    if (unchanged) return { ok: true, req };
    return { ok: true, req: { ...req, fallbackModel: fallback, models: chain.length > 1 ? chain : undefined } };
  }
  // A free primary: only the caller's own paid net may take it, and never on a free-only request.
  if (req.freeOnly || !fallback) return { ok: false, error: refusal() };
  const paidChain = chain.filter((m) => m !== fallback);
  return {
    ok: true,
    swappedFrom: req.model,
    req: {
      ...req,
      model: fallback,
      fallbackModel: undefined,
      models: paidChain.length ? [fallback, ...paidChain].slice(0, 3) : undefined
    }
  };
};

/** True for OpenRouter's "no endpoint matches your data policy" failure. */
export const isDataPolicyUnavailable = (err: unknown): boolean =>
  /data policy|matching your data|data_collection/i.test(String((err as Error)?.message || ''));

/** The honest failure when no endpoint that keeps connected content private could take the request. */
export const dataPolicyUnavailableError = (cause: unknown): Error & { status: number; publicCode: string; publicMessage: string } =>
  Object.assign(new Error(`connected-account request: ${String((cause as Error)?.message || 'no private endpoint')}`.slice(0, 500)), {
    status: 503,
    publicCode: 'CONNECTED_DATA_NO_PRIVATE_ENDPOINT',
    publicMessage:
      "This reply uses content from your connected accounts, and right now no endpoint for this model promises not to keep or learn from it, so nothing was sent. Please try again shortly, or pick a different standard model."
  });
