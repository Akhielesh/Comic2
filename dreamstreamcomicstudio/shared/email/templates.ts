// The actual transactional email designs. Each renderer returns a subject, an inbox
// preheader, the inner card HTML (built from the layout helpers), and a matching plain-text
// body. A single `renderEmail()` wraps that content in the branded shell and centralises the
// cross-cutting concerns so individual templates stay clean and uncluttered:
//   • unsubscribe + "why am I getting this" notice (marketing mail only),
//   • a "required notice" line (essential mail — never unsubscribable),
//   • a read-receipt pixel (when the caller supplies one).
//
// Dynamic values arrive as a flat string map, so the same renderer works whether it's called
// by the Worker (/send), the Supabase auth hook, or the preview script. Always wrap dynamic
// values with escapeHtml on the HTML side.

import { BrandConfig, COLORS, resolveBrand } from './theme.js';
import { MAIN_ORIGIN, isStreamUrl, streamAppHref } from '../streamHost.js';
import { COMICS_ORIGIN, comicsEntryUrl } from '../../services/productHost.js';
import {
  button,
  codeBadge,
  comicSample,
  escapeHtml,
  heading,
  infoBox,
  linkFallback,
  muted,
  paragraph,
  safeUrl,
  wrapHtml
} from './layout.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type EmailParams = Record<string, string | undefined>;

export type EmailTemplateName =
  | 'newsletter-confirm'
  | 'newsletter-welcome'
  | 'product-update'
  | 'announcement'
  | 'beta-invite'
  | 'studio-invite'
  | 'access-requested'
  | 'welcome'
  | 'signin-alert'
  | 'auth-confirm-signup'
  | 'auth-magic-link'
  | 'auth-recovery'
  | 'auth-email-change'
  | 'auth-reauthentication'
  | 'auth-invite'
  | 'auth-security-notice';

/**
 * Essential = a required account / security / transactional notice. These are NEVER
 * unsubscribable and bypass the marketing suppression list + cost-throttle's marketing rules.
 * Marketing = opt-in updates. These carry a working unsubscribe and honor suppression.
 */
export const RECEIPT_TEMPLATES: readonly EmailTemplateName[] = [
  'announcement', 'access-requested', 'beta-invite', 'studio-invite', 'welcome', 'newsletter-welcome'
];

export type EmailKind = 'essential' | 'marketing';

export const TEMPLATE_KIND: Record<EmailTemplateName, EmailKind> = {
  'newsletter-confirm': 'essential', // a double opt-in confirm is transactional (they just asked)
  'newsletter-welcome': 'marketing',
  'product-update': 'marketing',
  // Admin-composed product/account notice (no unsubscribe). For promotional blasts, use the
  // marketing `product-update` template instead so recipients get a working unsubscribe.
  announcement: 'essential',
  // A one-to-one beta invite/referral someone deliberately sends — transactional, not a list.
  'beta-invite': 'essential',
  // One-to-one onboarding to a standalone studio (Stream Studio today).
  'studio-invite': 'essential',
  'access-requested': 'essential',
  welcome: 'essential',
  'signin-alert': 'essential',
  'auth-confirm-signup': 'essential',
  'auth-magic-link': 'essential',
  'auth-recovery': 'essential',
  'auth-email-change': 'essential',
  'auth-reauthentication': 'essential',
  'auth-invite': 'essential',
  // Supabase security notifications (password/email/phone changed, sign-in method or 2-step
  // method added/removed) — required account-security mail.
  'auth-security-notice': 'essential'
};

export const EMAIL_TEMPLATE_NAMES = Object.keys(TEMPLATE_KIND) as EmailTemplateName[];

export const isEmailTemplateName = (value: unknown): value is EmailTemplateName =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATE_KIND, value);

export const isMarketing = (name: EmailTemplateName): boolean => TEMPLATE_KIND[name] === 'marketing';

/**
 * Which role mailbox a template sends FROM. Lets each kind of mail come from a fitting
 * sender so replies + filtering make sense, and automated mail is clearly no-reply:
 *   - 'no-reply'      → fully automated links/codes (auth, double-opt-in). Shows a don't-reply notice.
 *   - 'notifications' → transactional notices + updates. Replies route to support.
 *   - 'hello'         → warm, human-feeling mail (welcome, invites). Replies route to support.
 */
export type SenderRole = 'no-reply' | 'notifications' | 'hello';

