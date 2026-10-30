/**
 * `@dreamstream/platform-core/email`: render a draft (`renderEmail` → `{html, text}`), its plain-text body
 * (`emailToPlainText`), the recipient and link review (`reviewEmail`), and the built-in templates (`fillTemplate`).
 * Pure, zero network calls, and nothing here can send: agents draft, people send from their own mail client.
 */
export { renderEmail, emailStyleOf, imageSource } from './render.js';
export type { RenderEmailOptions } from './render.js';
export { emailToPlainText } from './plainText.js';
export { reviewEmail, addressesIn, mailtoRecipients, EMAIL_WARNING_CODES } from './review.js';
export type { EmailWarningCode } from './review.js';
export { EMAIL_TEMPLATES, EMAIL_TEMPLATE_IDS, SLOT_PATTERN, TemplateDefinitionError, emailTemplate, fillEmailTemplate, fillTemplate } from './templates.js';
export type { EmailTemplate, EmailTemplateId, EmailTemplateSlots, FillTemplateResult, TemplateSlotValues } from './templates.js';
export { CONTENT_WIDTH, cleanText, escapeHtml, safeUrl } from './layout.js';
export type { EmailStyle } from './layout.js';
