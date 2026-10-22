// Glossary drawer (i18n.md §10.1): how names and recurring terms are written per language.
// Owner: P1-I18N. Terms × languages, editable; changing a form renames it through every translated
// line of that language for $0 (glossaryRenameOps). Stacked cards, so it fits from 320 px.

import React, { useMemo, useState } from 'react';
import { BookA, Plus, Trash2 } from 'lucide-react';
import type { ComicDoc, GlossaryTerm } from '../../../shared/comic/doc';
import { i18nOf, translationStatus } from '../../../shared/comic/i18n';
import { dirOf, languageSpec } from '../../../shared/comic/languages';
import { glossaryRenameOps, syncGlossaryOps } from '../../../shared/comic/translationPlan';
import type { DocOp } from '../../../shared/comic/ops';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { GhostButton, PrimaryButton, cx } from '../board/ui';
import type { StudioController } from '../types';
import { cssFontFamily } from './scriptFonts';

const POLICIES: { id: GlossaryTerm['policy']; label: string; hint: string }[] = [
  { id: 'transliterate', label: 'Spell by sound', hint: 'A name, written in the other script (Milo → మైలో)' },
  { id: 'translate', label: 'Translate', hint: 'A word with a meaning (The Baby → పాపాయి)' },
  { id: 'keep', label: 'Keep as is', hint: 'Brand or spell, never changed' }
];

const newTermId = () => `gl_u_${Math.random().toString(36).slice(2, 10)}`;

export interface GlossaryDrawerProps {
  studio: StudioController;
  open: boolean;
  onClose(): void;
}

function FormInput({ doc, term, lang, onCommit }: { doc: ComicDoc; term: GlossaryTerm; lang: string; onCommit(lang: string, from: string, to: string): void }) {
  const current = term.forms[lang] || '';
  const [value, setValue] = useState(current);
  const spec = languageSpec(lang);
  React.useEffect(() => setValue(current), [current]);
  const commit = () => {
    const v = value.trim();
    if (v === current) return;
    if (!v) {
      setValue(current);
      return;
    }
    onCommit(lang, current, v);
  };
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="w-20 shrink-0 truncate text-[11.5px] text-[var(--ds-muted)]" title={spec?.english}>
        {spec?.english || lang}
      </span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') setValue(current);
        }}
        lang={lang}
        dir={dirOf(lang)}
        maxLength={80}
        placeholder={term.policy === 'keep' ? term.term : 'Set by the translator'}
        disabled={term.policy === 'keep'}
        aria-label={`${term.term} in ${spec?.english || lang}`}
        style={{ fontFamily: cssFontFamily(lang, 'legible') }}
        className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 text-[14px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/60 focus:outline-none focus:ring-2 focus:ring-[#D97757]/25 disabled:opacity-60 coarse:h-11"
      />
    </label>
  );
}

export const GlossaryDrawer: React.FC<GlossaryDrawerProps> = ({ studio, open, onClose }) => {
  const doc = studio.doc;
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const langs = useMemo(() => (doc ? Object.keys(i18nOf(doc).editions) : []), [doc]);
  const seed = useMemo(() => (doc ? syncGlossaryOps(doc) : []), [doc]);
  if (!doc) return null;
  const glossary = i18nOf(doc).glossary;

  const patch = (ops: DocOp[], label: string) => {
    if (ops.length) void studio.patch(ops, { label });
  };
  const rename = (term: GlossaryTerm, lang: string, from: string, to: string) => {
    // A client edit is stamped against the CURRENT source (sanitizer), so a stale line is left for the
    // translator instead of being marked up to date by a rename.
    const lineById = new Map(doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).map((l) => [l.id, l] as const));
    const ops = glossaryRenameOps(doc, lang, term.id, from, to).filter((o) => {
      if (o.op !== 'translation') return true;
      const line = lineById.get(o.lineId);
      return !!line && translationStatus(doc, lang, line) !== 'stale' && translationStatus(doc, lang, line) !== 'stale_edited';
    });
    patch(ops, 'Rename in translations');
    const lines = ops.filter((o) => o.op === 'translation' || o.op === 'edition_text').length;
    setNote(from && lines ? `Renamed ${from} → ${to} in ${lines} ${languageSpec(lang)?.english || lang} line${lines === 1 ? '' : 's'} (free).` : `Saved ${to} (free).`);
  };
  const add = () => {
    const term = draft.trim().slice(0, 80);
    if (!term) return;
    if (glossary.some((g) => g.term.toLowerCase() === term.toLowerCase())) {
      setNote(`“${term}” is already in the glossary.`);
      return;
    }
    patch([{ op: 'glossary_term', id: newTermId(), patch: { term, kind: 'term', policy: 'transliterate' } }], 'Add glossary term');
    setDraft('');
  };

  return (
    <AdaptiveSheet open={open} onClose={onClose} label="Glossary" title="Glossary" presentation="side" side="right" placement="below" align="end" className="w-[min(28rem,calc(100vw-32px))]">
      <div className="max-h-[min(70vh,40rem)] overflow-y-auto overscroll-contain p-3 text-[var(--ds-ink)]">
        <p className="mb-3 text-[12.5px] leading-snug text-[var(--ds-muted)]">
          How names and recurring words are written in each language. The translator follows these exactly; changing one renames it in every translated line for free.
        </p>
        {seed.length > 0 && (
          <GhostButton size="sm" className="mb-3 coarse:h-11" onClick={() => patch(seed, 'Add names to the glossary')}>
            <BookA className="h-3.5 w-3.5" aria-hidden />
            Add the cast and places ({seed.length})
          </GhostButton>
        )}
        <p role="status" aria-live="polite" className={note ? 'mb-2 rounded-lg bg-[#D97757]/10 px-2.5 py-1.5 text-[12px]' : 'sr-only'}>
          {note || ''}
        </p>
        {!glossary.length && <p className="mb-3 text-[13px] text-[var(--ds-muted)]">No terms yet. Translations add the names they use here automatically.</p>}
        <ul className="space-y-2.5">
          {glossary.map((term) => (
            <li key={term.id} className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 break-words text-[14px] font-semibold">{term.term}</span>
                <select
                  value={term.policy}
                  onChange={(e) => patch([{ op: 'glossary_term', id: term.id, patch: { policy: e.target.value as GlossaryTerm['policy'] } }], 'Glossary rule')}
                  aria-label={`How to write ${term.term}`}
                  title={POLICIES.find((p) => p.id === term.policy)?.hint}
                  className="h-9 max-w-[9.5rem] shrink-0 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 text-[12.5px] coarse:h-11"
                >
                  {POLICIES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remove ${term.term}`}
                  onClick={() => patch([{ op: 'glossary_term', id: term.id, patch: null }], 'Remove glossary term')}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:w-11"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {langs.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {langs.map((lang) => (
                    <FormInput key={lang} doc={doc} term={term} lang={lang} onCommit={(l, from, to) => rename(term, l, from, to)} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex min-w-0 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={80}
            placeholder="Add a name or word…"
            aria-label="New glossary term"
            className={cx('h-9 min-w-0 flex-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 text-[14px] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/60 focus:outline-none coarse:h-11')}
          />
          <PrimaryButton type="submit" size="sm" disabled={!draft.trim()} className="coarse:h-11">
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add
          </PrimaryButton>
        </form>
      </div>
    </AdaptiveSheet>
  );
};

export default GlossaryDrawer;
