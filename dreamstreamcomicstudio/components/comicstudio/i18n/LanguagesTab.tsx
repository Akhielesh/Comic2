// Board tab "Languages" (i18n.md §10.1, as amended). Owner: P1-I18N.
//
//   header      "Written in English" + Change… (relabel for free / make a complete translation the source)
//   lettering   overlay lettering is REQUIRED for translated editions: in-art pages get a quoted
//               "redraw without text" (or a free switch before anything is drawn); a painted cover
//               gets the one-time quoted textless cover with an editable title per language
//   add         searchable list (endonym + English, "Popular in India" first) → live server quote →
//               "Translate · ≈ $X" (the price is on the button; the server re-checks it)
//   editions    progress, stale/missing/flagged chips, readiness (publishable = translated + reviewed),
//               Review, Translate missing · ≈ $X, register, remove
//   glossary    drawer: terms × languages; a rename propagates for free
// Quotes come from GET /translation-quote when the tab opens or the work changes — never on a timer.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookA, CheckCircle2, ChevronRight, Globe, Languages, LoaderCircle, Search, Trash2, TriangleAlert, X } from 'lucide-react';
import type { ComicDoc, TranslationRegister } from '../../../shared/comic/doc';
import { editionProgress, editionReadiness, i18nOf } from '../../../shared/comic/i18n';
import { LANGUAGES, dirOf, languageSpec, sameLanguage, scriptOf, type LanguageSpec } from '../../../shared/comic/languages';
import { estimateJobs } from '../../../shared/comic/models';
import { useCostFormat } from '../conversation/cost';
import { amountInSentence } from '../../../services/costDisplay';
import { getTranslationQuote, type TranslationQuote } from '../studioApi';
import { EmptyHint, GhostButton, PrimaryButton, SectionTitle, Surface, cx } from '../board/ui';
import type { StudioController } from '../types';
import { GlossaryDrawer } from './GlossaryDrawer';
import { TranslationReview } from './TranslationReview';

const REGISTERS: { id: TranslationRegister; label: string }[] = [
  { id: 'everyday', label: 'Everyday speech' },
  { id: 'formal', label: 'Polished, formal' },
  { id: 'code_mixed', label: 'Mixed with English' }
];

const POPULAR_WORLD = ['es', 'fr', 'pt', 'de', 'id', 'ja', 'ko', 'zh-Hans', 'ar'];

/** Pages whose words are painted into the art (drawn, in-art lettering, with lines). */
export function inArtPages(doc: ComicDoc) {
  if (doc.format.lettering !== 'in_art') return [];
  return doc.pages.filter((p) => !!(p.render.asset || p.render.history.length) && p.panels.some((pn) => pn.lines.some((l) => l.text.trim() && !l.noTranslate)));
}

const paintedCover = (doc: ComicDoc) => (doc.cover.lettering ?? 'in_art') === 'in_art' && !!doc.cover.render.asset;

const priceOf = (doc: ComicDoc, kind: 'page' | 'cover', count: number, byok: boolean) =>
  estimateJobs([{ kind, count }], doc.settings.quality, { override: doc.settings.imageModelOverride, byok }).usd;