export const SENDER_ROLE: Record<EmailTemplateName, SenderRole> = {
  'newsletter-confirm': 'no-reply',
  'newsletter-welcome': 'notifications',
  'product-update': 'notifications',
  announcement: 'notifications',
  'beta-invite': 'hello',
  'studio-invite': 'hello',
  'access-requested': 'notifications',
  welcome: 'hello',
  'signin-alert': 'notifications',
  'auth-confirm-signup': 'no-reply',
  'auth-magic-link': 'no-reply',
  'auth-recovery': 'no-reply',
  'auth-email-change': 'no-reply',
  'auth-reauthentication': 'no-reply',
  'auth-invite': 'no-reply',
  // Like signin-alert: the copy says "contact support", so replies should reach a human.
  'auth-security-notice': 'notifications'
};

export const senderRoleFor = (name: EmailTemplateName): SenderRole => SENDER_ROLE[name];
export const isNoReply = (name: EmailTemplateName): boolean => SENDER_ROLE[name] === 'no-reply';

interface TemplateOutput {
  subject: string;
  preheader: string;
  content: string;
  text: string;
}

type Renderer = (params: EmailParams, brand: BrandConfig) => TemplateOutput;

const greetName = (params: EmailParams): string => {
  const name = (params.firstName || params.name || '').trim();
  return name ? `Hello ${escapeHtml(name)},` : 'Hello,';
};
const greetNameText = (params: EmailParams): string => {
  const name = (params.firstName || params.name || '').trim();
  return name ? `Hello ${name},` : 'Hello,';
};

/**
 * Turn admin-typed plain text (the structured composer's body) into safe paragraph HTML:
 * blank lines split paragraphs, single newlines become <br>. Everything is escaped — no raw
 * HTML is ever trusted from the composer.
 */
const textToParagraphs = (text: string): string =>
  String(text || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => paragraph(escapeHtml(block).replace(/\n/g, '<br/>')))
    .join('');

// The same copy and destination are used for the HTML and plain-text versions.
const newsletterConfirm: Renderer = (params, brand) => {
  const url = params.confirmUrl && safeUrl(params.confirmUrl) !== '#' ? params.confirmUrl : undefined;
  const intro = `Someone requested ${brand.productName} updates for this address. Confirm below if you would like to subscribe.`;
  const ignore = 'If you didn’t request updates, you can leave this message unanswered. Your subscription requires confirmation.';
  const missing = 'The confirmation link is missing. Submit the subscription form again to request a new one.';
  return {
    subject: `Confirm your subscription to ${brand.productName}`,
    preheader: 'One step remains before you can receive product updates.',
    content: heading('Confirm your subscription') + paragraph(greetName(params)) + paragraph(escapeHtml(intro)) +
      (url ? button('Confirm subscription', url) + linkFallback(url) : paragraph(missing)) + muted(ignore),
    text: [greetNameText(params), intro, url ? `Confirm subscription: ${url}` : missing, ignore].join('\n\n')
  };
};

const newsletterWelcome: Renderer = (params, brand) => {
  const intro = `Your subscription to ${brand.productName} product updates is confirmed.`;
  return {
    subject: `Subscription confirmed — ${brand.productName}`,
    preheader: 'You are subscribed to product updates.',
    content: heading('Subscription confirmed') + paragraph(greetName(params)) + paragraph(escapeHtml(intro)) +
      button('Visit the studio', brand.appUrl),
    text: [greetNameText(params), intro, `Visit the studio: ${brand.appUrl}`].join('\n\n')
  };
};

const productUpdate: Renderer = (params, brand) => {
  const title = params.title || `Product update from ${brand.productName}`;
  const body = params.body || (params.bodyHtml ? htmlToText(params.bodyHtml) : `The latest product news is available at ${brand.productName}.`);
  const cta = params.ctaUrl || brand.appUrl;
  const label = params.ctaLabel || 'Read the update';
  return {
    subject: params.subject || title,
    preheader: params.preheader || title,
    content: heading(title) + (params.bodyHtml || textToParagraphs(body)) + button(label, cta),
    text: [title, body, `${label}: ${cta}`].join('\n\n')
  };
};

const announcement: Renderer = (params, brand) => {
  const title = params.heading || `A notice from ${brand.productName}`;
  const cta = params.ctaUrl && params.ctaLabel;
  return {
    subject: params.subject || title,
    preheader: params.preheader || title,
    content: heading(title) + (params.firstName ? paragraph(greetName(params)) : '') +
      textToParagraphs(params.body || '') + (cta ? button(cta, params.ctaUrl!) + linkFallback(params.ctaUrl!) : ''),
    text: [title, params.firstName ? greetNameText(params) : '', params.body, cta ? `${cta}: ${params.ctaUrl}` : ''].filter(Boolean).join('\n\n')
  };
};

