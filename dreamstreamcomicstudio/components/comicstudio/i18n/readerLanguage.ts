// Reader language choice (i18n.md §11.1). Owner: P1-I18N. Pure helpers + guarded storage/URL glue.
//
// Priority: `?lang=` (validated against the source + published editions) → the reader's stored global
// preference (localStorage 'comicstudio.reader.lang') → the browser's languages (te-IN → te,
// zh-CN → zh-Hans, pt-BR → pt) → the comic's own language. Switching writes the choice back with
// history.replaceState, so a shared link carries the language.

import { useCallback, useMemo, useState } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { editionProgress, editionReadiness, fallbackLineIds, i18nOf, localizeDoc } from '../../../shared/comic/i18n';
import { languageSpec, matchLanguage, sameLanguage } from '../../../shared/comic/languages';
import type { ReaderLanguageSlot } from './ReaderLanguagePicker';

export const READER_LANG_KEY = 'comicstudio.reader.lang';
export type ReaderLanguageReason = 'url' | 'stored' | 'browser' | 'source';

export const pickReaderLanguage = (args: {
  urlLang?: string | null;
  stored?: string | null;
  navigatorLanguages: readonly string[];
  source: string;
  published: readonly string[];
}): { lang: string; reason: ReaderLanguageReason } => {
  const available = [args.source, ...args.published.filter((l) => !sameLanguage(l, args.source))];
  const valid = (raw?: string | null) => (typeof raw === 'string' && raw.length <= 35 && raw.trim() ? matchLanguage([raw.trim()], available) : undefined);
  const fromUrl = valid(args.urlLang);
  if (fromUrl) return { lang: fromUrl, reason: 'url' };
  const fromStore = valid(args.stored);
  if (fromStore) return { lang: fromStore, reason: 'stored' };
  const prefs = (args.navigatorLanguages || []).filter((l): l is string => typeof l === 'string' && l.length <= 35);
  const fromBrowser = matchLanguage(prefs, available);
  if (fromBrowser) return { lang: fromBrowser, reason: 'browser' };
  return { lang: args.source, reason: 'source' };
};

/** The stored global preference (null when absent or storage is unavailable). */
export const readStoredReaderLang = (): string | null => {
  try {
    const v = globalThis.localStorage?.getItem(READER_LANG_KEY);
    return v && v.length <= 35 ? v : null;
  } catch {
    return null;
  }
};

export const storeReaderLang = (lang: string): void => {
  try {
    globalThis.localStorage?.setItem(READER_LANG_KEY, lang);
  } catch {
    /* private mode / quota: the choice still applies for this visit */
  }
};

/** `?lang=` of a search string (validated against the registry; null otherwise). */
export const readUrlLang = (search?: string): string | null => {
  try {
    const s = search ?? (typeof window !== 'undefined' ? window.location.search : '');
    const raw = new URLSearchParams(s).get('lang');
    if (!raw || raw.length > 35) return null;
    return languageSpec(raw)?.code ?? null;
  } catch {
    return null;
  }
};

/** A URL with `lang` set (or removed for the source) — every other param and the hash kept. */
export const urlWithLang = (href: string, lang: string, source: string): string => {
  const url = new URL(href);
  if (sameLanguage(lang, source)) url.searchParams.delete('lang');
  else url.searchParams.set('lang', lang);
  return url.toString();
};

/** Write the language into the address bar without a navigation (shared links carry it). */
export const syncLangToUrl = (lang: string, source: string): void => {
  try {
    if (typeof window === 'undefined' || !window.history?.replaceState) return;
    const next = urlWithLang(window.location.href, lang, source);
    if (next !== window.location.href) window.history.replaceState(window.history.state, '', next);
  } catch {
    /* sandboxed frames may refuse replaceState */
  }
};

/** Languages a reader can choose for this doc: the source first, then editions (publishable only unless drafts). */
export function readerLanguageOptions(doc: ComicDoc, opts: { published?: readonly string[]; includeDrafts?: boolean } = {}): ReaderLanguageSlot['options'] {
  const source = doc.format.language;
  const sourceSpec = languageSpec(source);
  const out: ReaderLanguageSlot['options'] = [{ code: source, label: sourceSpec?.english || source, native: sourceSpec?.endonym, status: 'ready' }];
  const editions = opts.published ?? Object.keys(i18nOf(doc).editions);
  for (const code of editions) {
    if (sameLanguage(code, source) || out.some((o) => o.code === code)) continue;
    const spec = languageSpec(code);
    if (!spec) continue;
    const ready = opts.published ? true : editionReadiness(doc, code).publishable;
    if (!ready && !opts.includeDrafts) continue;
    out.push({ code, label: spec.english, native: spec.endonym, ...(ready ? { status: 'ready' as const } : { percent: translatedPercent(doc, code) }) });
  }
  return out;
}

