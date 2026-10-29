// Translation review (i18n.md §10.1). Owner: P1-I18N.
//
// One edition, line by line: the speaker and the source, an editable translation in the edition's
// own font and direction, the linguist's gloss ("Means: …" — what it really says), status, the
// review's issue with one-tap "Use suggestion" / "Looks right", and a fit meter for the balloon.
// The page preview shows the art lettered IN THAT LANGUAGE (localizeDoc). Enter saves and moves on,
// Esc reverts, J/K (or Alt+↓/↑ inside a field) move between lines. Edits are free ('edited' lines
// are never overwritten by a later translation).

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Eye, Lightbulb, Undo2 } from 'lucide-react';
import type { ComicDoc, EditionTextField, Line, Page, TextTranslation } from '../../../shared/comic/doc';
import { editionReadiness, i18nOf, localizeDoc, translationStatus, type DerivedStatus } from '../../../shared/comic/i18n';
import { dirOf, languageSpec } from '../../../shared/comic/languages';
import { graphemes } from '../../../shared/comic/textLayout';
import { AUTO_CORRECTED_NOTE, editionTextEntry, editionTextSource, translationBudget } from '../../../shared/comic/translationPlan';
import { textSourceHash } from '../../../shared/comic/i18n';
import { ComicPageView } from '../board/ComicPageView';
import { GhostButton, Segmented, cx } from '../board/ui';
import type { StudioController } from '../types';
import { LanguageSwitch } from './LanguageSwitch';
import { cssFontFamily } from './scriptFonts';

export interface TranslationReviewProps {
  studio: StudioController;
  lang: string;
  onBack(): void;
  onLangChange(lang: string): void;
}

type Filter = 'all' | 'attention';

const STATUS_LABEL: Partial<Record<DerivedStatus, string>> = {
  missing: 'Not translated',
  stale: 'Original changed',
  stale_edited: 'Original changed (your edit kept)',
  machine: 'Waiting for review',
  reviewed: 'Reviewed',
  edited: 'Your edit'
};

const STATUS_TONE: Partial<Record<DerivedStatus, string>> = {
  missing: 'border-[#D97757]/40 text-[var(--ds-ink)]',
  stale: 'border-[#D97757]/40 text-[var(--ds-ink)]',
  stale_edited: 'border-[#D97757]/40 text-[var(--ds-ink)]',
  machine: 'border-[var(--ds-hairline)] text-[var(--ds-muted)]',
  reviewed: 'border-emerald-600/30 text-emerald-700 dark:text-emerald-300',
  edited: 'border-[var(--ds-hairline)] text-[var(--ds-ink)]'
};

/** "Fits" / "Tight" / "9 too long" for a translation in its balloon. */
export function fitOf(doc: ComicDoc, page: Page, line: Line, lang: string, text: string): { label: string; tone: 'ok' | 'tight' | 'over'; over: number } {
  const budget = translationBudget(doc, page, line, lang);
  const n = graphemes(text, lang).length;
  if (n <= budget) return { label: 'Fits', tone: 'ok', over: 0 };
  if (n <= Math.ceil(budget * 1.2)) return { label: 'Tight', tone: 'tight', over: n - budget };
  return { label: `${n - budget} too long`, tone: 'over', over: n - budget };
}

const needsLook = (status: DerivedStatus, t?: TextTranslation) =>
  status === 'missing' || status === 'stale' || status === 'stale_edited' || status === 'machine' || !!t?.issue;

interface RowProps {
  studio: StudioController;
  doc: ComicDoc;
  lang: string;
  id: string;
  speaker?: string;
  kindLabel: string;
  /** "page 2, panel 1": keeps every field's accessible name unique when lines repeat. */
  where?: string;
  source: string;
  entry?: TextTranslation;
  status: DerivedStatus;
  /** Fit of a text in this line's balloon (measured on the DRAFT while typing, not the saved text). */
  fitFor?(text: string): ReturnType<typeof fitOf>;
  onSave(text: string): void;
  onNavigate(id: string, dir: 1 | -1): void;
  registerField(id: string, el: HTMLTextAreaElement | null): void;
  onFocusRow?(): void;
}