function useQuote(projectId: string | undefined, langs: string[], key: string) {
  const [state, setState] = useState<{ quote: TranslationQuote | null; loading: boolean; error: string | null }>({ quote: null, loading: false, error: null });
  const [nonce, setNonce] = useState(0);
  const list = langs.join(',');
  useEffect(() => {
    if (!projectId || !list) {
      setState({ quote: null, loading: false, error: null });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const t = setTimeout(() => {
      getTranslationQuote(projectId, list.split(','), { signal: ctrl.signal })
        .then((quote) => setState({ quote, loading: false, error: null }))
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          setState({ quote: null, loading: false, error: err instanceof Error && err.message ? err.message : "Couldn't get a price right now." });
        });
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [projectId, list, key, nonce]);
  return { ...state, retry: () => setNonce((n) => n + 1) };
}

function LanguagePicker({ doc, exclude, onPick }: { doc: ComicDoc; exclude: Set<string>; onPick(code: string): void }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const available = LANGUAGES.filter((l) => !sameLanguage(l.code, doc.format.language) && !exclude.has(l.code));
  const match = (l: LanguageSpec) => !query || l.english.toLowerCase().includes(query) || l.endonym.toLowerCase().includes(query) || l.code.toLowerCase() === query;
  const india = available.filter((l) => l.group === 'india' && match(l));
  const world = available.filter((l) => l.group === 'world' && match(l)).sort((a, b) => POPULAR_WORLD.indexOf(a.code) - POPULAR_WORLD.indexOf(b.code));
  const group = (title: string, list: LanguageSpec[]) =>
    list.length ? (
      <div>
        <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{title}</p>
        <div className="flex flex-wrap gap-1.5">
          {list.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => onPick(l.code)}
              title={l.english}
              className="inline-flex min-h-[36px] max-w-full items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[13px] text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:min-h-[44px] motion-reduce:transition-none"
            >
              <span lang={l.code} dir={dirOf(l.code)} className="break-words">{l.endonym}</span>
              {l.endonym !== l.english && <span className="text-[11.5px] text-[var(--ds-muted)]">{l.english}</span>}
            </button>
          ))}
        </div>
      </div>
    ) : null;
  return (
    <div className="space-y-3">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-muted)]" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search languages (Telugu, తెలుగు, Hindi…)"
          aria-label="Search languages"
          className="h-10 w-full min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] pl-8 pr-3 text-[14px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/60 focus:outline-none coarse:h-11 coarse:text-[16px]"
        />
      </label>
      {group('Popular in India', india)}
      {group('World', world)}
      {!india.length && !world.length && <p className="text-[13px] text-[var(--ds-muted)]">No language matches “{q}”. The studio translates into the 19 languages listed here.</p>}
    </div>
  );
}

/** Share of the dialogue's letters written in `code`'s script (1 when there is too little text to tell). */
export function shareInScript(doc: ComicDoc, code: string): number {
  const text = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines.map((l) => l.text))).join(' ');
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length < 12) return 1;
  const re = scriptOf(code).letters;
  return letters.filter((ch) => re.test(ch)).length / letters.length;
}

