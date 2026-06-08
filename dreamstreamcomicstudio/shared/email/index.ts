// Public surface of the shared email module — imported by the Cloudflare email-worker,
// the backend mailer (for typing), and the preview script. Pure & dependency-free.

export type { BrandConfig } from './theme.js';
export { DEFAULT_BRAND, resolveBrand, COLORS } from './theme.js';
export {
  renderEmail,
  isEmailTemplateName,
  isMarketing,
  EMAIL_TEMPLATE_NAMES,
  TEMPLATE_KIND
} from './templates.js';
export type { EmailTemplateName, EmailKind, EmailParams, RenderedEmail } from './templates.js';
