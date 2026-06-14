// ============================================================================
// Push / webhook seam (Gmail / Drive / Calendar `watch`)
// ============================================================================
//
// v1 SYNCS BY POLLING, but the seam for Google push notifications is wired here so
// realtime delivery is a drop-in later: registering a `watch` channel (Pub/Sub for
// Gmail, push channels for Drive/Calendar) is the only remaining piece. When a push
// arrives, we map it to the owning connection(s) and trigger an INCREMENTAL sync —
// the exact same code path as polling, so nothing downstream changes.
//
// The endpoint is inert unless CONNECTORS_WEBHOOK_TOKEN is set (then it authenticates
// the caller with it). It is mounted BEFORE the global requireAuth (providers don't
// carry an app session) and verifies its own shared token instead.
// ============================================================================

import { Router } from 'express';
import { connectorRegistry } from '../index.js';
import { findConnectionsByAccount } from '../store.js';
import { triggerSync } from './trigger.js';

export const connectorsWebhookRouter = Router();

const webhookToken = (): string => (process.env.CONNECTORS_WEBHOOK_TOKEN || '').trim();

connectorsWebhookRouter.post('/:connectorId', async (req, res) => {
  const token = webhookToken();
  if (!token) return res.status(503).json({ error: { message: 'Webhooks not configured' } });

  // Constant-ish shared-token check (header or query).
  const provided = String(req.headers['x-connector-webhook-token'] || req.query.token || '');
  if (provided !== token) return res.status(401).json({ error: { message: 'Invalid webhook token' } });

  const connectorId = String(req.params.connectorId || '');
  const connector = connectorRegistry.get(connectorId);
  if (!connector || !connector.metadata.capabilities.realtime) {
    return res.status(404).json({ error: { message: 'Unknown or non-realtime connector' } });
  }

  // Minimal, connector-agnostic payload: which account changed. (Gmail Pub/Sub wraps
  // this in a base64 `message.data`; that decode lands with real `watch` registration.)
  const accountIdentifier = String(req.body?.accountIdentifier || req.body?.emailAddress || '');
  if (!accountIdentifier) {
    // Acknowledge so the provider doesn't redeliver; nothing actionable yet.
    return res.status(202).json({ ok: true, matched: 0 });
  }

  try {
    const connections = await findConnectionsByAccount(connectorId, accountIdentifier);
    await Promise.all(connections.map((c) => triggerSync(c.user_id, c.id, 'incremental')));
    return res.status(202).json({ ok: true, matched: connections.length });
  } catch (err) {
    return res.status(500).json({ error: { message: (err as Error)?.message || 'webhook handling failed' } });
  }
});
