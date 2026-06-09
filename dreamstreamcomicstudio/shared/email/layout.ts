// Email-safe building blocks. Everything is table-based with inline CSS because real
// inboxes (Gmail, Outlook desktop/web, Apple Mail, Yahoo) strip <style>, flexbox, grid
// and most modern CSS. Modern niceties (box-shadow for the "comic" lift, web fonts) are
// layered on as progressive enhancement — they render where supported and are ignored
// everywhere else without breaking the layout.

import { BrandConfig, COLORS, FONT_BODY, FONT_DISPLAY } from './theme.js';

/** Escape user/dynamic text before it lands in HTML. */
export const escapeHtml = (value: string): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Only allow http(s) (and mailto) hrefs — neutralises javascript:/data: injection in links. */
export const safeUrl = (value: string): string => {
  const v = String(value ?? '').trim();
  if (/^https?:\/\//i.test(v) || /^mailto:/i.test(v)) return v.replace(/"/g, '%22');
  return '#';
};

/** A comic-style heading inside the card. */
export const heading = (text: string): string =>
  `<h1 style="margin:0 0 16px;font-family:${FONT_DISPLAY};font-size:30px;line-height:1.1;letter-spacing:0.5px;color:${COLORS.ink};text-transform:uppercase;">${escapeHtml(
    text
  )}</h1>`;

/** A body paragraph. Pass already-safe inline HTML (use escapeHtml on dynamic bits). */
export const paragraph = (html: string): string =>
  `<p style="margin:0 0 16px;font-family:${FONT_BODY};font-size:16px;line-height:1.6;color:${COLORS.ink};">${html}</p>`;

export const muted = (html: string): string =>
  `<p style="margin:0 0 12px;font-family:${FONT_BODY};font-size:13px;line-height:1.6;color:${COLORS.muted};">${html}</p>`;

/** Pale-yellow info panel with the signature black outline. */
export const infoBox = (html: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:separate;">
    <tr><td style="background:${COLORS.boxBg};border:2px solid ${COLORS.black};border-radius:10px;padding:16px 18px;font-family:${FONT_BODY};font-size:15px;line-height:1.6;color:${COLORS.ink};">${html}</td></tr>
  </table>`;

/** A feature row: emoji + bold title + muted description. Email-safe (table-based). */
export const featureCard = (emoji: string, title: string, desc: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-collapse:separate;">
    <tr>
      <td width="46" valign="top" style="font-size:26px;line-height:1;padding-top:2px;">${emoji}</td>
      <td valign="top" style="font-family:${FONT_BODY};color:${COLORS.ink};">
        <div style="font-weight:bold;font-size:16px;margin:0 0 2px;">${escapeHtml(title)}</div>
        <div style="font-size:14px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(desc)}</div>
      </td>
    </tr>
  </table>`;

/** A thin divider rule. */
export const divider = (): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:2px solid ${COLORS.black};font-size:0;line-height:0;height:0;">&nbsp;</td></tr></table><div style="height:18px;line-height:18px;">&nbsp;</div>`;

/** A big monospace verification code / token badge. */
export const codeBadge = (code: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:separate;">
    <tr><td align="center" style="background:${COLORS.yellow};border:3px solid ${COLORS.black};border-radius:12px;padding:18px 12px;">
      <span style="font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:bold;letter-spacing:6px;color:${COLORS.ink};">${escapeHtml(
        code
      )}</span>
    </td></tr>
  </table>`;

/**
 * Bulletproof comic CTA button. Uses an MSO conditional fill so it renders solid in
 * Outlook desktop too, then the styled anchor for everyone else.
 */
export const button = (label: string, href: string, variant: 'yellow' | 'blue' = 'blue'): string => {
  const bg = variant === 'yellow' ? COLORS.yellow : COLORS.blue;
  const fg = variant === 'yellow' ? COLORS.ink : COLORS.white;
  const url = safeUrl(href);
  const text = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td align="center" bgcolor="${bg}" style="border-radius:10px;border:3px solid ${COLORS.black};box-shadow:4px 4px 0 ${COLORS.black};">
      <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:280px;" arcsize="20%" strokecolor="${COLORS.black}" fillcolor="${bg}"><w:anchorlock/><center style="color:${fg};font-family:${FONT_BODY};font-size:16px;font-weight:bold;"><![endif]-->
      <a href="${url}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT_BODY};font-size:16px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:${fg};text-decoration:none;">${text}</a>
      <!--[if mso]></center></v:roundrect><![endif]-->
    </td></tr>
  </table>`;
};

/** Render a small "or paste this link" fallback row beneath a CTA. */
export const linkFallback = (href: string): string => {
  const url = safeUrl(href);
  return `<p style="margin:0 0 18px;font-family:${FONT_BODY};font-size:12px;line-height:1.5;color:${COLORS.muted};word-break:break-all;">
    Button not working? Copy &amp; paste this link:<br/>
    <a href="${url}" target="_blank" style="color:${COLORS.blueDark};">${escapeHtml(url)}</a>
  </p>`;
};

interface LayoutInput {
  brand: BrandConfig;
  /** Hidden inbox-preview text (the grey line next to the subject). */
  preheader: string;
  /** Inner card HTML, assembled from the helpers above. */
  content: string;
  /** Per-recipient unsubscribe / manage-preferences URL (marketing mail only). */
  unsubscribeUrl?: string;
  /** True for required account/security mail — shows a "required notice" line, never an unsubscribe. */
  essential?: boolean;
  /** Optional 1x1 read-receipt pixel URL embedded before </body>. */
  pixelUrl?: string;
  /** True for automated mail sent from a no-reply address — adds a "don't reply" notice. */
  noReply?: boolean;
}

/** Wrap card content in the full responsive, comic-branded HTML document. */
export const wrapHtml = ({ brand, preheader, content, unsubscribeUrl, essential, pixelUrl, noReply }: LayoutInput): string => {
  const year = new Date().getUTCFullYear();
  const logo = brand.logoUrl
    ? `<img src="${safeUrl(brand.logoUrl)}" width="220" alt="${escapeHtml(
        brand.productName
      )}" style="display:block;border:0;max-width:220px;height:auto;" />`
    : `<span style="font-family:${FONT_DISPLAY};font-size:30px;letter-spacing:1px;color:${COLORS.ink};text-transform:uppercase;">${escapeHtml(
        brand.productName
      )}</span>`;

  // Always embed the app conventions (open / sign in / help). Unsubscribe is added for
  // marketing mail only — required account & security notices can never be unsubscribed.
  const fLink = (href: string, label: string) =>
    `<a href="${href}" style="color:${COLORS.footerLink};text-decoration:none;">${label}</a>`;
  const footerLinks = [
    fLink(safeUrl(brand.appUrl), 'Open the app'),
    fLink(safeUrl(brand.appUrl), 'Sign in'),
    fLink(`mailto:${escapeHtml(brand.supportEmail)}`, 'Get help'),
    unsubscribeUrl ? fLink(safeUrl(unsubscribeUrl), 'Unsubscribe') : ''
  ]
    .filter(Boolean)
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  // Honest "why am I getting this" notice (CAN-SPAM / CASL).
  const noticeLine = essential
    ? `<div style="margin-top:8px;color:${COLORS.footerText};font-size:11px;">This is a required ${escapeHtml(
        brand.productName
      )} account notification, so it has no unsubscribe link.</div>`
    : unsubscribeUrl
      ? `<div style="margin-top:8px;color:${COLORS.footerText};font-size:11px;">You're receiving this because you subscribed to ${escapeHtml(
          brand.productName
        )} updates.</div>`
      : '';

  const replyNotice = noReply
    ? `<div style="margin-top:8px;color:${COLORS.footerText};font-size:11px;">This mailbox isn't monitored, so please don't reply. Need a hand? <a href="mailto:${escapeHtml(
        brand.supportEmail
      )}" style="color:${COLORS.footerLink};text-decoration:none;">${escapeHtml(brand.supportEmail)}</a></div>`
    : '';

  const addressLine = brand.companyAddress
    ? `<div style="margin-top:8px;color:${COLORS.footerText};font-size:11px;">${escapeHtml(brand.companyAddress)}</div>`
    : '';

  // 1x1 read-receipt pixel (open tracking). Only embedded when the caller supplies a URL.
  const pixel =
    pixelUrl && /^https?:\/\//i.test(pixelUrl)
      ? `<img src="${safeUrl(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`
      : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${escapeHtml(brand.productName)}</title>
  <!--[if mso]><style>* { font-family: Arial, sans-serif !important; }</style><![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@400;700&family=Inter:wght@400;600&display=swap');
    body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
    a { text-decoration:none; }
    @media (max-width:600px) { .card-pad { padding:24px 20px !important; } }
  </style>
</head>
<body style="margin:0;padding:0;background:${COLORS.pageBg};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${COLORS.pageBg};">${escapeHtml(
    preheader || brand.tagline
  )}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.pageBg};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">

        <!-- Header / wordmark on comic yellow -->
        <tr><td style="background:${COLORS.yellow};border:3px solid ${COLORS.black};border-bottom:none;border-radius:14px 14px 0 0;padding:22px 28px;" align="left">
          ${logo}
        </td></tr>

        <!-- Card body (the comic-shadow lift renders where box-shadow is supported) -->
        <tr><td class="card-pad" style="background:${COLORS.paper};border:3px solid ${COLORS.black};border-top:none;border-radius:0 0 14px 14px;box-shadow:6px 6px 0 ${COLORS.black};padding:30px 32px;">
          ${content}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:22px 8px 8px;" align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.footerBg};border:3px solid ${COLORS.black};border-radius:12px;">
            <tr><td align="center" style="padding:18px 22px;font-family:${FONT_BODY};font-size:12px;line-height:1.7;color:${COLORS.footerText};">
              <div style="margin-bottom:6px;">${footerLinks}</div>
              <div>© ${year} ${escapeHtml(brand.companyName)}. All rights reserved.</div>
              ${noticeLine}
              ${replyNotice}
              ${addressLine}
            </td></tr>
          </table>
        </td></tr>

      </table>
    </td></tr>
  </table>
  ${pixel}
</body>
</html>`;
};