export type StudioInviteId = 'stream_studio' | 'comic_studio' | 'chat_studio';

const STUDIO_INVITES = {
  stream_studio: { name: 'Stream Studio', path: '/live.html', description: 'Host a live broadcast, manage the room and share the viewing link.' },
  comic_studio: { name: 'Comic Studio', path: '/', description: 'Start with a story, review your page plan and edit the artwork and lettering before sharing.' },
  chat_studio: { name: 'Chat Studio', path: '/', description: 'Start a conversation, choose an available model and return to your saved chats.' }
} as const;

export const isStudioInviteId = (value: unknown): value is StudioInviteId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(STUDIO_INVITES, value);
export const STUDIO_INVITE_IDS = ['stream_studio', 'comic_studio', 'chat_studio'] as const satisfies readonly StudioInviteId[];

export const parseStudioIds = (value: string | undefined): StudioInviteId[] =>
  [...new Set(String(value || '').split(/[\s,;]+/).filter(isStudioInviteId))];

const joinNames = (names: string[]): string =>
  names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const betaInvite: Renderer = (params, brand) => {
  const chosen = parseStudioIds(params.studios);
  const studios = joinNames(chosen.map(id => STUDIO_INVITES[id].name));
  const target = studios || `the ${brand.productName} beta`;
  const inviter = params.inviterName?.trim();
  const intro = inviter ? `${inviter} invited you to ${target}.` : `You have been invited to ${target}.`;
  const url = params.inviteUrl || (params.code ? `${brand.appUrl.replace(/\/+$/, '')}/?invite=${encodeURIComponent(params.code)}` : undefined);
  const next = 'Open the invitation, then sign in to your existing account or create an account to claim access.';
  const recovery = 'If the invitation has expired or the link is missing, ask the sender for a new invitation.';
  const code = params.code ? `Invitation code: ${params.code}` : '';
  const note = params.personalNote?.trim();
  return {
    subject: inviter ? `${inviter} invited you to ${studios || brand.productName}${studios ? ` — ${brand.productName}` : ''}` : `You're invited to ${target}${studios ? ` — ${brand.productName}` : ''}`,
    preheader: 'Use your invitation to claim access.',
    content: heading('Your beta invitation') + paragraph(escapeHtml(intro)) + (note ? infoBox(escapeHtml(note)) : '') +
      (url ? paragraph(next) + button('Accept invitation', url) + linkFallback(url) : '') +
      (code ? muted(escapeHtml(code)) : '') +
      chosen.map(id => paragraph(`<strong>${STUDIO_INVITES[id].name}</strong><br/>${STUDIO_INVITES[id].description}`)).join('') + muted(recovery),
    text: [intro, note, url ? next : '', url ? `Accept invitation: ${url}` : '', code,
      ...chosen.map(id => `${STUDIO_INVITES[id].name}: ${STUDIO_INVITES[id].description}`), recovery].filter(Boolean).join('\n\n')
  };
};

/** Only the production suite front page maps to Comic Studio. Preserve invite tokens and preview hosts. */
const comicEntry = (address: string): string => {
  try {
    const url = new URL(address);
    if (url.pathname === '/' && !url.search && !url.hash) return comicsEntryUrl(url.hostname) || address;
  } catch {
    // The layout handles invalid destinations.
  }
  return address;
};

const comicPage = (appUrl: string, path: string): string => {
  try {
    const base = new URL(comicEntry(appUrl));
    if (base.protocol === 'https:' || base.protocol === 'http:') return new URL(path, base).href;
  } catch {
    // Fall back to the canonical product when the configured origin is unavailable.
  }
  return new URL(path, COMICS_ORIGIN).href;
};

