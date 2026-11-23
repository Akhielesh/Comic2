// Renders every email template to docs/email/previews/*.html with realistic sample data,
// plus an index.html gallery. Pure preview tool — sends nothing.
//
//   npx tsx scripts/email-preview.ts
//   open docs/email/previews/index.html
//
// SMTP-fallback mode — the branded auth templates with Supabase's Go-template placeholders
// ({{ .ConfirmationURL }}, {{ .Token }}, {{ .NewEmail }}, …) for pasting into Supabase →
// Authentication → Emails when the Send Email Hook is OFF and Supabase sends over SMTP:
//
//   npx tsx scripts/email-preview.ts --supabase [--out <dir>]   # default docs/email/previews/supabase

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { EMAIL_TEMPLATE_NAMES, SENDER_ROLE, TEMPLATE_KIND, renderEmail, type EmailParams, type EmailTemplateName } from '../shared/email/index.js';

const PREVIEWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'email', 'previews');

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const supabaseMode = args.includes('--supabase');
const OUT_DIR = outFlag >= 0 && args[outFlag + 1] ? resolve(args[outFlag + 1]) : supabaseMode ? resolve(PREVIEWS_DIR, 'supabase') : PREVIEWS_DIR;

const escapeCell = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');

if (supabaseMode) {
  renderSupabaseTemplates();
} else {
  renderPreviews();
}

