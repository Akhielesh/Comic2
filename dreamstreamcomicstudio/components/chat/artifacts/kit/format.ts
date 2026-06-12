// Shared formatters for rich-output components. Centralizing these keeps number/
// date rendering consistent across cards (and gives the AI's free-coded components
// the same helpers to import).

/** 51_000_000 → "51M", 3_120_000_000_000 → "3.12T". */
export const compactNumber = (n?: number): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', INR: '₹', KRW: '₩', CHF: 'CHF '
};

/** Format a price with the right number of decimals + currency symbol. */
export const formatPrice = (n?: number, currency = 'USD'): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const sym = CURRENCY_SYMBOLS[currency] ?? '';
  const decimals = Math.abs(n) >= 1000 || currency === 'JPY' || currency === 'KRW' ? 0 : 2;
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

/** Like formatPrice, but compacts large values ("$3.12T") so table columns don't overflow. */
export const formatPriceCompact = (n?: number, currency = 'USD'): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) {
    const sym = CURRENCY_SYMBOLS[currency] ?? '';
    return `${sym}${compactNumber(n)}`;
  }
  return formatPrice(n, currency);
};

/** Signed percent, e.g. "+1.39%". */
export const formatPercent = (n?: number, decimals = 2): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
};

/** Signed absolute change, e.g. "+2.80". */
export const formatSigned = (n?: number, decimals = 2): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}`;
};

/** "3h ago", "2d ago", "just now" from an ISO timestamp. */
export const relativeTime = (iso?: string): string => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** A short, locale-aware date label for chart axes / tooltips. */
export const shortDate = (value: string): string => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * Scheme-validated href for links whose URL originates from LLM/tool output.
 * Artifact data is model-writable, so a prompt-injected `javascript:` (or
 * `data:`/`vbscript:`) URL must never reach an <a href>. Allows http(s),
 * mailto, and same-origin relative/anchor paths; everything else → undefined
 * (renderers then drop the link and show plain text).
 */
export const safeHref = (raw?: string | null): string | undefined => {
  const url = (raw ?? '').trim();
  if (!url) return undefined;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith('/') || url.startsWith('#')) return url;
  return undefined;
};