// The admin sends this after granting a studio to an existing account.
const studioInvite: Renderer = (params, brand) => {
  const studio = STUDIO_INVITES[isStudioInviteId(params.studio) ? params.studio : 'stream_studio'];
  const name = params.studioName?.trim() || studio.name;
  const destination = params.inviteUrl || (studio.path === '/' ? brand.appUrl : streamAppHref(`${brand.appUrl.replace(/\/+$/, '')}${studio.path}`));
  const url = params.studio === 'comic_studio' ? comicEntry(destination) : destination;
  const intro = `Your account now has access to ${name}. Sign in with the account that received this message.`;
  const note = params.personalNote?.trim();
  const label = `Open ${name}`;
  return {
    subject: params.inviterName ? `${params.inviterName} invited you to ${name} — ${brand.productName}` : `You're invited to ${name}`,
    preheader: `${name} is ready to use with your existing account.`,
    content: heading(`Access to ${name}`) + paragraph(greetName(params)) + paragraph(escapeHtml(intro)) +
      (note ? infoBox(escapeHtml(note)) : '') + button(label, url) + linkFallback(url) + paragraph(studio.description),
    text: [greetNameText(params), intro, note, `${label}: ${url}`, studio.description].filter(Boolean).join('\n\n')
  };
};

const accessRequested: Renderer = (params, brand) => {
  const receipt = 'We recorded your interest in Comic Studio. Choose Sign up on the Comic Studio home page when you’re ready to create your account.';
  const returning = 'Already a member?';
  const memberLink = comicPage(brand.appUrl, '/?view=dashboard');
  return {
    subject: 'Comic Studio interest registration received',
    preheader: 'Your interest is recorded. No further action is required.',
    content: heading('Your interest is recorded') + paragraph(greetName(params)) + paragraph(receipt) +
      paragraph(`${returning} <a class="ds-link" href="${escapeHtml(memberLink)}" style="color:${COLORS.ink};text-decoration:underline;">Sign in to open your comics</a>.`) +
      muted('If you didn’t submit this request, no action is required.'),
    text: [greetNameText(params), receipt, `${returning} Sign in to open your comics: ${memberLink}`, 'If you didn’t submit this request, no action is required.'].join('\n\n')
  };
};

const welcome: Renderer = (params, brand) => {
  const cta = params.ctaUrl || brand.appUrl;
  const intro = 'Your account is ready. Sign in to see the studios available to you.';
  return {
    subject: `Welcome to ${brand.productName}`,
    preheader: 'Sign in and open your workspace.',
    content: heading(`Welcome to ${brand.productName}`) + paragraph(greetName(params)) + paragraph(intro) +
      button('Open your workspace', cta) + linkFallback(cta) + muted(`For help getting started, contact ${escapeHtml(brand.supportEmail)}.`),
    text: [greetNameText(params), intro, `Open your workspace: ${cta}`, `For help getting started, contact ${brand.supportEmail}.`].join('\n\n')
  };
};

/** Account security lives in the suite. The standalone Stream host opens the main account page. */
const securitySettingsUrl = (brand: BrandConfig): string => {
  const base = isStreamUrl(brand.appUrl) ? MAIN_ORIGIN : brand.appUrl;
  try {
    return new URL('/?view=settings&tab=security', base).href;
  } catch {
    return `${MAIN_ORIGIN}/?view=settings&tab=security`;
  }
};

const signinAlert: Renderer = (params, brand) => {
  const intro = `There was a new sign-in to your ${brand.productName} account.`;
  const details = [
    ['Time', params.time], ['Device', params.device], ['Approximate location', params.location], ['IP address', params.ip]
  ].filter((entry): entry is [string, string] => Boolean(entry[1])).map(([label, value]) => `${label}: ${value}`);
  const url = params.secureUrl || securitySettingsUrl(brand);
  const next = 'If you recognize this sign-in, no action is needed. If you don’t, review your account security and change your password.';
  return {
    subject: `New sign-in to your ${brand.productName} account`,
    preheader: 'Review this sign-in and take action if it was unexpected.',
    content: heading('New sign-in') + paragraph(escapeHtml(intro)) + (details.length ? infoBox(details.map(escapeHtml).join('<br/>')) : '') +
      paragraph(next) + button('Review your account', url) + linkFallback(url) + muted(`If you cannot sign in, contact ${escapeHtml(brand.supportEmail)}.`),
    text: [intro, details.join('\n'), next, `Review your account: ${url}`, `If you cannot sign in, contact ${brand.supportEmail}.`].filter(Boolean).join('\n\n')
  };
};

