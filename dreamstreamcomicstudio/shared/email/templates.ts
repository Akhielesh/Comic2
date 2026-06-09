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

import { BrandConfig, resolveBrand } from './theme.js';
import {
  button,
  codeBadge,
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
  | 'access-requested'
  | 'welcome'
  | 'signin-alert'
  | 'auth-confirm-signup'
  | 'auth-magic-link'
  | 'auth-recovery'
  | 'auth-email-change'
  | 'auth-reauthentication'
  | 'auth-invite';

/**
 * Essential = a required account / security / transactional notice. These are NEVER
 * unsubscribable and bypass the marketing suppression list + cost-throttle's marketing rules.
 * Marketing = opt-in updates. These carry a working unsubscribe and honor suppression.
 */
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
  'access-requested': 'essential',
  welcome: 'essential',
  'signin-alert': 'essential',
  'auth-confirm-signup': 'essential',
  'auth-magic-link': 'essential',
  'auth-recovery': 'essential',
  'auth-email-change': 'essential',
  'auth-reauthentication': 'essential',
  'auth-invite': 'essential'
};

export const EMAIL_TEMPLATE_NAMES = Object.keys(TEMPLATE_KIND) as EmailTemplateName[];

export const isEmailTemplateName = (value: unknown): value is EmailTemplateName =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATE_KIND, value);

export const isMarketing = (name: EmailTemplateName): boolean => TEMPLATE_KIND[name] === 'marketing';

interface TemplateOutput {
  subject: string;
  preheader: string;
  content: string;
  text: string;
}

type Renderer = (params: EmailParams, brand: BrandConfig) => TemplateOutput;