/** "Written in English · Change…": relabel (free) or make a complete translation the source (free). */
function SourceLanguage({ studio, doc }: { studio: StudioController; doc: ComicDoc }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const source = languageSpec(doc.format.language);
  const editions = Object.keys(i18nOf(doc).editions);
  const t = languageSpec(target);
  const hasEdition = !!t && editions.includes(t.code);
  const complete = hasEdition && (() => {
    const p = editionProgress(doc, t!.code);
    return !p.missing && !p.stale && !p.staleEdited;
  })();
  // Relabelling says what the lines ARE: lines plainly in another script would be mislabelled, never translated.
  const otherScript = !!t && !hasEdition && shareInScript(doc, t.code) < 0.5;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 py-1.5 text-[13px]">
          <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />
          <span className="min-w-0 truncate">
            Written in <strong lang={source?.code} dir={dirOf(source?.code)}>{source?.endonym || doc.format.language}</strong>
            {source && source.endonym !== source.english ? ` (${source.english})` : ''}
          </span>
        </span>
        <GhostButton size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="coarse:h-11">
          Change…
        </GhostButton>
      </div>
      {open && (
        <div className="mt-2 space-y-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3 text-[13px]">
          <label className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-[var(--ds-muted)]">The comic's language:</span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-9 min-w-0 max-w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 coarse:h-11 coarse:text-[16px]"
              aria-label="New comic language"
            >
              <option value="">Choose…</option>
              {LANGUAGES.filter((l) => !sameLanguage(l.code, doc.format.language)).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.endonym === l.english ? l.english : `${l.endonym} — ${l.english}`}
                </option>
              ))}
            </select>
          </label>
          {t && (
            <div className="flex flex-col gap-2">
              <GhostButton
                size="sm"
                disabled={hasEdition || otherScript}
                title={hasEdition ? `There is a ${t.english} translation — make it the original instead.` : undefined}
                onClick={() => {
                  void studio.patch([{ op: 'format', patch: { language: t.code } }], { label: `Comic language: ${t.english}` });
                  setOpen(false);
                }}
                className="justify-start whitespace-normal text-left coarse:min-h-[44px]"
              >
                The lines are already in {t.english} — just relabel (free)
              </GhostButton>
              {otherScript && (
                <p className="text-[12px] leading-snug text-[var(--ds-muted)]">
                  The lines are written in {source?.english || 'another language'}, not {t.english}. Add {t.english} as a translation below, then make it the original — relabelling would only mislabel them.
                </p>
              )}
              <GhostButton
                size="sm"
                disabled={!complete}
                title={!complete ? `Translate everything into ${t.english} first.` : undefined}
                onClick={() => {
                  void studio.act({ type: 'swap_source_language', lang: t.code });
                  setOpen(false);
                }}
                className="justify-start whitespace-normal text-left coarse:min-h-[44px]"
              >
                Make the {t.english} translation the original (free{complete ? '' : ' once it is complete'})
              </GhostButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Overlay lettering is required for translated editions; a painted cover gets a one-time textless redraw. */
function LetteringNotices({ studio, doc }: { studio: StudioController; doc: ComicDoc }) {
  const [confirming, setConfirming] = useState<'pages' | 'cover' | null>(null);
  const byok = !!studio.caps?.byok;
  // Prices in the viewer's terms: governed users read a share of their usage, never dollars.
  const cost = useCostFormat(studio);
  const pages = inArtPages(doc);
  const editions = Object.keys(i18nOf(doc).editions).length > 0;
  const notices: React.ReactNode[] = [];
  if (doc.format.lettering === 'in_art') {
    if (!pages.length) {
      notices.push(
        <div key="free" className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1">Translated editions need overlay lettering (software balloons). Nothing is drawn yet, so switching is free.</p>
          <PrimaryButton size="sm" className="coarse:h-11" onClick={() => void studio.patch([{ op: 'format', patch: { lettering: 'overlay' } }], { label: 'Overlay lettering' })}>
            Use overlay lettering
          </PrimaryButton>
        </div>
      );
    } else {
      const usd = priceOf(doc, 'page', pages.length, byok);
      notices.push(
        <div key="pages" className="space-y-2">
          <p>
            <strong>Translated editions need overlay lettering.</strong> {pages.length === 1 ? 'Page' : `${pages.length} pages`} {pages.length === 1 ? 'has' : 'have'} the words painted into the art, so readers of a translation would still see the original words. Redrawing {pages.length === 1 ? 'it' : 'them'} without text costs {amountInSentence(cost.approx(usd))} once; after that every language — including this one — gets exact, editable balloons for free.
          </p>
          {confirming === 'pages' ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Confirm the redraw">
              <PrimaryButton
                size="sm"
                className="coarse:h-11"
                onClick={async () => {
                  setConfirming(null);
                  await studio.patch([{ op: 'format', patch: { lettering: 'overlay' } }], { label: 'Overlay lettering' });
                  await studio.act({ type: 'render_pages', pageIds: pages.map((p) => p.id), quotedUsd: usd });
                }}
              >
                Redraw {pages.length === 1 ? 'page' : `${pages.length} pages`} · {cost.approx(usd)}
              </PrimaryButton>
              <GhostButton size="sm" className="coarse:h-11" onClick={() => setConfirming(null)}>
                Not now
              </GhostButton>
            </div>
          ) : (
            <GhostButton size="sm" className="coarse:h-11" onClick={() => setConfirming('pages')}>
              Convert to overlay lettering…
            </GhostButton>
          )}
        </div>
      );
    }
  }
  if (editions && paintedCover(doc)) {
    const usd = priceOf(doc, 'cover', 1, byok);
    notices.push(
      <div key="cover" className="space-y-2">
        <p>
          The cover title is painted in {languageSpec(doc.format.language)?.english || 'the original language'}. A textless cover with an editable title costs {amountInSentence(cost.approx(usd))} once; every language's title is free after that. (Optional — the reader shows the translated title either way.)
        </p>
        {confirming === 'cover' ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Confirm the cover redraw">
            <PrimaryButton
              size="sm"
              className="coarse:h-11"
              onClick={() => {
                setConfirming(null);
                void studio.act({ type: 'render_cover', textless: true, quotedUsd: usd });
              }}
            >
              Textless cover · {cost.approx(usd)}
            </PrimaryButton>
            <GhostButton size="sm" className="coarse:h-11" onClick={() => setConfirming(null)}>
              Keep the painted cover
            </GhostButton>
          </div>
        ) : (
          <GhostButton size="sm" className="coarse:h-11" onClick={() => setConfirming('cover')}>
            Make a textless cover…
          </GhostButton>
        )}
      </div>
    );
  }
  if (!notices.length) return null;
  return (
    <div className="space-y-3 rounded-2xl border border-[#D97757]/35 bg-[#D97757]/10 p-3 text-[13px] leading-snug text-[var(--ds-ink)]" role="region" aria-label="Lettering for translations">
      {notices}
    </div>
  );
}