// ── Supabase auth-hook templates (link- or code-based) ──────────────────────────
// Plain-text twin of a small inline-HTML string (tags stripped, the few entities we emit decoded).
const htmlToText = (html: string): string =>
  html
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const authLink = (
  opts: {
    subjectVerb: string;
    title: string;
    intro: string;
    cta: string;
    variant?: 'yellow' | 'blue';
    preheader: string;
    /** Extra safe-HTML line under the code (e.g. "we also emailed your other address"). */
    note?: string;
    /** Replaces the default "didn't request it? ignore this email" line. */
    ignoreLine?: string;
    recovery?: string;
  },
  params: EmailParams,
  brand: BrandConfig
): TemplateOutput => {
  const url = params.actionUrl && safeUrl(params.actionUrl) !== '#' ? params.actionUrl : undefined;
  const recovery = opts.recovery ?? 'If the link has expired, start the request again to get a new link.';
  const ignore = opts.ignoreLine ?? 'If you didn’t request this, you can ignore this message. Keep the link and any verification code private.';
  const missing = 'This message is missing its action link.';
  return {
    subject: `${opts.subjectVerb} — ${brand.productName}`,
    preheader: opts.preheader,
    content: heading(opts.title) + paragraph(opts.intro) +
      (url ? button(opts.cta, url, opts.variant ?? 'blue') + linkFallback(url) : paragraph(missing)) +
      (params.token ? muted(`If the app asks for a code, enter <strong>${escapeHtml(params.token)}</strong>.`) : '') +
      (opts.note ? infoBox(opts.note) : '') + muted(recovery) + muted(ignore),
    text: [htmlToText(opts.intro), url ? `${opts.cta}: ${url}` : missing,
      params.token ? `Verification code: ${params.token}` : '', opts.note ? htmlToText(opts.note) : '',
      recovery, ignore].filter(Boolean).join('\n\n')
  };
};

const authConfirmSignup: Renderer = (params, brand) =>
  authLink(
    {
      subjectVerb: 'Confirm your email',
      title: 'Confirm your email',
      intro: `Welcome to ${escapeHtml(brand.productName)}! Confirm your email address to activate your account.`,
      cta: 'Confirm email',
      variant: 'yellow',
      preheader: 'Confirm your email to activate your account.',
      recovery: 'If the link has expired, request another confirmation from the sign-in page.'
    },
    params,
    brand
  );

// Magic link, or (params.codeFirst — Supabase's `email` OTP action) a code-first variant:
// the 6-digit code is the hero and the one-tap link is the backup.
const authMagicLink: Renderer = (params, brand) => {
  if (!params.codeFirst || !params.token) {
    return authLink(
      {
        subjectVerb: 'Your sign-in link',
        title: 'Sign in to your account',
        intro: `Use this personal link to sign in to ${escapeHtml(brand.productName)}.`,
        cta: 'Sign in',
        preheader: 'Open the link to sign in without a password.'
      },
      params,
      brand
    );
  }
  const url = params.actionUrl && safeUrl(params.actionUrl) !== '#' ? params.actionUrl : undefined;
  return {
    subject: `Your sign-in code — ${brand.productName}`,
    preheader: 'Your sign-in code is inside.',
    content:
      heading('Your sign-in code') +
      paragraph(`Enter this code in ${escapeHtml(brand.productName)} to sign in:`) +
      codeBadge(params.token) +
      (url ? button('Use sign-in link', url) + linkFallback(url) : '') +
      muted("Keep this code private. If it expires, request a new code from the sign-in screen. If you didn’t request it, no action is required."),
    text: [
      `Enter this code in ${brand.productName} to sign in:`,
      '',
      params.token,
      '',
      url ? `Use sign-in link: ${url}` : '',
      '',
      "Keep this code private. If it expires, request a new code from the sign-in screen. If you didn’t request it, no action is required."
    ].join('\n')
  };
};

const authRecovery: Renderer = (params, brand) =>
  authLink(
    {
      subjectVerb: 'Reset your password',
      title: 'Reset your password',
      intro: `We received a request to reset your ${escapeHtml(brand.productName)} password. Open the reset link to choose a new password.`,
      cta: 'Reset password',
      preheader: 'Choose a new password using this reset link.',
      recovery: 'If this link has expired, choose Forgot password? on the sign-in page to request another.'
    },
    params,
    brand
  );

