export interface BrandConfig {
  /** Display name shown in headers, footers and the default From name. */
  productName: string;
  /** One-liner used as the email preheader fallback. */
  tagline: string;
  /** Public app/marketing origin, e.g. https://dreamstreamstudio.ai (no trailing slash). */
  appUrl: string;
  /** Where "reply" / "need help?" points. */
  supportEmail: string;
  /** Legal/company name for the footer copyright line. */
  companyName: string;
  /** Postal address line for CAN-SPAM / CASL compliance (shown in the footer when set). */
  companyAddress: string;
  /** Optional hosted wordmark. DreamStream uses its checked-in PNG mark and a live text lockup by default. */
  logoUrl: string;
}

/** Atlas neutrals from index.css. Older callers may still use the named button aliases. */
export const COLORS = {
  blue: '#0a0a0a',
  blueDark: '#0a0a0a',
  yellow: '#facc15',
  red: '#af3748',
  black: '#0a0a0a',
  white: '#ffffff',
  paper: '#ffffff',
  ink: '#0a0a0a',
  muted: '#5c5c5c',
  pageBg: '#fafafa',
  footerBg: '#fafafa',
  footerText: '#5c5c5c',
  footerLink: '#0a0a0a',
  boxBg: '#f4f4f4',
  line: '#dedede'
} as const;

export const FONT_DISPLAY = "'Segoe UI', Helvetica, Arial, sans-serif";
export const FONT_BODY = "Arial, Helvetica, sans-serif";

export const DEFAULT_BRAND: BrandConfig = {
  productName: 'DreamStream Studio',
  tagline: 'DreamStream Studio',
  appUrl: 'https://dreamstreamstudio.ai',
  supportEmail: 'support@dreamstreamstudio.ai',
  companyName: 'DreamStream Studio',
  companyAddress: '',
  logoUrl: ''
};

/** Merge partial overrides (e.g. from Worker `vars`) onto the defaults. */
export const resolveBrand = (overrides?: Partial<BrandConfig>): BrandConfig => ({
  ...DEFAULT_BRAND,
  ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, v]) => v != null && v !== ''))
});
