// Admin-only client for the Email Console (/api/admin/email/*). Mirrors the server shapes in
// server/src/routes/adminEmail.ts. Previews render server-side; sends go through the mailer.

import { get, post } from './apiClient';

export interface EmailTemplateInfo {
  name: string;
  kind: 'essential' | 'marketing';
  composable: boolean;
}

export interface EmailPreview {
  subject: string;
  html: string;
  text: string;
  kind: string;
}

export interface EmailUsage {
  configured: boolean;
  day: number;
  month: number;
  maxPerDay: number;
  maxPerMonth: number;
  dayPct: number;
  monthPct: number;
  freeTierRemaining: number;
}

export interface EmailLogRow {
  id: string;
  to_email: string;
  template: string;
  kind: string;
  status: string;
  message_id?: string | null;
  error?: string | null;
  opened_at?: string | null;
  created_at: string;
}

export interface SendOutcome {
  to: string;
  ok: boolean;
  messageId?: string;
  skipped?: string;
  error?: string;
}

type Params = Record<string, string | undefined>;

export const listEmailTemplates = (): Promise<{ configured: boolean; templates: EmailTemplateInfo[] }> =>
  get('/api/admin/email/templates');

export const previewEmail = (template: string, params: Params): Promise<EmailPreview> =>
  post('/api/admin/email/preview', { template, params });

export const sendTestEmail = (template: string, params: Params): Promise<SendOutcome> =>
  post('/api/admin/email/test', { template, params });

export const sendEmailBroadcast = (
  template: string,
  params: Params,
  to: string
): Promise<{ requested: number; sent: number; results: SendOutcome[] }> =>
  post('/api/admin/email/send', { template, params, to });

export const adminInviteByEmail = (
  email: string,
  opts: {
    personalNote?: string;
    inviterName?: string;
    maxUses?: number;
    expiresInDays?: number;
    /** Studio ids the invite unlocks. A proper subset confines the redeemed account; all (or none) = full access. */
    products?: string[];
  } = {}
): Promise<{
  code: string;
  inviteUrl: string;
  email: string;
  ok: boolean;
  /** Studios featured in the email (the chosen ones, or all when full access). */
  products?: string[];
  /** True when redeeming this invite confines the account to the chosen studios. */
  confined?: boolean;
  error?: string;
  skipped?: string;
}> => post('/api/admin/email/invite', { email, ...opts });

export const getEmailUsage = (): Promise<EmailUsage> => get('/api/admin/email/usage');

export const getEmailLog = (limit = 50): Promise<{ items: EmailLogRow[] }> =>
  get(`/api/admin/email/log?limit=${limit}`);