// Email change. `emailChangeStep` picks the recipient's side: 'new' (default — confirm the new
// address) or 'current' (Secure Email Change: approve the change from the address on file).
// `bothRequired` = Secure Email Change is on, so the change lands only once BOTH links are used.
const authEmailChange: Renderer = (params, brand) => {
  const product = escapeHtml(brand.productName);
  const newEmail = params.newEmail ? `<strong>${escapeHtml(params.newEmail)}</strong>` : 'a new address';
  if (params.emailChangeStep === 'current') {
    return authLink(
      {
        subjectVerb: 'Approve your email change',
        title: 'Approve your email change',
        intro: `A request was made to change the email on your ${product} account to ${newEmail}. Approve it here if you recognize the new address.`,
        cta: 'Approve change',
        preheader: 'Approve the email change on your account.',
        note: params.bothRequired
          ? 'We also sent a link to the new address — the change completes once both links are confirmed.'
          : undefined,
        ignoreLine: "If you didn’t request this change, leave it unapproved and review your account security directly in the app."
      },
      params,
      brand
    );
  }
  return authLink(
    {
      subjectVerb: 'Confirm your new email',
      title: 'Confirm your new email',
      intro: params.newEmail
        ? `Confirm changing your ${product} email to ${newEmail}.`
        : `Confirm your new email address for ${product}.`,
      cta: 'Confirm new email',
      preheader: 'Confirm your new email address.',
      note: params.bothRequired
        ? `For your security we also sent a link to ${
            params.currentEmail ? `<strong>${escapeHtml(params.currentEmail)}</strong>` : 'your current address'
          } — the change completes once both links are confirmed.`
        : undefined
    },
    params,
    brand
  );
};

const authInvite: Renderer = (params, brand) =>
  authLink(
    {
      subjectVerb: "You're invited",
      title: 'Your account invitation',
      intro: `You've been invited to join ${escapeHtml(brand.productName)}. Accept your invite to set up your account.`,
      cta: 'Accept invite',
      variant: 'yellow',
      preheader: `Accept your invite to ${brand.productName}.`,
      recovery: 'If the invitation has expired, ask the sender to issue a new one.'
    },
    params,
    brand
  );

const authReauthentication: Renderer = (params, brand) => {
  const intro = `Return to ${brand.productName} and enter this code where you were asked to verify your identity.`;
  const missing = 'This message is missing its verification code. Request a new one in the app.';
  const safety = 'Keep the code private. If it expires, request a new one. If you didn’t start this action, leave the request unanswered.';
  return {
    subject: `Your verification code — ${brand.productName}`,
    preheader: 'Verify your identity to continue the action you started.',
    content: heading('Verify your identity') + (params.token ? paragraph(escapeHtml(intro)) + codeBadge(params.token) : paragraph(missing)) + muted(safety),
    text: [params.token ? intro : missing, params.token, safety].filter(Boolean).join('\n\n')
  };
};

// ── Supabase security notifications (password/email/phone changed, sign-in or 2-step method
// linked/removed). One concise template; `notice` is the action type minus `_notification`.
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  azure: 'Microsoft',
  facebook: 'Facebook',
  discord: 'Discord',
  twitter: 'X (Twitter)',
  linkedin_oidc: 'LinkedIn',
  email: 'Email & password',
  phone: 'Phone'
};
const FACTOR_LABELS: Record<string, string> = { totp: 'authenticator app', phone: 'phone number (SMS)', webauthn: 'security key or passkey' };

const providerLabel = (provider?: string): string => {
  const p = (provider || '').trim();
  if (!p) return 'A sign-in provider';
  return PROVIDER_LABELS[p.toLowerCase()] || p.charAt(0).toUpperCase() + p.slice(1);
};
const factorLabel = (factor?: string): string => {
  const f = (factor || '').trim();
  return f ? FACTOR_LABELS[f.toLowerCase()] || f : 'verification method';
};

/** Subject + heading + one-line summary (plain text — escaped where it lands in HTML). */
const securityNoticeCopy = (params: EmailParams, product: string): { subject: string; title: string; summary: string } => {
  const from = (v?: string) => (v ? ` from ${v}` : '');
  const to = (v?: string) => (v ? ` to ${v}` : '');
  switch (params.notice) {
    case 'password_changed':
      return { subject: 'Your password was changed', title: 'Password changed', summary: `The password for your ${product} account was just changed.` };
    case 'email_changed':
      return {
        subject: 'Your account email was changed',
        title: 'Email address changed',
        summary: `The email on your ${product} account was changed${from(params.oldEmail)}${to(params.newEmail)}.`
      };
    case 'phone_changed':
      return {
        subject: 'Your phone number was changed',
        title: 'Phone number changed',
        summary: `The phone number on your ${product} account was changed${from(params.oldPhone)}${to(params.phone)}.`
      };
    case 'identity_linked':
      return {
        subject: 'A new sign-in method was linked',
        title: 'Sign-in method added',
        summary: `${providerLabel(params.provider)} was linked as a new way to sign in to your ${product} account.`
      };
    case 'identity_unlinked':
      return {
        subject: 'A sign-in method was removed',
        title: 'Sign-in method removed',
        summary: `${providerLabel(params.provider)} can no longer be used to sign in to your ${product} account.`
      };
    case 'mfa_factor_enrolled':
      return {
        subject: 'A 2-step verification method was added',
        title: '2-step method added',
        summary: `A new ${factorLabel(params.factorType)} was added to your ${product} account's 2-step verification.`
      };
    case 'mfa_factor_unenrolled':
      return {
        subject: 'A 2-step verification method was removed',
        title: '2-step method removed',
        summary: `A ${factorLabel(params.factorType)} was removed from your ${product} account's 2-step verification.`
      };
    default:
      return {
        subject: 'Your account security settings changed',
        title: 'Account updated',
        summary: `A security setting on your ${product} account was just changed.`
      };
  }
};