const greetName = (params: EmailParams): string => {
  const name = (params.firstName || params.name || '').trim();
  return name ? `Hey ${escapeHtml(name)},` : 'Hey there,';
};
const greetNameText = (params: EmailParams): string => {
  const name = (params.firstName || params.name || '').trim();
  return name ? `Hey ${name},` : 'Hey there,';
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

// ── Newsletter: double opt-in confirmation ──────────────────────────────────────
const newsletterConfirm: Renderer = (params, brand) => {
  const url = params.confirmUrl || brand.appUrl;
  return {
    subject: `Confirm your subscription to ${brand.productName}`,
    preheader: 'Confirm your email to start getting updates.',
    content:
      heading('One click to confirm') +
      paragraph(`${greetName(params)} thanks for signing up for ${escapeHtml(brand.productName)} updates! 🎉`) +
      paragraph('We just need to make sure this inbox is really yours. Tap the button to lock in your spot.') +
      button('Confirm subscription', url, 'yellow') +
      linkFallback(url) +
      muted("If you didn't sign up, no worries — just ignore this email and you won't hear from us again."),
    text: [
      greetNameText(params),
      '',
      `Thanks for signing up for ${brand.productName} updates!`,
      '',
      'Confirm your subscription by opening this link:',
      url,
      '',
      "If you didn't sign up, you can safely ignore this email."
    ].join('\n')
  };
};

// ── Newsletter: welcome after confirmation ──────────────────────────────────────
const newsletterWelcome: Renderer = (params, brand) => ({
  subject: `You're in — welcome to ${brand.productName}`,
  preheader: "Your subscription is confirmed — here's what's next.",
  content:
    heading("You're on the list! 🚀") +
    paragraph(`${greetName(params)} your subscription is confirmed.`) +
    paragraph(
      `Expect occasional dispatches on new comic styles, AI models, and features landing in ${escapeHtml(
        brand.productName
      )}. No spam — just the good stuff.`
    ) +
    button('Jump into the studio', brand.appUrl, 'blue'),
  text: [
    greetNameText(params),
    '',
    `Your subscription to ${brand.productName} is confirmed. Welcome aboard!`,
    '',
    `Open the studio: ${brand.appUrl}`
  ].join('\n')
});

// ── Product update (marketing broadcast) ────────────────────────────────────────
const productUpdate: Renderer = (params, brand) => {
  const title = params.title || `What's new in ${brand.productName}`;
  const bodyHtml = params.bodyHtml || paragraph(escapeHtml(params.body || 'We shipped some new things we think you’ll like.'));
  const cta = params.ctaUrl || brand.appUrl;
  const ctaLabel = params.ctaLabel || 'See what’s new';
  return {
    subject: params.subject || title,
    preheader: params.preheader || title,
    content: heading(title) + paragraph(`${greetName(params)}`) + bodyHtml + button(ctaLabel, cta, 'yellow'),
    text: [greetNameText(params), '', params.body || 'We shipped some new things.', '', `${ctaLabel}: ${cta}`].join('\n')
  };
};

// ── Announcement / custom notice (admin "structured composer") ──────────────────
const announcement: Renderer = (params, brand) => {
  const head = params.heading || 'An update from ' + brand.productName;
  const bodyHtml = params.body ? textToParagraphs(params.body) : '';
  const cta = params.ctaUrl && params.ctaLabel ? button(params.ctaLabel, params.ctaUrl, 'yellow') : '';
  const greeting = params.firstName ? paragraph(greetName(params)) : '';
  return {
    subject: params.subject || head,
    preheader: params.preheader || head,
    content: heading(head) + greeting + bodyHtml + cta,
    text: [
      params.firstName ? greetNameText(params) + '\n' : '',
      params.body || '',
      params.ctaUrl && params.ctaLabel ? `\n${params.ctaLabel}: ${params.ctaUrl}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  };
};

// ── Beta invite / referral (one-to-one, sent by an admin or a user) ─────────────
const betaInvite: Renderer = (params, brand) => {
  const url = params.inviteUrl || brand.appUrl;
  const inviter = (params.inviterName || '').trim();
  const intro = inviter
    ? `${escapeHtml(inviter)} thinks you'd love ${escapeHtml(brand.productName)} and invited you to the beta.`
    : `You've been invited to the ${escapeHtml(brand.productName)} beta.`;
  const note = params.personalNote
    ? infoBox(`<em>&ldquo;${escapeHtml(params.personalNote)}&rdquo;</em>${inviter ? ` — ${escapeHtml(inviter)}` : ''}`)
    : '';
  return {
    subject: inviter ? `${inviter} invited you to ${brand.productName}` : `You're invited to the ${brand.productName} beta`,
    preheader: 'Your beta invite is inside — claim your spot.',
    content:
      heading("You're invited! 🎟️") +
      paragraph(intro) +
      note +
      paragraph('Turn scripts into cinematic comics, build with 100+ AI models in Chat, and more. Tap below to claim your spot.') +
      button('Accept your invite', url, 'yellow') +
      linkFallback(url) +
      (params.code ? muted(`Or enter this invite code at sign-up: <strong>${escapeHtml(params.code)}</strong>`) : ''),
    text: [
      intro,
      params.personalNote ? `\n"${params.personalNote}"${inviter ? ` — ${inviter}` : ''}` : '',
      `\nAccept your invite: ${url}`,
      params.code ? `Invite code: ${params.code}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  };
};

// ── Early access request received ───────────────────────────────────────────────
const accessRequested: Renderer = (params, brand) => ({
  subject: `We got your access request — ${brand.productName}`,
  preheader: "You're in the early-access queue.",
  content:
    heading('Request received ✅') +
    paragraph(`${greetName(params)} thanks for requesting early access to ${escapeHtml(brand.productName)}.`) +
    paragraph(
      'New access is invite-only right now while we scale up. You’re in the queue, and we’ll email you the moment a spot opens.'
    ) +
    infoBox('In the meantime, keep an eye on this inbox — your invite will arrive right here.') +
    muted('Didn’t request access? You can ignore this email.'),
  text: [
    greetNameText(params),
    '',
    `Thanks for requesting early access to ${brand.productName}.`,
    'Access is invite-only right now. You’re in the queue and we’ll email you when a spot opens.'
  ].join('\n')
});

// ── Post-signup welcome ─────────────────────────────────────────────────────────
const welcome: Renderer = (params, brand) => {
  const cta = params.ctaUrl || brand.appUrl;
  return {
    subject: `Welcome to ${brand.productName} 🎬`,
    preheader: 'Your account is ready — start creating.',
    content:
      heading(`Welcome to ${brand.productName}!`) +
      paragraph(`${greetName(params)} your account is ready to roll.`) +
      paragraph('Turn scripts into cinematic comics, build with 100+ AI models in Chat, and more — all from one studio.') +
      button('Start creating', cta, 'yellow') +
      muted(`Questions? Just reply to this email and we'll help you out.`),
    text: [
      greetNameText(params),
      '',
      `Welcome to ${brand.productName}! Your account is ready.`,
      `Start creating: ${cta}`,
      '',
      'Questions? Reply to this email.'
    ].join('\n')
  };
};

// ── New sign-in security alert ──────────────────────────────────────────────────
const signinAlert: Renderer = (params, brand) => {
  const when = params.time || 'just now';
  const device = params.device || 'an unrecognized device';
  const location = params.location || 'an unknown location';
  const secureUrl = params.secureUrl || brand.appUrl;
  const details =
    `<strong>When:</strong> ${escapeHtml(when)}<br/>` +
    `<strong>Device:</strong> ${escapeHtml(device)}<br/>` +
    `<strong>Location:</strong> ${escapeHtml(location)}` +
    (params.ip ? `<br/><strong>IP:</strong> ${escapeHtml(params.ip)}` : '');
  return {
    subject: `New sign-in to your ${brand.productName} account`,
    preheader: `New sign-in from ${device}.`,
    content:
      heading('New sign-in detected') +
      paragraph(`${greetName(params)} we noticed a new sign-in to your ${escapeHtml(brand.productName)} account.`) +
      infoBox(details) +
      paragraph('If this was you, you’re all set — no action needed.') +
      paragraph('<strong>Didn’t recognize this?</strong> Secure your account right away:') +
      button('Secure my account', secureUrl, 'blue'),
    text: [
      greetNameText(params),
      '',
      `New sign-in to your ${brand.productName} account.`,
      `When: ${when}`,
      `Device: ${device}`,
      `Location: ${location}`,
      params.ip ? `IP: ${params.ip}` : '',
      '',
      'If this was you, no action is needed.',
      `If not, secure your account: ${secureUrl}`
    ]
      .filter(Boolean)
      .join('\n')
  };
};

// ── Supabase auth-hook templates (link- or code-based) ──────────────────────────
const authLink = (
  opts: { subjectVerb: string; title: string; intro: string; cta: string; variant?: 'yellow' | 'blue'; preheader: string },
  params: EmailParams,
  brand: BrandConfig
): TemplateOutput => {
  const url = params.actionUrl || brand.appUrl;
  return {
    subject: `${opts.subjectVerb} — ${brand.productName}`,
    preheader: opts.preheader,
    content:
      heading(opts.title) +
      paragraph(opts.intro) +
      button(opts.cta, url, opts.variant ?? 'blue') +
      linkFallback(url) +
      (params.token ? muted(`Or enter this code: <strong>${escapeHtml(params.token)}</strong>`) : '') +
      muted("This link expires soon for your security. If you didn't request it, you can ignore this email."),
    text: [
      opts.intro.replace(/<[^>]+>/g, ''),
      '',
      `${opts.cta}: ${url}`,
      params.token ? `Code: ${params.token}` : '',
      '',
      "This link expires soon. If you didn't request it, ignore this email."
    ]
      .filter(Boolean)
      .join('\n')
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
      preheader: 'Confirm your email to activate your account.'
    },
    params,
    brand
  );

const authMagicLink: Renderer = (params, brand) =>
  authLink(
    {
      subjectVerb: 'Your sign-in link',
      title: 'Sign in to your account',
      intro: `Tap below to securely sign in to ${escapeHtml(brand.productName)}.`,
      cta: 'Sign in',
      preheader: 'Your magic sign-in link is ready.'
    },
    params,
    brand
  );

const authRecovery: Renderer = (params, brand) =>
  authLink(
    {
      subjectVerb: 'Reset your password',
      title: 'Reset your password',
      intro: `We received a request to reset your ${escapeHtml(brand.productName)} password. Tap below to choose a new one.`,
      cta: 'Reset password',
      preheader: 'Reset your password with this secure link.'
    },
    params,
    brand
  );

const authEmailChange: Renderer = (params, brand) =>
  authLink(
    {
      subjectVerb: 'Confirm your new email',
      title: 'Confirm your new email',
      intro: params.newEmail
        ? `Confirm changing your ${escapeHtml(brand.productName)} email to <strong>${escapeHtml(params.newEmail)}</strong>.`
        : `Confirm your new email address for ${escapeHtml(brand.productName)}.`,
      cta: 'Confirm new email',
      preheader: 'Confirm your new email address.'
    },
    params,
    brand
  );

const authInvite: Renderer = (params, brand) =>
  authLink(
    {
      subjectVerb: `You're invited to ${brand.productName}`,
      title: `You're invited! 🎟️`,
      intro: `You've been invited to join ${escapeHtml(brand.productName)}. Accept your invite to set up your account.`,
      cta: 'Accept invite',
      variant: 'yellow',
      preheader: `Accept your invite to ${brand.productName}.`
    },
    params,
    brand
  );

const authReauthentication: Renderer = (params, brand) => {
  const code = params.token || '------';
  return {
    subject: `Your verification code — ${brand.productName}`,
    preheader: 'Your verification code is inside.',
    content:
      heading('Confirm it’s you') +
      paragraph(`Enter this code in ${escapeHtml(brand.productName)} to confirm this action:`) +
      codeBadge(code) +
      muted("This code expires shortly. If you didn't request it, you can ignore this email."),
    text: [
      `Enter this code in ${brand.productName} to confirm this action:`,
      '',
      code,
      '',
      "This code expires shortly. If you didn't request it, ignore this email."
    ].join('\n')
  };
};

const RENDERERS: Record<EmailTemplateName, Renderer> = {
  'newsletter-confirm': newsletterConfirm,
  'newsletter-welcome': newsletterWelcome,
  'product-update': productUpdate,
  announcement,
  'beta-invite': betaInvite,
  'access-requested': accessRequested,
  welcome,
  'signin-alert': signinAlert,
  'auth-confirm-signup': authConfirmSignup,
  'auth-magic-link': authMagicLink,
  'auth-recovery': authRecovery,
  'auth-email-change': authEmailChange,
  'auth-reauthentication': authReauthentication,
  'auth-invite': authInvite
};

/**
 * Render a named template to {subject, html, text}, applying the brand and centrally wiring
 * the unsubscribe/essential/read-receipt concerns. Throws on an unknown name.
 *
 * Recognised params (all optional, per template): confirmUrl, actionUrl, ctaUrl, secureUrl,
 * unsubscribeUrl (marketing only), pixelUrl, firstName, token, newEmail, time, device,
 * location, ip, title, body, bodyHtml, subject.
 */
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

  const html = wrapHtml({
    brand,
    preheader: out.preheader,
    content: out.content,
    unsubscribeUrl: marketing ? params.unsubscribeUrl : undefined,
    essential: !marketing,
    pixelUrl: params.pixelUrl
  });

  // Plain-text footer mirrors the HTML one (sign-off + unsubscribe / required notice).
  const textFooter = marketing
    ? params.unsubscribeUrl
      ? `\n\nUnsubscribe: ${params.unsubscribeUrl}\nYou're receiving this because you subscribed to ${brand.productName} updates.`
      : ''
    : `\n\nThis is a required ${brand.productName} account notification.`;

  return { subject: out.subject, html, text: `${out.text}\n\n— ${brand.productName}${textFooter}` };
};

export { safeUrl };
