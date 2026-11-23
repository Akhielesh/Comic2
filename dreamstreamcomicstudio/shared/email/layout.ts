// Shared transactional email components. Each element has a usable inline light palette.
// Fluid tables work without media queries. Classic Outlook receives a fixed outer frame.
import { BrandConfig, COLORS, DEFAULT_BRAND, FONT_BODY, FONT_DISPLAY } from './theme.js';

export const escapeHtml = (value: string): string =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Normalize a destination; HTML callers also escape it for its attribute context. */
export const safeUrl = (value: string): string => {
  const url = String(value ?? '').trim();
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url.replace(/"/g, '%22');
  return '#';
};

const hrefAttr = (href: string) => escapeHtml(safeUrl(href));
const tableAttrs = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
const tableStyle = 'border-collapse:separate;mso-table-lspace:0pt;mso-table-rspace:0pt;';
const longText = 'overflow-wrap:anywhere;word-wrap:break-word;word-break:break-word;';

export const heading = (text: string): string =>
  `<h1 class="ds-ink ds-heading" style="margin:0 0 22px;font-family:${FONT_DISPLAY};font-size:34px;font-weight:700;line-height:1.16;letter-spacing:-1.1px;color:${COLORS.ink};${longText}">${escapeHtml(text)}</h1>`;

export const paragraph = (html: string): string =>
  `<p class="ds-ink" style="margin:0 0 18px;font:16px/1.6 ${FONT_BODY};color:${COLORS.ink};${longText}">${html}</p>`;

export const muted = (html: string): string =>
  `<p class="ds-muted" style="margin:0 0 14px;font:14px/1.6 ${FONT_BODY};color:${COLORS.muted};${longText}">${html}</p>`;

export const infoBox = (html: string): string =>
  `<table ${tableAttrs} width="100%" style="${tableStyle}table-layout:fixed;margin:6px 0 22px;">
    <tr><td class="ds-panel ds-ink" bgcolor="${COLORS.boxBg}" style="border-left:3px solid #5c5c5c;padding:16px 20px;font:15px/1.6 ${FONT_BODY};color:${COLORS.ink};${longText}">${html}</td></tr>
  </table>`;

// Present each feature as a readable text row even when a client has no emoji glyphs.
export const featureCard = (_emoji: string, title: string, desc: string): string =>
  `<table ${tableAttrs} width="100%" style="${tableStyle}table-layout:fixed;">
    <tr><td class="ds-rule" style="border-top:1px solid ${COLORS.line};padding:13px 0 15px;">
      <p class="ds-ink" style="margin:0 0 3px;font:700 16px/1.45 ${FONT_BODY};color:${COLORS.ink};${longText}">${escapeHtml(title)}</p>
      <p class="ds-muted" style="margin:0;font:14px/1.6 ${FONT_BODY};color:${COLORS.muted};${longText}">${escapeHtml(desc)}</p>
    </td></tr>
  </table>`;

export const divider = (): string =>
  `<table ${tableAttrs} width="100%" style="${tableStyle}"><tr><td class="ds-rule" height="19" style="border-top:1px solid ${COLORS.line};line-height:1px;font-size:1px;">&nbsp;</td></tr></table>`;

export const codeBadge = (code: string): string =>
  `<table ${tableAttrs} width="100%" style="${tableStyle}table-layout:fixed;margin:6px 0 22px;">
    <tr><td class="ds-panel ds-ink ds-code" bgcolor="${COLORS.boxBg}" align="center" dir="ltr" style="border:1px solid ${COLORS.line};border-radius:8px;padding:16px 10px;font:700 26px/1.45 'Courier New',Courier,monospace;letter-spacing:3px;color:${COLORS.ink};${longText}">${escapeHtml(code)}</td></tr>
  </table>`;

/** MSO's raised text trick keeps the padded anchor clickable without a second link or a fixed VML width. */
export const button = (label: string, href: string, _variant: 'yellow' | 'blue' = 'blue'): string =>
  `<table ${tableAttrs} style="${tableStyle}margin:8px 0 22px;max-width:100%;">
    <tr><td class="ds-cta" align="center" bgcolor="${COLORS.ink}" style="border-radius:7px;background:${COLORS.ink};mso-padding-alt:0;">
      <a class="ds-action" href="${hrefAttr(href)}" target="_blank" style="display:inline-block;padding:13px 23px;color:#ffffff;font:700 16px/22px ${FONT_BODY};text-decoration:none;text-align:center;mso-padding-alt:0;${longText}"><!--[if mso]><i style="letter-spacing:23px;mso-font-width:-100%;mso-text-raise:23pt" hidden>&nbsp;</i><![endif]--><span style="mso-text-raise:11pt;">${escapeHtml(label)}</span><!--[if mso]><i style="letter-spacing:23px;mso-font-width:-100%" hidden>&nbsp;</i><![endif]--></a>
    </td></tr>
  </table>`;

export const linkFallback = (href: string): string => {
  const url = hrefAttr(href);
  return `<p class="ds-muted" style="margin:0 0 20px;font:13px/1.55 ${FONT_BODY};color:${COLORS.muted};">
    You can also copy this link into your browser.<br>
    <a class="ds-link" href="${url}" target="_blank" style="color:${COLORS.ink};text-decoration:underline;word-break:break-all;overflow-wrap:anywhere;">${url}</a>
  </p>`;
};

/** The static frame is the baseline for Outlook, stripped CSS and reduced-motion devices. */
export const comicSample = (readerUrl: string, headline: string, story: string): string => {
  const art = 'https://comics.dreamstreamstudio.ai/assets/email/last-tram-strip';
  const alt = 'Two panels from The Last Tram. A traveler overlooks a moonlit harbor, then follows the coastal tram.';
  const sizing = 'width:100%;max-width:530px;height:auto;border:0;';
  return `<table ${tableAttrs} width="100%" style="${tableStyle}table-layout:fixed;margin:20px 0 6px;">
    <tr><td class="ds-rule" style="border-top:1px solid ${COLORS.line};padding:20px 0 10px;">
      <h2 class="ds-ink" style="margin:0 0 12px;font:600 22px/1.25 ${FONT_DISPLAY};color:${COLORS.ink};">${escapeHtml(headline)}</h2>
      <img class="ds-comic-still" src="${art}.jpg" alt="${alt}" width="530" height="143" style="display:block;${sizing}">
      <!--[if !mso]><!--><img class="ds-comic-motion" src="${art}.gif" alt="${alt}" width="530" height="143" style="display:none;max-height:0;overflow:hidden;mso-hide:all;${sizing}"><!--<![endif]-->
    </td></tr>
    <tr><td>
      <p class="ds-muted" style="margin:0 0 5px;font:15px/1.55 ${FONT_BODY};color:${COLORS.muted};">${escapeHtml(story)}</p>
      <a class="ds-link" href="${hrefAttr(readerUrl)}" style="display:inline-block;padding:8px 0;color:${COLORS.ink};font:700 15px/1.45 ${FONT_BODY};text-decoration:underline;">Read both pages of The Last Tram</a>
    </td></tr>
  </table>`;
};


interface LayoutInput {
  brand: BrandConfig;
  studio?: 'comic_studio' | 'stream_studio' | 'chat_studio';
  preheader: string;
  content: string;
  unsubscribeUrl?: string;
  essential?: boolean;
  footerNotice?: string;
  ackUrl?: string;
  pixelUrl?: string;
  noReply?: boolean;
}

export const wrapHtml = ({ brand, studio, preheader, content, unsubscribeUrl, essential, footerNotice, ackUrl, pixelUrl, noReply }: LayoutInput): string => {
  const year = new Date().getUTCFullYear();
  const name = escapeHtml(brand.productName);
  const appUrl = hrefAttr(brand.appUrl);
  const helpUrl = hrefAttr(`mailto:${brand.supportEmail}`);
  // Same mark and two-tone wordmark as BrandLockup.tsx and ComicsHeader.tsx.
  // Use the checked-in manifest PNGs because Outlook cannot reliably display those headers' SVGs.
  const suiteBrand = brand.productName === DEFAULT_BRAND.productName;
  const standardBrand = suiteBrand || ['Comic Studio', 'Stream Studio', 'Chat Studio'].includes(brand.productName);
  const studioNames = { comic_studio: 'Comic', stream_studio: 'Stream', chat_studio: 'Chat' };
  const studioName = suiteBrand ? studio ? studioNames[studio] : 'DreamStream' : brand.productName.replace(/ Studio$/, '');
  const comicPaper = standardBrand && studioName === 'Comic';
  const paper = comicPaper ? '#fffdf7' : COLORS.paper;
  const canvas = comicPaper ? '#fbf8f0' : COLORS.pageBg;
  const wordmark = standardBrand
    ? `<strong class="ds-ink" style="color:${COLORS.ink};font-weight:600;">${studioName}</strong> <span class="ds-muted" style="color:${COLORS.muted};font-weight:500;">Studio</span>`
    : name;
  const icon = comicPaper ? 'comics-192.png' : 'app-192.png';
  const assetUrl = hrefAttr(`${DEFAULT_BRAND.appUrl}/icons/${icon}`);
  const brandText = `<span class="ds-ink" style="font:600 22px/1.3 ${FONT_DISPLAY};color:${COLORS.ink};letter-spacing:-0.4px;">${wordmark}</span>`;
  const mark = brand.logoUrl
    ? `<img src="${hrefAttr(brand.logoUrl)}" alt="${name}" width="180" style="display:block;max-width:100%;height:auto;border:0;color:${COLORS.ink};">`
    : `${standardBrand ? `<img src="${assetUrl}" width="32" height="32" alt="" style="vertical-align:middle;border:0;border-radius:8px;">&nbsp;&nbsp;` : ''}<span style="vertical-align:middle;">${brandText}</span>`;
  const footerLink = (url: string, label: string) =>
    `<a class="ds-footerlink" href="${url}" style="display:inline-block;padding:5px 0;color:${COLORS.footerLink};text-decoration:underline;font-weight:bold;">${label}</a>`;
  const links = [footerLink(appUrl, 'Open the app'), footerLink(helpUrl, 'Get help')];
  if (unsubscribeUrl && !essential) links.push(footerLink(hrefAttr(unsubscribeUrl), 'Unsubscribe'));
  if (ackUrl) links.push(footerLink(hrefAttr(ackUrl), 'Acknowledge this message (optional)'));
  const notice = footerNotice || (essential
    ? `This is a required ${brand.productName} account notification.`
    : unsubscribeUrl ? `You subscribed to ${brand.productName} updates.` : '');
  const footerLine = (html: string) =>
    `<p class="ds-muted" style="margin:5px 0 0;font:13px/1.55 ${FONT_BODY};color:${COLORS.footerText};${longText}">${html}</p>`;
  const pixel = pixelUrl && /^https?:\/\//i.test(pixelUrl)
    ? `<img src="${hrefAttr(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">` : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
  <title>${name}</title>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
  <style>
    :root {color-scheme:light dark;supported-color-schemes:light dark}
    body {margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    a:focus-visible {outline:3px solid #5c5c5c;outline-offset:2px}
    @media screen and (prefers-reduced-motion:no-preference) {
      .ds-comic-still {display:none!important}
      .ds-comic-motion {display:block!important;max-height:none!important;overflow:visible!important}
    }
    @media screen and (max-width:600px) {
      .ds-outer {padding:18px 10px!important}
      .ds-head {padding:18px 20px!important}
      .ds-body {padding:26px 20px 15px!important}
      .ds-foot {padding:12px 14px 8px!important}
      .ds-heading {font-size:28px!important;letter-spacing:-0.6px!important}
      .ds-code {font-size:22px!important;letter-spacing:2px!important}
    }
    @media (prefers-color-scheme:dark) {
      .ds-page {background-color:${comicPaper ? '#191612' : '#0a0a0a'}!important}
      .ds-card {background-color:${comicPaper ? '#211c17' : '#111111'}!important;border-color:#393939!important;border-top-color:#fafafa!important}
      .ds-rule {border-color:#393939!important}
      .ds-ink {color:${comicPaper ? '#f8efe1' : '#fafafa'}!important}
      .ds-muted {color:${comicPaper ? '#c5b8aa' : '#a3a3a3'}!important}
      .ds-panel {background-color:#202020!important;border-color:#5c5c5c!important}
      .ds-link,.ds-footerlink,.ds-panel a {color:#fafafa!important}
      .ds-cta {background:#fafafa!important}
      .ds-action {color:#0a0a0a!important}
    }
  </style>
</head>
<body class="ds-page" style="margin:0;padding:0;background-color:${canvas};">
  <div aria-hidden="true" style="display:none!important;mso-hide:all;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;">${escapeHtml(preheader || brand.tagline)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table ${tableAttrs} width="100%" class="ds-page" bgcolor="${canvas}" style="${tableStyle}width:100%;">
    <tr><td class="ds-outer" align="center" style="padding:40px 14px 28px;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table ${tableAttrs} width="100%" style="${tableStyle}width:100%;max-width:600px;table-layout:fixed;">
        <tr><td class="ds-card" bgcolor="${paper}" style="border:1px solid ${COLORS.line};border-top:3px solid #0a0a0a;border-radius:10px;">
          <table ${tableAttrs} width="100%" style="${tableStyle}width:100%;table-layout:fixed;">
            <tr><td class="ds-head ds-rule" align="left" style="padding:19px 34px;border-bottom:1px solid ${COLORS.line};">
              <a href="${appUrl}" aria-label="${standardBrand ? studioName + ' Studio' : name}" style="color:${COLORS.ink};text-decoration:none;${longText}">${mark}</a>
            </td></tr>
            <tr><td class="ds-body" align="left" style="padding:32px 34px 18px;${longText}">${content}</td></tr>
          </table>
        </td></tr>
        <tr><td class="ds-foot" align="left" style="padding:16px 20px 8px;font:13px/1.55 ${FONT_BODY};color:${COLORS.footerText};">
          <div>${links.join(' &nbsp;·&nbsp; ')}</div>
          ${notice ? footerLine(escapeHtml(notice)) : ''}
          ${pixelUrl ? footerLine('Loading images can record an image request for this message.') : ''}
          ${noReply ? footerLine(`This mailbox isn't monitored. For help, email <a class="ds-footerlink" href="${helpUrl}" style="color:${COLORS.footerLink};text-decoration:underline;">${escapeHtml(brand.supportEmail)}</a>.`) : ''}
          ${footerLine(`© ${year} ${escapeHtml(brand.companyName)}${brand.companyAddress ? ` · ${escapeHtml(brand.companyAddress)}` : ''}`)}
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
  ${pixel}
</body>
</html>`.replace(/^[ \t]+$/gm, '');
};