const authSecurityNotice: Renderer = (params, brand) => {
  const copy = securityNoticeCopy(params, brand.productName);
  const secureUrl = params.secureUrl || securitySettingsUrl(brand);
  const details = [
    params.email ? `<strong>Account:</strong> ${escapeHtml(params.email)}` : '',
    params.time ? `<strong>When:</strong> ${escapeHtml(params.time)}` : '',
    params.ip ? `<strong>IP:</strong> ${escapeHtml(params.ip)}` : ''
  ]
    .filter(Boolean)
    .join('<br/>');
  const support = escapeHtml(brand.supportEmail);
  return {
    subject: `${copy.subject} — ${brand.productName}`,
    preheader: 'Review the change to your account security.',
    content:
      heading(copy.title) +
      paragraph(greetName(params)) +
      paragraph(escapeHtml(copy.summary)) +
      (details ? infoBox(details) : '') +
      paragraph('If you made this change, no action is needed.') +
      paragraph(
        `<strong>Don’t recognize this change?</strong> Review your account security and contact <a href="mailto:${support}" style="color:${COLORS.blueDark};">${support}</a>.`
      ) +
      button('Review your account', secureUrl, 'blue') + linkFallback(secureUrl),
    text: [
      greetNameText(params),
      '',
      copy.summary,
      ...[
        params.email ? `Account: ${params.email}` : '',
        params.time ? `When: ${params.time}` : '',
        params.ip ? `IP: ${params.ip}` : ''
      ].filter(Boolean),
      '',
      'If this was you, no action is needed.',
      `If not, secure your account: ${secureUrl} — and tell us at ${brand.supportEmail}.`
    ].join('\n')
  };
};

const RENDERERS: Record<EmailTemplateName, Renderer> = {
  'newsletter-confirm': newsletterConfirm,
  'newsletter-welcome': newsletterWelcome,
  'product-update': productUpdate,
  announcement,
  'beta-invite': betaInvite,
  'studio-invite': studioInvite,
  'access-requested': accessRequested,
  welcome,
  'signin-alert': signinAlert,
  'auth-confirm-signup': authConfirmSignup,
  'auth-magic-link': authMagicLink,
  'auth-recovery': authRecovery,
  'auth-email-change': authEmailChange,
  'auth-reauthentication': authReauthentication,
  'auth-invite': authInvite,
  'auth-security-notice': authSecurityNotice
};

/**
 * Render a named template to {subject, html, text}, applying the brand and centrally wiring
 * the unsubscribe/essential/read-receipt concerns. Throws on an unknown name.
 *
 * Recognised params (all optional, per template): confirmUrl, actionUrl, ctaUrl, secureUrl,
 * unsubscribeUrl (marketing only), pixelUrl, firstName, token, newEmail, time, device,
 * location, ip, title, body, bodyHtml, subject. Auth-hook extras: codeFirst (auth-magic-link),
 * emailChangeStep / currentEmail / bothRequired (auth-email-change), notice / email / oldEmail /
 * oldPhone / phone / provider / factorType (auth-security-notice).
 */
// Receipt controls never turn authentication or marketing campaign templates into tracking surfaces.
const safeReceiptUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
};

