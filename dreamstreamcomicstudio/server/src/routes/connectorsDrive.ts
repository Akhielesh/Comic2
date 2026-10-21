// ============================================================================
// /api/connectors/drive — Stream Studio "save recordings to Google Drive"
// ============================================================================
//
// Mounted inside the authenticated connectorsRouter, so every route is per-user and
// behind requireAuth. Uses the `google_drive_save` connection (drive.file scope only).
//
//   GET  /status          → { connected, email?, expired?, configured, folderId?, connectionId? }
//   POST /upload-session  → { uploadUrl, folderId, folderUrl }   body { name, mimeType, size }
//   POST /disconnect      → { ok, revoked }
//
// The recording itself never comes here: the browser uploads it straight to the Drive
// resumable session URL this returns. The access token never leaves the server.
// ============================================================================

import { Router, type Request, type Response } from 'express';
import { connectorRegistry } from '../connectors/index.js';
import { getValidAccessToken } from '../connectors/credentials.js';
import { isGoogleOAuthConfigured } from '../connectors/oauth.js';
import {
  DriveQuotaError,
  DriveUpstreamError,
  ensureRecordingsFolder,
  startResumableUpload,
  validateUploadRequest
} from '../connectors/driveSave.js';
import { DRIVE_SAVE_CONNECTOR_ID, GoogleDriveSaveConnector } from '../connectors/connectors/googleDriveSave.js';
import {
  deleteConnection,
  getActiveConnection,
  listConnections,
  loadCredentials,
  setConnectionStatus,
  updateConnectionMetadata
} from '../connectors/store.js';
import { ConnectorAuthError, ConnectorRateLimitError } from '../connectors/types.js';
import { isAllowedOrigin } from '../config.js';
import { createRateLimit } from '../middleware/rateLimit.js';
import { logger } from '../lib/logger.js';

export const driveSaveRouter = Router();

/** A few saves a minute is plenty for a human; this stops a runaway loop or abuse. */
export const driveUploadRateLimit = createRateLimit({ scope: 'drive_upload', windowMs: 10 * 60_000, maxRequests: 30 });

