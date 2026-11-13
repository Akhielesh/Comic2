// Admin-only client for Settings › Contact messages (CONTACT-1): GET /api/admin/contact-messages and
// POST /api/admin/contact-messages/:id/handled. Mirrors the shapes in server/src/routes/admin.ts and
// server/src/services/contactStore.ts.

import { get, post } from './apiClient';

export interface ContactMessage {
  id: string;
  /** The reply-to address the person typed. */
  email: string;
  message: string;
  created_at: string;
  /** When an admin marked it answered; null while open. */
  handled_at: string | null;
}

export interface ContactMessagesPage {
  items: ContactMessage[];
  /** Pass back as `cursor` for the next (older) page; absent on the last page. */
  nextCursor?: string;
  /** false until server/sql/contact_messages.sql is applied and the backend has its service role. */
  storageEnabled: boolean;
}

export interface ContactMessagesApi {
  list(cursor?: string): Promise<ContactMessagesPage>;
  markHandled(id: string): Promise<{ ok: true; id: string; handledAt: string }>;
}

export const listContactMessages = (cursor?: string): Promise<ContactMessagesPage> =>
  get<ContactMessagesPage>(`/api/admin/contact-messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);

export const markContactMessageHandled = (id: string) =>
  post<Record<string, never>, { ok: true; id: string; handledAt: string }>(`/api/admin/contact-messages/${encodeURIComponent(id)}/handled`, {});

export const contactMessagesApi: ContactMessagesApi = { list: listContactMessages, markHandled: markContactMessageHandled };
