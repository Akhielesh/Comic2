// Brand tokens for transactional email, mirrored from the app's Tailwind config
// (tailwind.config.cjs → theme.extend.colors.brand + fontFamily) so the inbox looks
// like the product: comic-book yellow/blue/red on heavy black outlines, the Bangers
// display wordmark, Comic Neue / Inter body type.
//
// Everything here is a plain string — no runtime deps — so this module bundles cleanly
// into a Cloudflare Worker AND typechecks/tests under the root Vite/Vitest config.

export interface BrandConfig {
  /** Display name shown in headers, footers and the default From name. */
  productName: string;
  /** One-liner used as the email preheader fallback. */
  tagline: string;
  /** Public app/marketing origin, e.g. https://dreamstream.studio (no trailing slash). */
  appUrl: string;
  /** Where "reply" / "need help?" points. */
  supportEmail: string;
  /** Legal/company name for the footer copyright line. */
  companyName: string;
  /** Postal address line for CAN-SPAM / CASL compliance (shown in the footer when set). */
  companyAddress: string;
  /** Optional hosted logo (PNG/JPG, ~480px wide). Falls back to a CSS wordmark when empty. */
  logoUrl: string;
}

/** Comic-house palette — keep in sync with tailwind.config.cjs `brand` + `studio`. */
export const COLORS = {
  blue: '#3B82F6',
  blueDark: '#2563EB',
  yellow: '#FACC15',
  red: '#EF4444',
  black: '#18181b',
  white: '#ffffff',
  paper: '#ffffff',
  ink: '#18181b',
  muted: '#52525b',
  pageBg: '#3B82F6',
  footerBg: '#18181b',
  footerText: '#a1a1aa',
  footerLink: '#FACC15',
  boxBg: '#fffbe9' // pale yellow info panels
} as const;

// Web fonts degrade in most email clients, so every stack ends in a universally
// available fallback (Impact / Arial Black for the comic display, Arial for body).
export const FONT_DISPLAY = "'Bangers', 'Impact', 'Arial Black', Haettenschweiler, sans-serif";
export const FONT_BODY = "'Comic Neue', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif";

export const DEFAULT_BRAND: BrandConfig = {
  productName: 'DreamStream Studio',
  tagline: 'Comics, AI Chat & Code — one studio.',
  appUrl: 'https://dreamstream.studio',
  supportEmail: 'support@dreamstream.studio',
  companyName: 'DreamStream Studio',
  companyAddress: '',
  logoUrl: ''
};

/** Merge partial overrides (e.g. from Worker `vars`) onto the defaults. */
export const resolveBrand = (overrides?: Partial<BrandConfig>): BrandConfig => ({
  ...DEFAULT_BRAND,
  ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, v]) => v != null && v !== ''))
});
