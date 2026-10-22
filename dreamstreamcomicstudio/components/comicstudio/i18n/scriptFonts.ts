// Lazy per-script lettering fonts (i18n.md §6.1; owner decision: Noto per script). Owner: P1-I18N.
//
// Latin lettering faces are self-hosted (@fontsource, loaded by the lettering font loader). Every
// other script uses its Noto family from the Google Fonts CSS2 API — the host index.html already
// uses, so the CSP needs no change — and loads ONLY when a language in that script is rendered:
//   1. one deduped <link rel="stylesheet"> per family set (display=swap),
//   2. document.fonts.load(`<weight> 16px "<family>"`, sampleText) for each face — WITH the real
//      text, because Indic and CJK faces are split into unicode-range slices,
//   3. bounded by timeoutMs. Never rejects: `degraded: true` means some face did not arrive in
//      time and a fallback font may be used (callers say so, e.g. the export dialog).

import { languageSpec } from '../../../shared/comic/languages';
import { FONT_REGISTRY, type FontFaceMeta } from '../../../shared/comic/lettering/fonts';
import type { FontId } from '../../../shared/comic/lettering/style';

export type FontRole = 'dialogue' | 'legible' | 'sfx';

export const GOOGLE_FONTS_CSS2 = 'https://fonts.googleapis.com/css2';
const GSTATIC = 'https://fonts.gstatic.com';
/** Weights lettering uses (regular captions, bold dialogue, extra-bold SFX), intersected with what a face ships. */
const WANTED_WEIGHTS = [400, 700, 800];
const DEFAULT_TIMEOUT_MS = 3500;

/** CSS font-family stack for a language's role face (`"Noto Sans Telugu", system-ui, sans-serif`). */
export const cssFontFamily = (lang: string, role: FontRole): string => {
  const id = languageSpec(lang)?.fonts[role];
  const meta = (id && FONT_REGISTRY[id]) || FONT_REGISTRY['comic-neue'];
  return `"${meta.family}", ${meta.fallback}`;
};

/** Weights to request for a face (never one it doesn't ship: no faux bold). */
export const weightsFor = (meta: FontFaceMeta): number[] => {
  const w = meta.weights.filter((x) => WANTED_WEIGHTS.includes(x));
  return w.length ? w : meta.weights.slice(0, 1);
};

/** Google-hosted faces for these languages/roles (Latin fontsource faces are excluded), deduped. */
export const googleFacesFor = (langs: readonly string[], roles: readonly FontRole[]): FontFaceMeta[] => {
  const ids = new Set<FontId>();
  for (const lang of langs) {
    const spec = languageSpec(lang);
    if (!spec) continue;
    for (const role of roles) ids.add(spec.fonts[role]);
  }
  return [...ids]
    .map((id) => FONT_REGISTRY[id])
    .filter((m): m is FontFaceMeta => !!m && m.source === 'google-css2')
    .sort((a, b) => a.family.localeCompare(b.family));
};

/** One CSS2 URL for a set of faces: `…/css2?family=Noto+Sans+Telugu:wght@400;700;800&display=swap`. */
export const googleFontsHref = (faces: readonly FontFaceMeta[]): string | null => {
  if (!faces.length) return null;
  const families = faces.map((m) => `family=${encodeURIComponent(m.family).replace(/%20/g, '+')}:wght@${weightsFor(m).join(';')}`);
  return `${GOOGLE_FONTS_CSS2}?${families.join('&')}&display=swap`;
};

const injected = new Set<string>();

/** Insert the stylesheet once (and a gstatic preconnect). Returns false when there is no DOM. */
export function injectStylesheet(href: string): boolean {
  if (typeof document === 'undefined' || !document.head) return false;
  const present = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).some((l) => l.getAttribute('href') === href);
  if (injected.has(href) || present) {
    injected.add(href);
    return true;
  }
  if (!document.head.querySelector(`link[rel="preconnect"][href="${GSTATIC}"]`)) {
    const pre = document.createElement('link');
    pre.rel = 'preconnect';
    pre.href = GSTATIC;
    pre.crossOrigin = 'anonymous';
    document.head.appendChild(pre);
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.dsScriptFonts = '1';
  document.head.appendChild(link);
  injected.add(href);
  return true;
}

/** Test hook: forget what was injected. */
export const resetScriptFonts = () => injected.clear();

const sample = (text: string) => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > 240 ? t.slice(0, 240) : t;
};

/**
 * Make sure the faces for these languages/roles are loaded before measuring or drawing text
 * (canvas measures with whatever font is ready). Never rejects; `degraded: true` means some
 * face did not load in time and a fallback font may be used.
 */
export const ensureFontsFor = async (langs: string[], roles: FontRole[], sampleText: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ degraded: boolean }> => {
  const faces = googleFacesFor(langs, roles);
  if (!faces.length) return { degraded: false };
  const href = googleFontsHref(faces)!;
  if (!injectStylesheet(href)) return { degraded: false };
  const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
  if (!fonts || typeof fonts.load !== 'function') return { degraded: false };
  const text = sample(sampleText) || SAMPLE_TEXT[langs[0]] || ' ';
  const loads = faces.flatMap((m) =>
    weightsFor(m).map((w) =>
      fonts
        .load(`${w} 16px "${m.family}"`, text)
        .then((list) => list.length > 0)
        .catch(() => false)
    )
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
  });
  const result = await Promise.race([Promise.all(loads), timeout]);
  if (timer) clearTimeout(timer);
  if (result === 'timeout') return { degraded: true };
  return { degraded: result.some((ok) => !ok) };
};

/** A short real sentence per language (font lab, previews, and the default sample for unicode-range slices). */
export const SAMPLE_TEXT: Readonly<Record<string, string>> = {
  en: 'Where did the moon go? Look — up there!',
  hi: 'नमस्ते दोस्त! चलो चाँद तक चलें।',
  te: 'నమస్కారం నేస్తం! చంద్రుడి దాకా వెళ్దాం.',
  ta: 'வணக்கம் நண்பா! நிலா வரை போகலாம்.',
  kn: 'ನಮಸ್ಕಾರ ಗೆಳೆಯ! ಚಂದ್ರನವರೆಗೆ ಹೋಗೋಣ.',
  ml: 'നമസ്കാരം കൂട്ടുകാരാ! നമുക്ക് ചന്ദ്രനിലേക്ക് പോകാം.',
  mr: 'नमस्कार मित्रा! चला चंद्रापर्यंत जाऊया.',
  bn: 'নমস্কার বন্ধু! চলো চাঁদ পর্যন্ত যাই।',
  gu: 'નમસ્તે મિત્ર! ચાલો ચાંદ સુધી જઈએ.',
  pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਦੋਸਤ! ਚਲੋ ਚੰਨ ਤੱਕ ਚੱਲੀਏ।',
  ur: 'سلام دوست! چلو چاند تک چلیں۔',
  es: '¡Hola, amigo! ¿Vamos a la luna?',
  fr: 'Salut l’ami ! On va jusqu’à la lune ?',
  pt: 'Olá, amigo! Vamos até a lua?',
  de: 'Hallo, Freund! Gehen wir zum Mond? Grüße!',
  id: 'Halo, teman! Ayo pergi ke bulan!',
  ja: 'こんにちは、ともだち！月までいこう。',
  ko: '안녕, 친구! 달까지 가자.',
  'zh-Hans': '你好，朋友！我们去月亮吧。',
  ar: 'مرحبا يا صديقي! هيا نذهب إلى القمر.'
};