function renderPreviews() {
  const origin = 'https://studio.example.invalid';
  const account = 'ada@example.invalid';
  const sample: EmailParams = {
    firstName: 'Ada', email: account, currentEmail: account, newEmail: 'ada.new@example.invalid',
    confirmUrl: origin + '/updates/confirm/sample', actionUrl: origin + '/auth/verify/sample',
    unsubscribeUrl: origin + '/updates/unsubscribe/sample', secureUrl: origin + '/account/security',
    token: '123456', time: 'November 23, 2026 at 10:24 UTC', device: 'Chrome on macOS',
    location: 'Austin, Texas, US', ip: '203.0.113.42',
    inviteUrl: origin + '/invitation/sample', inviterName: 'Rowan', code: 'DS-SAMPLE'
  };

  type Group = 'Membership' | 'Product updates' | 'Sign-in and accounts' | 'Security notices';
  interface Scenario {
    name: EmailTemplateName;
    label: string;
    group: Group;
    id?: string;
    params?: EmailParams;
    product?: 'Comic Studio' | 'Stream Studio';
  }
  const scenarios: Scenario[] = [
    { name: 'access-requested', group: 'Membership', label: 'Interest registered', product: 'Comic Studio' },
    { name: 'beta-invite', group: 'Membership', label: 'Beta invitation', params: { personalNote: 'I thought you might enjoy making a comic from your short story.' } },
    { name: 'beta-invite', id: 'beta-invite-comic-studio', group: 'Membership', label: 'Comic Studio beta invitation', params: { studios: 'comic_studio' } },
    { name: 'beta-invite', id: 'beta-invite-multiple-studios', group: 'Membership', label: 'Invitation to selected studios', params: { studios: 'comic_studio,chat_studio' } },
    { name: 'studio-invite', group: 'Membership', label: 'Stream Studio access', params: { studio: 'stream_studio', inviteUrl: origin + '/live' } },
    { name: 'studio-invite', id: 'studio-invite-comic_studio', group: 'Membership', label: 'Comic Studio access', params: { studio: 'comic_studio', inviteUrl: 'https://comics.example.invalid/' } },
    { name: 'studio-invite', id: 'studio-invite-chat_studio', group: 'Membership', label: 'Chat Studio access', params: { studio: 'chat_studio', inviteUrl: origin + '/chat' } },
    { name: 'welcome', group: 'Membership', label: 'Welcome to the studio' },
    { name: 'newsletter-confirm', group: 'Product updates', label: 'Confirm a subscription' },
    { name: 'newsletter-welcome', group: 'Product updates', label: 'Subscription confirmed' },
    { name: 'newsletter-confirm', id: 'comic-studio-newsletter-confirm', group: 'Product updates', label: 'Confirm Comic Studio updates', product: 'Comic Studio' },
    { name: 'newsletter-welcome', id: 'comic-studio-newsletter-welcome', group: 'Product updates', label: 'Comic Studio updates confirmed', product: 'Comic Studio' },
    { name: 'product-update', group: 'Product updates', label: 'Product release', params: {
      title: 'New sample comics in Comic Studio', body: 'Hello, Europa and A Small Giant are ready to read. Choose either sample on the Comic Studio home page to explore a complete illustrated page.',
      ctaUrl: 'https://comics.example.invalid/', ctaLabel: 'Read the samples'
    } },
    { name: 'announcement', group: 'Product updates', label: 'Service announcement', params: {
      heading: 'Scheduled studio maintenance', body: 'The studio will be unavailable from 08:00 to 08:30 UTC on November 29. Save your work before the maintenance window.',
      ctaUrl: origin + '/status', ctaLabel: 'View service status', ackUrl: origin + '/acknowledgement/sample'
    } },
    { name: 'auth-confirm-signup', group: 'Sign-in and accounts', label: 'Confirm a new account' },
    { name: 'auth-confirm-signup', id: 'comic-studio-confirm-signup', group: 'Sign-in and accounts', label: 'Confirm a Comic Studio account', product: 'Comic Studio' },
    { name: 'auth-invite', group: 'Sign-in and accounts', label: 'Accept an account invitation' },
    { name: 'auth-magic-link', group: 'Sign-in and accounts', label: 'Sign-in link' },
    { name: 'auth-magic-link', id: 'auth-magic-link-otp', group: 'Sign-in and accounts', label: 'One-time sign-in code', params: { codeFirst: '1' } },
    { name: 'auth-magic-link', id: 'comic-studio-otp', group: 'Sign-in and accounts', label: 'Comic Studio sign-in code', product: 'Comic Studio', params: { codeFirst: '1' } },
    { name: 'auth-magic-link', id: 'stream-studio-signin', group: 'Sign-in and accounts', label: 'Stream Studio sign-in link', product: 'Stream Studio' },
    { name: 'auth-recovery', group: 'Sign-in and accounts', label: 'Password reset' },
    { name: 'auth-email-change', group: 'Sign-in and accounts', label: 'Confirm the new address' },
    { name: 'auth-email-change', id: 'auth-email-change-both', group: 'Sign-in and accounts', label: 'New address with two confirmations', params: { bothRequired: '1' } },
    { name: 'auth-email-change', id: 'auth-email-change-current', group: 'Sign-in and accounts', label: 'Approve from the current address', params: { bothRequired: '1', emailChangeStep: 'current' } },
    { name: 'auth-reauthentication', group: 'Sign-in and accounts', label: 'Verify a sensitive action' },
    { name: 'signin-alert', group: 'Security notices', label: 'New sign-in alert' },
    { name: 'auth-security-notice', group: 'Security notices', label: 'Password changed', params: { notice: 'password_changed' } },
    { name: 'auth-security-notice', id: 'notice-email-changed', group: 'Security notices', label: 'Email address changed', params: { notice: 'email_changed', oldEmail: account } },
    { name: 'auth-security-notice', id: 'notice-phone-changed', group: 'Security notices', label: 'Phone number changed', params: { notice: 'phone_changed', oldPhone: '+1 202-555-0141', phone: '+1 202-555-0142' } },
    { name: 'auth-security-notice', id: 'notice-identity-linked', group: 'Security notices', label: 'Sign-in method linked', params: { notice: 'identity_linked', provider: 'google' } },
    { name: 'auth-security-notice', id: 'notice-identity-unlinked', group: 'Security notices', label: 'Sign-in method removed', params: { notice: 'identity_unlinked', provider: 'google' } },
    { name: 'auth-security-notice', id: 'notice-mfa-added', group: 'Security notices', label: 'Verification method added', params: { notice: 'mfa_factor_enrolled', factorType: 'totp' } },
    { name: 'auth-security-notice', id: 'notice-mfa-removed', group: 'Security notices', label: 'Verification method removed', params: { notice: 'mfa_factor_unenrolled', factorType: 'totp' } }
  ];
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of EMAIL_TEMPLATE_NAMES) {
    if (!scenarios.some(item => item.name === name)) throw new Error('Missing preview for ' + name);
  }
  const destinations: string[] = [];
  const messages = scenarios.map(({ name, label, group, id = name, params, product }) => {
    const appUrl = product === 'Comic Studio' ? 'https://comics.example.invalid' : product === 'Stream Studio' ? 'https://stream.example.invalid' : origin;
    const { subject, html, text } = renderEmail(name, { ...sample, ...params }, {
      appUrl, productName: product, supportEmail: 'support@example.invalid'
    });
    if (!text.trim() || !subject.trim()) throw new Error('Missing text or subject for ' + id);
    // Preview actions stay offline, including support links. Keep the displayed addresses and
    // plain-text content as rendered, so reviewers can still inspect the intended destination.
    const previewLinks = html.replace(/ target="_blank"/g, '').replace(/\bhref="([^"]+)"/g, (_, href: string) => {
      const link = new URL(href.replace(/&amp;/g, '&'));
      const demoLink = link.protocol === 'https:' && link.hostname.endsWith('.invalid');
      if (!demoLink && link.href !== 'mailto:support@example.invalid') throw new Error('Unexpected preview destination in ' + id + ': ' + link);
      const key = 'link-' + destinations.length;
      destinations.push('<section id="' + key + '"><p>Sample destination</p><code>' + escapeCell(link.href) +
        '</code><p><a href="' + id + '.html">Return to ' + escapeCell(label) + '</a></p></section>');
      return 'href="preview-link.html#' + key + '"';
    });
    // Keep the email artwork as separate files, as delivered, so its bytes do not inflate
    // the HTML body. Only these sample images and the two public identity marks are allowed.
    const localHtml = previewLinks.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi, (tag, source: string) => {
      const location = new URL(source);
      const art = location.pathname.match(/^\/assets\/email\/(last-tram-strip\.(?:jpg|gif))$/)?.[1];
      if (art && location.origin === 'https://comics.dreamstreamstudio.ai') {
        mkdirSync(resolve(OUT_DIR, 'media'), { recursive: true });
        copyFileSync(new URL('../public/assets/email/' + art, import.meta.url), resolve(OUT_DIR, 'media', art));
        return tag.replace('src="' + source + '"', 'src="media/' + art + '"');
      }
      if (location.hostname !== 'dreamstreamstudio.ai' && !location.hostname.endsWith('.invalid')) throw new Error('Unexpected image host in ' + id);
      const icon = location.pathname.match(/^\/icons\/(app-192|comics-192)\.png$/)?.[1];
      if (!icon) throw new Error('Unexpected email preview image in ' + id + ': ' + source);
      const png = readFileSync(new URL('../public/icons/' + icon + '.png', import.meta.url));
      return tag.replace('src="' + source + '"', 'src="data:image/png;base64,' + png.toString('base64') + '"');
    });
    writeFileSync(resolve(OUT_DIR, id + '.html'), localHtml);
    return { id, label, group, subject, text, kind: TEMPLATE_KIND[name] === 'marketing' ? 'Marketing' : 'Transactional', sender: SENDER_ROLE[name] + '@example.invalid' };
  });
  if (new Set(messages.map(m => m.id)).size !== messages.length) throw new Error('Duplicate preview ID');
  const groups = [...new Set(messages.map(m => m.group))];
  const links = groups.map(group => '<h2>' + group + '</h2>' + messages.filter(m => m.group === group)
    .map(m => '<a data-id="' + m.id + '" href="' + m.id + '.html">' + escapeCell(m.label) + '</a>').join('\n')).join('\n');
  const options = groups.map(group => '<optgroup label="' + group + '">' + messages.filter(m => m.group === group)
    .map(m => '<option value="' + m.id + '">' + escapeCell(m.label) + '</option>').join('') + '</optgroup>').join('\n');
  const shell = readFileSync(new URL('./email-preview-gallery.html', import.meta.url), 'utf8');
  const mark = readFileSync(new URL('../public/stream-studio.svg', import.meta.url)).toString('base64');
  const index = shell.replace('<!--BRAND_MARK-->', 'data:image/svg+xml;base64,' + mark).replace('<!--COUNT-->', String(messages.length)).replace('<!--LINKS-->', links)
    .replace('<!--OPTIONS-->', options).replace('<!--MESSAGES-->', () => JSON.stringify(messages).replace(/</g, '\\u003c'));
  const destinationPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Sample destination · DreamStream Studio</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:38rem;margin:8vh auto;padding:20px}section{display:none}section:target{display:block}code{overflow-wrap:anywhere}a{color:inherit;text-underline-offset:3px}</style>