/** "92% translated" for an edition (drafts in the owner preview). */
export const translatedPercent = (doc: ComicDoc, lang: string): number => {
  const p = editionProgress(doc, lang);
  return p.total ? Math.floor((p.done / p.total) * 100) : 100;
};

/** The next language in the list (the reader's `L` shortcut). */
export const nextLanguage = (options: ReaderLanguageSlot['options'], current: string): string | undefined => {
  if (options.length < 2) return undefined;
  const i = options.findIndex((o) => sameLanguage(o.code, current));
  return options[(i + 1) % options.length].code;
};

export interface UseReaderLanguageArgs {
  doc: ComicDoc | null | undefined;
  /** Published editions (the public reader / share link). Omit in the studio: every publishable edition. */
  published?: readonly string[];
  /** Studio preview: drafts are offered too (marked by the missing `status`). */
  includeDrafts?: boolean;
  /** Remember the choice globally and write `?lang=` into the address bar (public reader). Default true. */
  persist?: boolean;
  /** Environment seams for tests (default: window.location.search, localStorage, navigator.languages). */
  env?: { search?: string; stored?: string | null; navigatorLanguages?: readonly string[] };
}

export interface ReaderLanguageState {
  lang: string;
  reason: ReaderLanguageReason | 'picked';
  /** Ready for ImmersiveReader / ReaderHud / ReaderLanguagePicker; undefined with a single language. */
  slot?: ReaderLanguageSlot;
  /** The doc as this reader sees it (localizeDoc; the same object for the source language). */
  localized: ComicDoc | null;
  /** Lines shown in the original language (draft previews only; a published edition has none). */
  fallback: string[];
  setLang(code: string): void;
}

/**
 * Everything a reader surface needs for the language switch in one hook: the initial pick
 * (`?lang=` → stored preference → browser → source, validated against what is actually offered),
 * the picker slot, the localized doc, and a setter that remembers the choice and updates the URL
 * with replaceState (no navigation, no reload; only the words change — the art and position stay).
 */
export function useReaderLanguage({ doc, published, includeDrafts, persist = true, env }: UseReaderLanguageArgs): ReaderLanguageState {
  const [picked, setPicked] = useState<string | null>(null);
  const source = doc?.format.language || 'en';
  const publishedKey = published ? published.join(',') : null;
  const options = useMemo(
    () => (doc ? readerLanguageOptions(doc, { published: publishedKey === null ? undefined : publishedKey.split(',').filter(Boolean), includeDrafts }) : []),
    [doc, publishedKey, includeDrafts]
  );
  const codes = options.map((o) => o.code).join(',');
  const initial = useMemo(() => {
    const available = codes.split(',').filter(Boolean);
    const navigatorLanguages = env?.navigatorLanguages ?? (typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : []);
    return pickReaderLanguage({
      urlLang: readUrlLang(env?.search),
      stored: persist ? (env && 'stored' in env ? env.stored ?? null : readStoredReaderLang()) : null,
      navigatorLanguages: navigatorLanguages.filter((l): l is string => typeof l === 'string'),
      source,
      published: available.filter((c) => !sameLanguage(c, source))
    });
    // The environment is read once per offered set (a new doc or a new published list re-picks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes, source, persist]);
  const pickedValid = !!picked && options.some((o) => sameLanguage(o.code, picked));
  const lang = pickedValid ? options.find((o) => sameLanguage(o.code, picked!))!.code : initial.lang;
  const reason: ReaderLanguageState['reason'] = pickedValid ? 'picked' : initial.reason;

  const setLang = useCallback(
    (code: string) => {
      setPicked(code);
      if (!persist) return;
      storeReaderLang(code);
      syncLangToUrl(code, source);
    },
    [persist, source]
  );
  const localized = useMemo(() => (doc ? localizeDoc(doc, lang) : null), [doc, lang]);
  const fallback = useMemo(() => (localized && localized !== doc ? fallbackLineIds(localized) : []), [localized, doc]);
  const slot = useMemo<ReaderLanguageSlot | undefined>(() => (options.length > 1 ? { current: lang, options, onChange: setLang } : undefined), [options, lang, setLang]);
  return { lang, reason, slot, localized, fallback, setLang };
}