const folderUrl = (folderId: string) => `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;

const userIdOf = (req: Request, res: Response): string | null => {
  const id = req.user?.id;
  if (!id) {
    res.status(401).json({ error: 'not_signed_in', message: 'Sign in first.' });
    return null;
  }
  return id;
};

/**
 * The browser origin to bind the Drive session's CORS to. Only an origin our own CORS
 * policy trusts is forwarded (never a raw caller-controlled string), falling back to the
 * Referer's origin for browsers that omit Origin.
 */
export const trustedBrowserOrigin = (req: Pick<Request, 'get'>): string | undefined => {
  const candidates = [req.get('origin'), req.get('referer')];
  for (const raw of candidates) {
    if (!raw || raw === 'null') continue;
    let origin: string;
    try {
      origin = new URL(raw).origin;
    } catch {
      continue;
    }
    if (origin && origin !== 'null' && isAllowedOrigin(origin)) return origin;
  }
  return undefined;
};

const cachedFolderId = (metadata: Record<string, unknown> | null | undefined): string | null => {
  const v = metadata?.recordingsFolderId;
  return typeof v === 'string' && /^[A-Za-z0-9_-]{5,200}$/.test(v) ? v : null;
};

// GET /status — is Drive saving connected for this user?
driveSaveRouter.get('/status', async (req, res, next) => {
  try {
    const userId = userIdOf(req, res);
    if (!userId) return;
    const configured = isGoogleOAuthConfigured();
    const conn = await getActiveConnection(userId, DRIVE_SAVE_CONNECTOR_ID);
    res.set('Cache-Control', 'no-store');
    if (!conn) return res.json({ ok: true, connected: false, configured });
    const missingScope = !GoogleDriveSaveConnector.hasWriteScope(conn.granted_scopes);
    const expired = conn.status === 'expired' || missingScope;
    const folderId = cachedFolderId(conn.metadata);
    res.json({
      ok: true,
      connected: true,
      configured,
      email: conn.account_identifier || undefined,
      name: conn.account_label || undefined,
      expired,
      ...(missingScope ? { reason: 'missing_scope' } : conn.status === 'expired' ? { reason: 'expired' } : {}),
      connectionId: conn.id,
      ...(folderId ? { folderId, folderUrl: folderUrl(folderId) } : {})
    });
  } catch (err) {
    next(err);
  }
});

// POST /upload-session — open a Drive resumable upload for one recording.
driveSaveRouter.post('/upload-session', driveUploadRateLimit, async (req, res, next) => {
  try {
    const userId = userIdOf(req, res);
    if (!userId) return;
    res.set('Cache-Control', 'no-store');

    const check = validateUploadRequest(req.body);
    if (check.ok === false) return res.status(400).json({ error: 'bad_request', field: check.field, message: check.message });

    const conn = await getActiveConnection(userId, DRIVE_SAVE_CONNECTOR_ID);
    if (!conn) {
      return res.status(404).json({ error: 'not_connected', message: 'Connect Google Drive to save recordings there.' });
    }
    if (conn.status === 'expired' || !GoogleDriveSaveConnector.hasWriteScope(conn.granted_scopes)) {
      return res.status(409).json({ error: 'reconnect', message: 'Reconnect Google Drive — the permission to save files expired or wasn’t granted.' });
    }
    const connector = connectorRegistry.get(DRIVE_SAVE_CONNECTOR_ID);
    if (!connector) return res.status(503).json({ error: 'unavailable', message: 'Google Drive saving is not available.' });

    try {
      const accessToken = await getValidAccessToken(conn, connector);
      const cached = cachedFolderId(conn.metadata);
      const { folderId, created } = await ensureRecordingsFolder(accessToken, cached);
      if (folderId !== cached) {
        await updateConnectionMetadata(conn.id, { ...(conn.metadata || {}), recordingsFolderId: folderId }).catch((e) =>
          logger.warn('drive_folder_cache_failed', { message: (e as Error)?.message })
        );
      }
      const uploadUrl = await startResumableUpload({
        accessToken,
        name: check.name,
        mimeType: check.mimeType,
        size: check.size,
        folderId,
        origin: trustedBrowserOrigin(req)
      });
      // Never log the token or the session URL (it is an upload capability).
      logger.info('drive_upload_session', { userId, bytes: check.size, mimeType: check.mimeType, folderCreated: created });
      return res.json({ ok: true, uploadUrl, folderId, folderUrl: folderUrl(folderId) });
    } catch (err) {
      if (err instanceof ConnectorAuthError) {
        await setConnectionStatus(conn.id, 'expired', 'Google Drive authorization is no longer valid — please reconnect.').catch(() => {});
        return res.status(409).json({ error: 'reconnect', message: 'Reconnect Google Drive — Google no longer accepts this connection.' });
      }
      if (err instanceof DriveQuotaError) {
        return res.status(403).json({ error: 'quota_exceeded', message: 'Your Google Drive is full — free up space or save to this device.' });
      }
      if (err instanceof ConnectorRateLimitError) {
        return res.status(429).json({ error: 'rate_limited', message: 'Google Drive is busy — try again in a minute.' });
      }
      if (err instanceof DriveUpstreamError) {
        logger.warn('drive_upload_session_upstream', { message: err.message });
        return res.status(502).json({ error: 'drive_unavailable', message: 'Google Drive didn’t respond — try again in a moment.' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// POST /disconnect — forget the Drive-save connection. Google grants for one client are
// shared across scopes (include_granted_scopes), so revoking the token would ALSO cut off
// the user's other Google connections (Gmail, Calendar…) for the same account. Revoke at
// Google only when this was the last Google connection for that account.
driveSaveRouter.post('/disconnect', async (req, res, next) => {
  try {
    const userId = userIdOf(req, res);
    if (!userId) return;
    const all = await listConnections(userId);
    const mine = all.filter((c) => c.connector_id === DRIVE_SAVE_CONNECTOR_ID);
    const connector = connectorRegistry.get(DRIVE_SAVE_CONNECTOR_ID);
    let revoked = false;
    for (const conn of mine) {
      const sharesGrant = all.some(
        (c) =>
          c.id !== conn.id &&
          c.connector_id !== DRIVE_SAVE_CONNECTOR_ID &&
          c.auth_type === 'user_oauth' &&
          c.status !== 'disconnected' &&
          c.account_identifier === conn.account_identifier &&
          connectorRegistry.get(c.connector_id)?.metadata.providerGroup === 'google'
      );
      if (!sharesGrant && connector) {
        const creds = await loadCredentials(conn.id).catch(() => null);
        if (creds) {
          await connector
            .revoke({ accessToken: creds.accessToken, refreshToken: creds.refreshToken })
            .then(() => {
              revoked = true;
            })
            .catch((e) => logger.warn('drive_save_revoke_failed', { message: (e as Error)?.message }));
        }
      }
      await deleteConnection(conn.id);
    }
    res.json({ ok: true, revoked });
  } catch (err) {
    next(err);
  }
});