<main><h1>Email action preview</h1><p>In a delivered message, this link opens the destination shown below. This sample stays in the local library.</p>
${destinations.join('\n')}</main></html>`;
  writeFileSync(resolve(OUT_DIR, 'preview-link.html'), destinationPage);
  writeFileSync(resolve(OUT_DIR, 'index.html'), index);
  console.log('Wrote ' + messages.length + ' previews and the HTML/plain-text library to ' + OUT_DIR);
}

function renderSupabaseTemplates() {
  // A sentinel http URL survives safeUrl() (which blanks non-http hrefs to "#"); it is swapped
  // for the Go placeholder after rendering.
  const URL_SENTINEL = 'https://supabase-confirmation-url.invalid/';
  const URL_VAR = '{{ .ConfirmationURL }}';
  const TOKEN = '{{ .Token }}';

  // Supabase dashboard template name → our template + placeholder params.
  const TEMPLATES: Array<{ file: string; supabase: string; template: EmailTemplateName; params: EmailParams }> = [
    { file: 'confirm-signup', supabase: 'Confirm sign up', template: 'auth-confirm-signup', params: { actionUrl: URL_SENTINEL, token: TOKEN } },
    { file: 'invite-user', supabase: 'Invite user', template: 'auth-invite', params: { actionUrl: URL_SENTINEL, token: TOKEN } },
    { file: 'magic-link', supabase: 'Magic link or OTP', template: 'auth-magic-link', params: { actionUrl: URL_SENTINEL, token: TOKEN } },
    {
      file: 'change-email',
      supabase: 'Change email address',
      template: 'auth-email-change',
      params: { actionUrl: URL_SENTINEL, token: TOKEN, newEmail: '{{ .NewEmail }}' }
    },
    { file: 'reset-password', supabase: 'Reset password', template: 'auth-recovery', params: { actionUrl: URL_SENTINEL, token: TOKEN } },
    { file: 'reauthentication', supabase: 'Reauthentication', template: 'auth-reauthentication', params: { token: TOKEN } },
    { file: 'password-changed', supabase: 'Password changed', template: 'auth-security-notice', params: { notice: 'password_changed', email: '{{ .Email }}' } },
    {
      file: 'email-changed',
      supabase: 'Email address changed',
      template: 'auth-security-notice',
      params: { notice: 'email_changed', oldEmail: '{{ .OldEmail }}', newEmail: '{{ .Email }}', email: '{{ .Email }}' }
    },
    {
      file: 'phone-changed',
      supabase: 'Phone number changed',
      template: 'auth-security-notice',
      params: { notice: 'phone_changed', oldPhone: '{{ .OldPhone }}', phone: '{{ .Phone }}', email: '{{ .Email }}' }
    },
    {
      file: 'identity-linked',
      supabase: 'Sign-in method linked',
      template: 'auth-security-notice',
      params: { notice: 'identity_linked', provider: '{{ .Provider }}', email: '{{ .Email }}' }
    },
    {
      file: 'identity-unlinked',
      supabase: 'Sign-in method removed',
      template: 'auth-security-notice',
      params: { notice: 'identity_unlinked', provider: '{{ .Provider }}', email: '{{ .Email }}' }
    },
    {
      file: 'mfa-factor-enrolled',
      supabase: 'Verification method added',
      template: 'auth-security-notice',
      params: { notice: 'mfa_factor_enrolled', factorType: '{{ .FactorType }}', email: '{{ .Email }}' }
    },
    {
      file: 'mfa-factor-unenrolled',
      supabase: 'Verification method removed',
      template: 'auth-security-notice',
      params: { notice: 'mfa_factor_unenrolled', factorType: '{{ .FactorType }}', email: '{{ .Email }}' }
    }
  ];

  mkdirSync(OUT_DIR, { recursive: true });
  const rows: string[] = [];
  for (const t of TEMPLATES) {
    const { subject, html } = renderEmail(t.template, t.params);
    const body = html.split(URL_SENTINEL).join(URL_VAR);
    if (body.includes('supabase-confirmation-url.invalid')) throw new Error(`${t.file}: URL placeholder leaked`);
    writeFileSync(resolve(OUT_DIR, `${t.file}.html`), body, 'utf8');
    rows.push(`<tr><td>${t.supabase}</td><td><a href="./${t.file}.html">${t.file}.html</a></td><td><code>${escapeCell(subject)}</code></td></tr>`);
    console.log(`✓ ${t.file}.html  [${t.supabase}]  subject: ${subject}`);
  }

  const index = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supabase email templates</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left;font-size:14px}
th{background:#eeece6}a{color:inherit;text-underline-offset:3px}code{overflow-wrap:anywhere}p{line-height:1.5}@media(max-width:570px){td,th{padding:5px;font-size:12px}}@media(prefers-color-scheme:dark){body{background:#22211f;color:#f7f6f1}td,th{border-color:#59574f}th{background:#35342f}}</style>
<h1>Supabase Auth email templates (SMTP fallback)</h1>
<p>Generated by <code>scripts/email-preview.ts --supabase</code>. Only needed while the Send Email Hook is
<strong>off</strong> (Supabase then sends over SMTP with these). Paste each file's HTML into Supabase →
Authentication → Emails → the template named in the first column, and its subject into the Subject field.
Opening the files here shows raw <code>{{ … }}</code> placeholders — Supabase fills them at send time.</p>
<table><thead><tr><th>Supabase template</th><th>File</th><th>Subject</th></tr></thead><tbody>
${rows.join('\n')}
</tbody></table>`;
  writeFileSync(resolve(OUT_DIR, 'index.html'), index, 'utf8');
  console.log(`\nWrote ${TEMPLATES.length} Supabase templates + index.html to ${OUT_DIR}`);
}