export const renderEmail = (
  name: EmailTemplateName,
  params: EmailParams = {},
  brandOverrides?: Partial<BrandConfig>
): RenderedEmail => {
  const renderer = RENDERERS[name];
  if (!renderer) throw new Error(`Unknown email template: ${name}`);
  const brand = resolveBrand(brandOverrides);
  const out = renderer(params, brand);
  const marketing = isMarketing(name);

  const noReply = isNoReply(name);
  const reasons: Partial<Record<EmailTemplateName, string>> = {
    announcement: `This service notice was sent by ${brand.productName}.`,
    'access-requested': 'You received this receipt because this address was submitted on the Comic Studio interest form.',
    'newsletter-confirm': 'You received this message because someone requested product updates for this address.',
    'beta-invite': 'You received this invitation because the sender selected this address.',
    'auth-invite': 'You received this invitation because the sender selected this address.'
  };
  const footerNotice = marketing ? `You subscribed to ${brand.productName} updates.` : reasons[name] ?? `This is a required ${brand.productName} account notification.`;
  const granted = name === 'beta-invite' ? parseStudioIds(params.studios) : [];
  let studio: StudioInviteId | undefined;
  if (name === 'access-requested') studio = 'comic_studio';
  if (name === 'studio-invite') studio = isStudioInviteId(params.studio) ? params.studio : 'stream_studio';
  if (granted.length === 1) studio = granted[0];
  // Masthead and footer links open the studio they name. Explicit worker brands and custom destinations take priority.
  let shellBrand = brand;
  if (brand.productName === 'DreamStream Studio' && brand.appUrl.replace(/\/+$/, '') === MAIN_ORIGIN && studio) {
    const homes = {
      comic_studio: comicEntry(brand.appUrl),
      stream_studio: streamAppHref(MAIN_ORIGIN + '/live.html'),
      chat_studio: MAIN_ORIGIN + '/?view=chat'
    };
    shellBrand = { ...brand, appUrl: homes[studio] };
  }
  const comicBrand = brand.productName === 'Comic Studio';
  const suiteBrand = brand.productName === 'DreamStream Studio';
  const comicGrant = (suiteBrand || comicBrand) && name === 'studio-invite' && params.studio === 'comic_studio';
  const confirmationLink = name === 'newsletter-confirm' ? params.confirmUrl : name === 'auth-confirm-signup' ? params.actionUrl : undefined;
  const showSample = ((suiteBrand || comicBrand) && (name === 'access-requested' || name === 'welcome'))
    || comicGrant || (comicBrand && (name === 'newsletter-welcome' || (confirmationLink && safeUrl(confirmationLink) !== '#')));
  if (showSample) {
    // Only the studio grant notice is evidence of creator access. Reading the bundled sample needs no grant.
    if (comicGrant) {
      const images = comicPage(shellBrand.appUrl, '/?view=images');
      out.content += paragraph(`To try a single scene before a whole comic, <a class="ds-link" href="${escapeHtml(images)}" style="color:${COLORS.ink};text-decoration:underline;">open the image workspace</a> and describe the first frame.`);
      out.text += `\n\nTo try a single scene before a whole comic, open the image workspace and describe the first frame: ${images}`;
    }
    const reader = comicPage(shellBrand.appUrl, '/?view=gallery&sample=last-tram');
    const headline = 'The Last Tram';
    const story = 'A traveler boards the last tram along the coast. Turn the page to follow a paper boat out into the moonlit harbor. This two-page comic is open to everyone.';
    out.content += comicSample(reader, headline, story);
    out.text += `\n\n${headline}\n${story}\nRead both pages of The Last Tram: ${reader}`;
  }
  const html = wrapHtml({
    brand: shellBrand,
    studio,
    preheader: out.preheader,
    content: out.content,
    unsubscribeUrl: marketing ? params.unsubscribeUrl : undefined,
    essential: !marketing,
    footerNotice,
    ackUrl: RECEIPT_TEMPLATES.includes(name) ? safeReceiptUrl(params.ackUrl) : undefined,
    pixelUrl: RECEIPT_TEMPLATES.includes(name) ? safeReceiptUrl(params.pixelUrl) : undefined,
    noReply
  });

  // Plain-text footer mirrors the HTML one (sign-off + unsubscribe / required notice + reply policy).
  const textFooter = [
    brand.productName,
    footerNotice,
    RECEIPT_TEMPLATES.includes(name) && safeReceiptUrl(params.ackUrl) ? `Acknowledge this message (optional): ${safeReceiptUrl(params.ackUrl)}` : '',
    marketing && params.unsubscribeUrl ? `Unsubscribe: ${params.unsubscribeUrl}` : '',
    noReply ? "This mailbox isn't monitored. Please don't reply." : '',
    `Get help: ${brand.supportEmail}`
  ].filter(Boolean).join('\n');

  return { subject: out.subject, html, text: `${out.text}\n\n${textFooter}` };
};

export { safeUrl };
