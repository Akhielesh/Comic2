// Product updates use Postmark Broadcasts. Receipts and account mail use the transactional Worker.
import { renderEmail, type EmailParams } from '../../../shared/email/index.js';
import { APP_PUBLIC_URL, EMAIL_HMAC_SECRET, EMAIL_PUBLIC_BASE_URL } from '../config.js';

const API = 'https://api.postmarkapp.com';
const singleMailbox = (value: string) => /^[^\s@,;:<>"\\]+@[^\s@,;:<>"\\]+\.[^\s@,;:<>"\\]+$/.test(value);

function configuration() {
  const stream = process.env.POSTMARK_BROADCAST_STREAM?.trim() || '';
  const from = process.env.POSTMARK_BROADCAST_FROM?.trim() || '';
  const token = process.env.POSTMARK_BROADCAST_SERVER_TOKEN?.trim() || '';
  return { stream, from, token };
}

/** Pure local readiness. Only the provider can verify the stream and authorize the sender. */
export function broadcastReadiness() {
  const enabled = process.env.PRODUCT_UPDATE_TRANSPORT === 'postmark';
  const { stream, from, token } = configuration();
  const missing: string[] = [];
  if (!token) missing.push('POSTMARK_BROADCAST_SERVER_TOKEN');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(stream) || /^(inbound|outbound)$/i.test(stream)) missing.push('POSTMARK_BROADCAST_STREAM');
  if (!singleMailbox(from)) missing.push('POSTMARK_BROADCAST_FROM');
  if (!EMAIL_HMAC_SECRET) missing.push('EMAIL_HMAC_SECRET');
  if (!/^https:\/\/[^\s/?#@]+$/i.test(EMAIL_PUBLIC_BASE_URL)) missing.push('EMAIL_PUBLIC_BASE_URL');
  return { enabled, configured: enabled && missing.length === 0, missing };
}

/** Postmark supplies RFC 8058 headers and provider-side suppression on its managed broadcast stream. */
export async function deliverProductUpdate(to: string, params: EmailParams, signal: AbortSignal, subject?: string): Promise<string> {
  if (!broadcastReadiness().configured || !singleMailbox(to)) throw new Error('Invalid broadcast configuration or recipient');
  const { stream, token, from } = configuration();
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token };
  const response = await fetch(`${API}/message-streams/${encodeURIComponent(stream)}`, { headers, signal, redirect: 'error' });
  if (!response.ok) throw new Error(`Postmark stream verification failed (HTTP ${response.status})`);
  const info = await response.json();
  if (info.ID !== stream || info.MessageStreamType !== 'Broadcasts' || info.ArchivedAt !== null ||
      info.SubscriptionManagementConfiguration?.UnsubscribeHandlingType !== 'Postmark') {
    throw new Error('Postmark requires an active Broadcast stream with Postmark-managed unsubscribes');
  }

  const rendered = renderEmail('product-update', params, {
    appUrl: APP_PUBLIC_URL,
    companyName: process.env.COMPANY_NAME,
    companyAddress: process.env.COMPANY_ADDRESS,
    supportEmail: process.env.SUPPORT_EMAIL,
    logoUrl: process.env.LOGO_URL
  });
  const send = await fetch(`${API}/email`, {
    method: 'POST', headers, signal, redirect: 'error',
    body: JSON.stringify({
      From: from, To: to, Subject: subject || rendered.subject, HtmlBody: rendered.html,
      TextBody: rendered.text, MessageStream: stream, TrackOpens: false, TrackLinks: 'None'
    })
  });
  const delivery = await send.json().catch(() => null);
  if (!send.ok || delivery?.ErrorCode !== 0 || !delivery.MessageID) {
    throw new Error(`Postmark rejected delivery (HTTP ${send.status}, code ${Number(delivery?.ErrorCode) || 'unknown'})`);
  }
  return delivery.MessageID;
}
