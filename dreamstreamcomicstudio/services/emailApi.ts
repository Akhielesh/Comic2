// Client API for the Chat Studio email widgets. Thin wrappers over the authenticated
// connectors `fetch` endpoint (POST /api/connectors/connections/:id/fetch), which is
// scoped server-side to the signed-in owner of the connection. The email "terminal"
// widget uses these to search, page and read message bodies on demand — WITHOUT a model
// round-trip — so browsing the inbox feels instant and stays user-scoped.

import { post } from './apiClient';
import type { EmailMessage } from '../apiTypes';

interface FetchEnvelope<T> {
  ok: boolean;
  data: T;
}

const fetchResource = <T>(connectionId: string, resource: string, params: Record<string, unknown> = {}): Promise<T> =>
  post<{ resource: string; params: Record<string, unknown> }, FetchEnvelope<T>>(
    `/api/connectors/connections/${encodeURIComponent(connectionId)}/fetch`,
    { resource, params }
  ).then((r) => r.data);

export interface EmailListResult {
  box: 'inbox' | 'unread';
  emails: EmailMessage[];
  nextCursor: string | null;
}

/** List a mailbox view (inbox / unread / a search), with optional paging cursor. */
export const fetchEmails = (
  connectionId: string,
  opts: { box?: 'inbox' | 'unread' | 'search'; q?: string; max?: number; cursor?: string | null } = {}
): Promise<EmailListResult> => {
  const resource = opts.box === 'unread' ? 'unread' : opts.box === 'search' ? 'search' : 'inbox';
  return fetchResource<EmailListResult>(connectionId, resource, {
    q: opts.q || '',
    max: opts.max || 25,
    ...(opts.cursor ? { cursor: opts.cursor } : {})
  });
};

/** Read one message in full — decoded text + ORIGINAL HTML body + attachments. */
export const fetchEmailBody = (connectionId: string, id: string): Promise<EmailMessage> =>
  fetchResource<{ email: EmailMessage }>(connectionId, 'message', { id }).then((d) => d.email);

/** Raw attachment bytes (base64url) for an inline image or a download. */
export const fetchAttachment = (
  connectionId: string,
  messageId: string,
  attachmentId: string
): Promise<{ data: string; size: number | null }> =>
  fetchResource<{ data: string; size: number | null }>(connectionId, 'attachment', { id: messageId, attachmentId });

/** Read a whole conversation (each message with its body). */
export const fetchEmailThread = (
  connectionId: string,
  threadId: string
): Promise<{ threadId: string; subject: string | null; emails: EmailMessage[] }> =>
  fetchResource(connectionId, 'thread', { id: threadId });