function ReviewRow({ studio, lang, id, speaker, kindLabel, where, source, entry, status, fitFor, onSave, onNavigate, registerField, onFocusRow }: RowProps) {
  const [draft, setDraft] = useState(entry?.text ?? '');
  const [busy, setBusy] = useState(false);
  const saved = entry?.text ?? '';
  React.useEffect(() => setDraft(saved), [saved]);
  const sourceLang = studio.doc?.format.language || 'en';
  const accept = async (useSuggestion: boolean) => {
    setBusy(true);
    try {
      await studio.act({ type: 'accept_translation_issue', lang, lineId: id, useSuggestion });
    } finally {
      setBusy(false);
    }
  };
  /** "Keep my wording": the author's edit still fits the changed original — re-hashed, free, still theirs. */
  const keepWording = () => void accept(false);
  const commit = (viaEnter = false) => {
    const v = draft.trim();
    if (!v || v === saved) {
      setDraft(saved);
      // Enter on your own unchanged wording after the original changed means "yes, it still fits".
      if (viaEnter && v === saved && status === 'stale_edited') keepWording();
      return;
    }
    onSave(v);
  };
  const issue = entry?.issue;
  const auto = !!issue?.note.startsWith(AUTO_CORRECTED_NOTE);
  const fit = fitFor && draft.trim() ? fitFor(draft.trim()) : undefined;
  const spec = languageSpec(lang);
  return (
    <li className="min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-3" data-line-id={id} onFocusCapture={onFocusRow}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">
          {speaker ? `${speaker} · ` : ''}
          {kindLabel}
        </span>
        <span className={cx('ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_TONE[status])}>{STATUS_LABEL[status] || status}</span>
      </div>
      <p lang={sourceLang} dir={dirOf(sourceLang)} className="mt-1.5 break-words text-[13px] leading-snug text-[var(--ds-muted)]">
        {source}
      </p>
      <textarea
        ref={(el) => registerField(id, el)}
        value={draft}
        rows={Math.min(4, Math.max(1, Math.ceil(graphemes(draft || source).length / 38)))}
        lang={lang}
        dir={dirOf(lang)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit(true);
            onNavigate(id, 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(saved);
            (e.target as HTMLTextAreaElement).blur();
          } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            commit();
            onNavigate(id, e.key === 'ArrowDown' ? 1 : -1);
          }
        }}
        maxLength={600}
        placeholder={`Not translated yet — type the ${spec?.english || lang} line`}
        aria-label={`${spec?.english || lang} translation of: ${source}${where ? ` (${where})` : ''}`}
        style={{ fontFamily: cssFontFamily(lang, 'legible') }}
        className="mt-1.5 block w-full min-w-0 resize-y rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-2 text-[15px] leading-relaxed text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] coarse:text-[16px] focus:border-[#D97757]/60 focus:outline-none focus:ring-2 focus:ring-[#D97757]/25"
      />
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {entry?.gloss && (
          <span className="min-w-0 flex-1 break-words italic text-[var(--ds-muted)]">
            Means: <span lang={sourceLang}>{entry.gloss}</span>
          </span>
        )}
        {fit && (
          <span className={cx('ml-auto shrink-0 tabular-nums', fit.tone === 'ok' ? 'text-[var(--ds-muted)]' : fit.tone === 'tight' ? 'text-[var(--ds-ink)]' : 'font-semibold text-[#c2643f]')}>{fit.label}</span>
        )}
      </div>
      {issue && (
        <div className={cx('mt-2 rounded-lg border px-2.5 py-2 text-[12.5px]', issue.severity === 'major' ? 'border-[#D97757]/45 bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-well)]')}>
          <p className="flex items-start gap-1.5 leading-snug">
            <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" aria-hidden />
            <span className="min-w-0 break-words">
              {issue.severity === 'major' && !auto ? <strong>Needs a fix: </strong> : null}
              {issue.note}
            </span>
          </p>
          {issue.suggestion && (
            <p lang={lang} dir={dirOf(lang)} className="mt-1 break-words pl-5 text-[14px]" style={{ fontFamily: cssFontFamily(lang, 'legible') }}>
              {auto ? 'Before: ' : 'Suggestion: '}
              {issue.suggestion}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2 pl-5">
            {issue.suggestion && (
              <GhostButton size="xs" busy={busy} onClick={() => void accept(true)} className="coarse:h-11">
                {auto ? <Undo2 className="h-3.5 w-3.5" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
                {auto ? 'Use the original' : 'Use suggestion'}
              </GhostButton>
            )}
            <GhostButton size="xs" busy={busy} onClick={() => void accept(false)} className="coarse:h-11">
              Looks right
            </GhostButton>
          </div>
        </div>
      )}
      {!issue && status === 'machine' && (
        <div className="mt-2">
          <GhostButton size="xs" busy={busy} onClick={() => void accept(false)} className="coarse:h-11">
            <Check className="h-3.5 w-3.5" aria-hidden />
            Mark reviewed
          </GhostButton>
        </div>
      )}
      {status === 'stale_edited' && (
        <div className="mt-2 rounded-lg border border-[#D97757]/45 bg-[#D97757]/10 px-2.5 py-2 text-[12.5px]">
          <p className="leading-snug">The original changed after you wrote this. If your wording still fits, keep it — a translation run never touches your edits — or change it above.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <GhostButton size="xs" busy={busy} onClick={keepWording} className="coarse:h-11">
              <Check className="h-3.5 w-3.5" aria-hidden />
              Keep my wording
            </GhostButton>
          </div>
        </div>
      )}
    </li>
  );
}

const KIND_LABEL: Record<string, string> = { speech: 'speech', thought: 'thought', caption: 'caption', sfx: 'sound effect', whisper: 'whisper', shout: 'shout' };
const FIELD_LABEL: Record<EditionTextField, string> = { 'brief.title': 'Title', 'brief.logline': 'Logline', 'cover.title': 'Cover title', 'cover.tagline': 'Cover tagline' };

export const TranslationReview: React.FC<TranslationReviewProps> = ({ studio, lang, onBack, onLangChange }) => {
  const doc = studio.doc;
  const [filter, setFilter] = useState<Filter>('all');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  const order = useRef<string[]>([]);
  const registerField = useCallback((id: string, el: HTMLTextAreaElement | null) => {
    if (el) fields.current.set(id, el);
    else fields.current.delete(id);
  }, []);
  const localized = useMemo(() => (doc ? localizeDoc(doc, lang) : null), [doc, lang]);
  if (!doc || !localized) return null;
  const spec = languageSpec(lang);
  const edition = i18nOf(doc).editions[lang];
  const pages = [...doc.pages].sort((a, b) => a.n - b.n);

  const rows: { page: Page; line: Line; status: DerivedStatus; entry?: TextTranslation }[] = [];
  for (const page of pages) {
    for (const panel of [...page.panels].sort((a, b) => a.n - b.n)) {
      for (const line of panel.lines) {
        const status = translationStatus(doc, lang, line);
        if (status === 'not_needed') continue;
        rows.push({ page, line, status, entry: edition?.lines[line.id] });
      }
    }
  }
  const shown = filter === 'all' ? rows : rows.filter((r) => needsLook(r.status, r.entry));
  const overflow = rows.filter((r) => r.entry && fitOf(doc, r.page, r.line, lang, r.entry.text).tone === 'over').map((r) => r.line.id);
  const readiness = editionReadiness(doc, lang, overflow);
  const titleFields = (['brief.title', 'brief.logline', 'cover.title', 'cover.tagline'] as const).filter((f) => editionTextSource(doc, f));
  order.current = [...titleFields, ...shown.map((r) => r.line.id)];

  const navigate = (id: string, dir: 1 | -1) => {
    const i = order.current.indexOf(id);
    const next = order.current[i + dir];
    if (next) fields.current.get(next)?.focus();
  };
  const saveLine = (lineId: string, text: string) => void studio.patch([{ op: 'translation', lang, lineId, patch: { text } }], { label: 'Edit translation' });
  const saveField = (field: EditionTextField, text: string) =>
    void studio.patch([{ op: 'edition_text', lang, field, value: { text, status: 'edited', sourceHash: textSourceHash(editionTextSource(doc, field)), at: Date.now() } }], { label: 'Edit translated title' });

  const previewPage = pages.find((p) => p.id === previewId) || pages[0];
  const editionOptions = Object.keys(i18nOf(doc).editions)
    .map((code) => languageSpec(code))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => ({ code: s.code, label: s.endonym, title: s.english }));

  const onListKey = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      const focusedRow = (e.target as HTMLElement).closest('[data-line-id]')?.getAttribute('data-line-id');
      const target = focusedRow ? order.current[order.current.indexOf(focusedRow) + (e.key === 'j' ? 1 : -1)] : order.current[0];
      if (target) fields.current.get(target)?.focus();
    }
  };

  return (
    <div className="min-w-0" onKeyDown={onListKey}>
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
        <GhostButton size="sm" onClick={onBack} className="coarse:h-11">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Languages
        </GhostButton>
        <h3 className="min-w-0 truncate text-[15px] font-semibold text-[var(--ds-ink)]">
          <span lang={lang} dir={dirOf(lang)}>{spec?.endonym}</span>
          {spec && spec.endonym !== spec.english && <span className="ml-1.5 text-[13px] font-normal text-[var(--ds-muted)]">{spec.english}</span>}
        </h3>
        {editionOptions.length > 1 && <LanguageSwitch options={editionOptions} value={lang} onChange={onLangChange} label="Review language" className="ml-auto" />}
      </div>
      <div className={cx('mb-3 rounded-xl border px-3 py-2 text-[12.5px] leading-snug', readiness.publishable ? 'border-emerald-600/25 bg-emerald-500/[0.06]' : 'border-[#D97757]/35 bg-[#D97757]/10')} role="status">
        {readiness.publishable ? (
          <span>Translated and reviewed — ready to publish{readiness.issues.length ? `. ${readiness.issues.map((i) => i.text).join(' ')}` : '.'}</span>
        ) : (
          <span>{readiness.issues.filter((i) => i.blocking).map((i) => i.text).join(' ')}</span>
        )}
      </div>
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All (${rows.length})` },
            { value: 'attention', label: `Needs a look (${rows.filter((r) => needsLook(r.status, r.entry)).length})` }
          ]}
          label="Show lines"
        />
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <aside className="hidden min-w-0 lg:block" aria-label={`Page preview in ${spec?.english || lang}`}>
          <div className="sticky top-2">
            {previewPage && (
              <ComicPageView
                doc={localized}
                page={localized.pages.find((p) => p.id === previewPage.id) || previewPage}
                imageUrl={studio.urlFor(previewPage.render.asset, { width: 480 })}
                srcWidth={(w) => studio.urlFor(previewPage.render.asset, { width: w })}
                markUntranslated
                alt={`Page ${previewPage.n} in ${spec?.english || lang}`}
              />
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {pages.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={p.id === previewPage?.id}
                  aria-label={`Preview page ${p.n}`}
                  onClick={() => setPreviewId(p.id)}
                  className={cx('h-8 min-w-8 rounded-lg px-2 text-[12px] tabular-nums coarse:h-11 coarse:min-w-11', p.id === previewPage?.id ? 'bg-[var(--ds-raised)] font-semibold shadow-sm' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]')}
                >
                  {p.n}
                </button>
              ))}
            </div>
          </div>
        </aside>
        <div className="min-w-0 space-y-4">
          {titleFields.length > 0 && filter === 'all' && (
            <section aria-label="Titles">
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Titles</h4>
              <ul className="space-y-2">
                {titleFields.map((field) => {
                  const entry = editionTextEntry(doc, lang, field);
                  const source = editionTextSource(doc, field);
                  const status: DerivedStatus = !entry ? 'missing' : entry.sourceHash !== textSourceHash(source) ? (entry.status === 'edited' ? 'stale_edited' : 'stale') : entry.status;
                  return (
                    <ReviewRow
                      key={field}
                      studio={studio}
                      doc={doc}
                      lang={lang}
                      id={field}
                      kindLabel={FIELD_LABEL[field]}
                      source={source}
                      entry={entry}
                      status={status}
                      onSave={(text) => saveField(field, text)}
                      onNavigate={navigate}
                      registerField={registerField}
                    />
                  );
                })}
              </ul>
            </section>
          )}
          {pages.map((page) => {
            const pageRows = shown.filter((r) => r.page.id === page.id);
            if (!pageRows.length) return null;
            return (
              <section key={page.id} aria-label={`Page ${page.n}`}>
                <div className="mb-2 flex items-center gap-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Page {page.n}</h4>
                  <button
                    type="button"
                    onClick={() => setPreviewId(page.id)}
                    className="hidden items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] lg:inline-flex coarse:min-h-[44px]"
                  >
                    <Eye className="h-3 w-3" aria-hidden />
                    Preview
                  </button>
                </div>
                <ul className="space-y-2">
                  {pageRows.map(({ line, status, entry }) => (
                    <ReviewRow
                      key={line.id}
                      where={`page ${page.n}, panel ${page.panels.find((pn) => pn.lines.some((l) => l.id === line.id))?.n ?? '?'}`}
                      studio={studio}
                      doc={doc}
                      lang={lang}
                      id={line.id}
                      speaker={line.speakerId ? doc.cast.find((c) => c.id === line.speakerId)?.name : undefined}
                      kindLabel={KIND_LABEL[line.kind] || line.kind}
                      source={line.text}
                      entry={entry}
                      status={status}
                      fitFor={(text) => fitOf(doc, page, line, lang, text)}
                      onSave={(text) => saveLine(line.id, text)}
                      onNavigate={navigate}
                      registerField={registerField}
                      onFocusRow={() => setPreviewId(page.id)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          {!shown.length && <p className="rounded-xl border border-dashed border-[var(--ds-hairline)] p-4 text-center text-[13px] text-[var(--ds-muted)]">Nothing needs a look — every line is translated and reviewed.</p>}
          <p className="text-[11.5px] text-[var(--ds-muted)]">
            Edits are free and yours: a later translation never overwrites them. Enter saves and moves on · Esc undoes · J/K move between lines. The art is shared by every language — only the words change.
          </p>
        </div>
      </div>
    </div>
  );
};

export default TranslationReview;