function EditionRow({ studio, doc, lang, quote, quoteLoading, onReview }: { studio: StudioController; doc: ComicDoc; lang: string; quote?: TranslationQuote['perLanguage'][number]; quoteLoading: boolean; onReview(): void }) {
  const [removing, setRemoving] = useState(false);
  const cost = useCostFormat(studio);
  const spec = languageSpec(lang);
  const edition = i18nOf(doc).editions[lang];
  if (!spec || !edition) return null;
  const p = editionProgress(doc, lang);
  const r = editionReadiness(doc, lang);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
  const work = p.missing + p.stale + p.unreviewed;
  const chips = [
    p.missing ? `${p.missing} missing` : '',
    p.stale + p.staleEdited ? `${p.stale + p.staleEdited} changed` : '',
    p.unreviewed ? `${p.unreviewed} unreviewed` : '',
    p.flagged ? `${p.flagged} flagged` : ''
  ].filter(Boolean);
  const blocking = r.issues.filter((i) => i.blocking && i.code !== 'in_art_pages');
  // Work only the author can settle (no translator, no reviewer) that BLOCKS publishing: lines the review
  // flagged MAJOR ("Looks right" / edit / use the suggestion) and their own edits whose original changed.
  // Minor notes never block, so they stay in the chips only — the button points at what holds the edition.
  const majors = r.issues.find((i) => i.code === 'major_issue')?.count ?? 0;
  const attention = [majors ? `${majors} flagged` : '', p.staleEdited ? `${p.staleEdited} changed` : ''].filter(Boolean);
  return (
    <li className="min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="min-w-0 break-words text-[15px] font-semibold text-[var(--ds-ink)]">
            <span lang={lang} dir={dirOf(lang)}>{spec.endonym}</span>
            {spec.endonym !== spec.english && <span className="ml-1.5 text-[12.5px] font-normal text-[var(--ds-muted)]">{spec.english}</span>}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--ds-well-strong)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${spec.english}: ${pct}% translated`}>
              <div className="h-full rounded-full bg-[var(--ds-accent)]" style={{ width: `${pct}%` }} />
            </div>
            <span className="shrink-0 text-[12px] tabular-nums text-[var(--ds-muted)]">{p.done}/{p.total}</span>
          </div>
        </div>
        <GhostButton size="sm" onClick={onReview} className="coarse:h-11">
          Review
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </GhostButton>
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[12px]">
        {r.publishable ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-600/30 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Ready to publish
          </span>
        ) : (
          <span className="rounded-full border border-[#D97757]/40 px-2 py-0.5 font-medium text-[var(--ds-ink)]">Draft</span>
        )}
        {chips.map((c) => (
          <span key={c} className="rounded-full bg-[var(--ds-well-strong)] px-2 py-0.5 text-[var(--ds-muted)]">
            {c}
          </span>
        ))}
      </div>
      {!r.publishable && blocking.length > 0 && <p className="mt-1.5 text-[12px] leading-snug text-[var(--ds-muted)]">{blocking.map((i) => i.text).join(' ')}</p>}
      <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-2">
        {work > 0 && (
          <PrimaryButton
            size="sm"
            className="coarse:h-11"
            disabled={!quote || quoteLoading}
            busy={quoteLoading && !quote}
            onClick={() => quote && void studio.act({ type: 'translate', languages: [lang], quotedUsd: quote.usd })}
          >
            {p.missing || p.stale ? 'Translate missing' : 'Finish the review'}
            {quote ? ` · ${cost.approx(quote.usd)}` : ''}
          </PrimaryButton>
        )}
        {!r.publishable && attention.length > 0 && (
          <GhostButton size="sm" className="coarse:h-11" onClick={onReview}>
            Review {attention.join(' · ')}
          </GhostButton>
        )}
        <label className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--ds-muted)]">
          <span className="shrink-0">Voice</span>
          <select
            value={edition.register}
            onChange={(e) => void studio.patch([{ op: 'edition', lang, patch: { register: e.target.value as TranslationRegister } }], { label: 'Translation voice' })}
            aria-label={`${spec.english} register (applies to new translations)`}
            title="Applies to new translations"
            className="h-8 min-w-0 max-w-[11rem] rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-1.5 text-[12px] text-[var(--ds-ink)] coarse:h-11 coarse:text-[16px]"
          >
            {REGISTERS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        {removing ? (
          <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={`Remove ${spec.english}`}>
            <span className="text-[12px]">Remove the {spec.english} translation?</span>
            <GhostButton size="xs" tone="danger" className="coarse:h-11" onClick={() => void studio.patch([{ op: 'edition', lang, patch: null }], { label: `Remove ${spec.english}` })}>
              Remove
            </GhostButton>
            <GhostButton size="xs" className="coarse:h-11" onClick={() => setRemoving(false)}>
              Keep
            </GhostButton>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setRemoving(true)}
            aria-label={`Remove the ${spec.english} translation`}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:w-11"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
    </li>
  );
}

export const LanguagesTab: React.FC<{ studio: StudioController }> = ({ studio }) => {
  const doc = studio.doc;
  const [reviewLang, setReviewLang] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const glossaryAnchor = useRef<HTMLDivElement>(null);
  const editions = useMemo(() => (doc ? Object.keys(i18nOf(doc).editions).filter((l) => languageSpec(l)) : []), [doc]);
  // Quote key: changes only when the translatable work changes (not on every keystroke elsewhere).
  const workKey = useMemo(() => {
    if (!doc) return '';
    return editions.map((l) => {
      const p = editionProgress(doc, l);
      return `${l}:${p.missing}:${p.stale}:${p.unreviewed}:${p.total}`;
    }).join('|');
  }, [doc, editions]);
  const needingWork = useMemo(() => (doc ? editions.filter((l) => {
    const p = editionProgress(doc, l);
    return p.missing + p.stale + p.unreviewed > 0;
  }) : []), [doc, editions]);
  const rowsQuote = useQuote(doc?.id, needingWork, workKey);
  const cost = useCostFormat(studio);
  const addQuote = useQuote(doc?.id, pending, `${workKey}#${pending.join(',')}`);

  if (!doc) return null;
  if (reviewLang && editions.includes(reviewLang)) {
    return (
      <div className="min-w-0 p-3 sm:p-4">
        <TranslationReview studio={studio} lang={reviewLang} onBack={() => setReviewLang(null)} onLangChange={setReviewLang} />
      </div>
    );
  }
  const hasLines = doc.pages.some((p) => p.panels.some((pn) => pn.lines.some((l) => l.text.trim())));
  const exclude = new Set([...editions, ...pending]);
  const quoteFor = (lang: string) => rowsQuote.quote?.perLanguage.find((q) => q.lang === lang);

  return (
    <div className="min-w-0 space-y-4 p-3 sm:p-4">
      <Surface className="space-y-3 p-3 sm:p-4">
        <SectionTitle
          icon={<Languages className="h-3.5 w-3.5" />}
          right={
            <div ref={glossaryAnchor} className="relative">
              <GhostButton size="sm" onClick={() => setGlossaryOpen((o) => !o)} aria-expanded={glossaryOpen} className="coarse:h-11">
                <BookA className="h-3.5 w-3.5" aria-hidden />
                Glossary
              </GhostButton>
              <GlossaryDrawer studio={studio} open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
            </div>
          }
        >
          Languages
        </SectionTitle>
        <SourceLanguage studio={studio} doc={doc} />
        <LetteringNotices studio={studio} doc={doc} />
      </Surface>

      {!editions.length && !adding && (
        <EmptyHint
          icon={<Globe className="h-5 w-5" />}
          title="Readers in their own language"
          action={
            hasLines ? (
              <PrimaryButton size="sm" className="coarse:h-11" onClick={() => setAdding(true)}>
                Add a language
              </PrimaryButton>
            ) : undefined
          }
        >
          {hasLines
            ? `Make this comic readable in Hindi, Telugu, Tamil and 16 more languages. Each character keeps their voice, a native-level review checks every line, and ${
                // Governed users never see dollars (P1-LIMITS) — not even in a fixed estimate.
                cost.governed ? 'each language of a 6-page comic takes only a small share of your usage' : 'a 6-page comic costs about $0.05 per language'
              } — anything already translated is free.`
            : 'Plan the pages first — once there is dialogue, it can be translated into Hindi, Telugu, Tamil and 16 more languages. To write the comic natively in another language, change its language above before planning.'}
        </EmptyHint>
      )}

      {editions.length > 0 && (
        <section aria-label="Translations">
          <SectionTitle
            right={
              hasLines && !adding ? (
                <GhostButton size="sm" className="coarse:h-11" onClick={() => setAdding(true)}>
                  Add a language
                </GhostButton>
              ) : undefined
            }
          >
            Translations
          </SectionTitle>
          {rowsQuote.error && needingWork.length > 0 && (
            <p className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--ds-muted)]">
              <TriangleAlert className="h-3.5 w-3.5 text-[var(--ds-accent)]" aria-hidden />
              Couldn't get a price right now.
              <button type="button" className="underline underline-offset-2" onClick={rowsQuote.retry}>
                Try again
              </button>
            </p>
          )}
          <ul className="space-y-2.5">
            {editions.map((lang) => (
              <EditionRow key={lang} studio={studio} doc={doc} lang={lang} quote={quoteFor(lang)} quoteLoading={rowsQuote.loading} onReview={() => setReviewLang(lang)} />
            ))}
          </ul>
        </section>
      )}

      {adding && hasLines && (
        <Surface className="space-y-3 p-3 sm:p-4" aria-label="Add a language">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-[var(--ds-ink)]">Add a language</h3>
            <button
              type="button"
              aria-label="Close"
              onClick={() => {
                setAdding(false);
                setPending([]);
              }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] coarse:h-11 coarse:w-11"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {pending.length > 0 && (
            <div className="space-y-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-2.5">
              <div className="flex flex-wrap gap-1.5">
                {pending.map((code) => {
                  const s = languageSpec(code)!;
                  const q = addQuote.quote?.perLanguage.find((x) => x.lang === code);
                  return (
                    <span key={code} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--ds-raised)] py-1 pl-3 pr-1 text-[13px] shadow-sm">
                      <span lang={code} dir={dirOf(code)} className="break-words">{s.endonym}</span>
                      {q && <span className="text-[11.5px] tabular-nums text-[var(--ds-muted)]">{cost.approx(q.usd)}</span>}
                      <button type="button" aria-label={`Remove ${s.english}`} onClick={() => setPending((p) => p.filter((x) => x !== code))} className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:w-11">
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </span>
                  );
                })}
              </div>
              <p className="text-[12px] leading-snug text-[var(--ds-muted)]">
                {addQuote.loading && !addQuote.quote ? (
                  <span className="inline-flex items-center gap-1"><LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />Pricing…</span>
                ) : addQuote.quote ? (
                  `${addQuote.quote.perLanguage.reduce((n, q) => n + q.lines, 0)} lines for the translator, ${addQuote.quote.perLanguage.reduce((n, q) => n + q.free, 0)} done free by software · every line reviewed · about ${Math.max(5, Math.max(...addQuote.quote.perLanguage.map((q) => q.seconds)))} s${addQuote.quote.byok ? ' · on your key' : ''}`
                ) : addQuote.error ? (
                  <span>
                    {addQuote.error}{' '}
                    <button type="button" className="underline underline-offset-2" onClick={addQuote.retry}>Try again</button>
                  </span>
                ) : null}
              </p>
              <PrimaryButton
                size="sm"
                className="coarse:h-11"
                disabled={!addQuote.quote || addQuote.loading}
                onClick={() => {
                  if (!addQuote.quote) return;
                  void studio.act({ type: 'translate', languages: pending, quotedUsd: addQuote.quote.usd });
                  setPending([]);
                  setAdding(false);
                }}
              >
                Translate{addQuote.quote ? ` · ${cost.approx(addQuote.quote.usd)}` : ''}
              </PrimaryButton>
            </div>
          )}
          <LanguagePicker doc={doc} exclude={exclude} onPick={(code) => setPending((p) => (p.includes(code) || p.length >= 19 ? p : [...p, code]))} />
        </Surface>
      )}
      <p className={cx('px-1 text-[11.5px] leading-snug text-[var(--ds-muted)]', !editions.length && 'hidden')}>
        Readers pick their language when you publish: a language can be published once it is translated and reviewed.
      </p>
    </div>
  );
};

export default LanguagesTab;
