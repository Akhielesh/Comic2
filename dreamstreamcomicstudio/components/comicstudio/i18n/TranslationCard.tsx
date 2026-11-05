// Conversation card "translation" (i18n.md §10.4): live edition progress + Review / Publish.
// Owner: P1-I18N. Renders LIVE doc state (never a snapshot), so the card in an older message
// shows the edition as it is now.

import React from 'react';
import { CheckCircle2, Globe, LoaderCircle } from 'lucide-react';
import type { Card } from '../../../shared/comic/doc';
import { editionProgress, editionReadiness, i18nOf } from '../../../shared/comic/i18n';
import { dirOf, languageSpec } from '../../../shared/comic/languages';
import type { CardProps } from '../extensions';
import { TONE_TEXT } from '../../chat/studioDesign';
import { CardShell, GhostButton, PrimaryButton, plural } from '../conversation/ui';

type TranslationCardData = Extract<Card, { type: 'translation' }>;

/** One language's live state for the card and the Languages tab. */
export function editionSummary(doc: Parameters<typeof editionProgress>[0], lang: string) {
  const p = editionProgress(doc, lang);
  const r = editionReadiness(doc, lang);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
  const blocking = r.issues.filter((i) => i.blocking);
  return { p, r, pct, blocking, exists: !!i18nOf(doc).editions[lang] };
}

export const TranslationCard: React.FC<CardProps<TranslationCardData>> = ({ card, studio }) => {
  const doc = studio.doc;
  if (!doc) return null;
  const langs = (card.languages || []).filter((l) => languageSpec(l));
  if (!langs.length) return null;
  const rows = langs.map((lang) => ({ lang, spec: languageSpec(lang)!, ...editionSummary(doc, lang) }));
  const working = studio.busy && rows.some((r) => r.p.done < r.p.total);
  const allReady = rows.every((r) => r.r.publishable);
  return (
    <CardShell
      title={rows.length === 1 ? `${rows[0].spec.english} translation` : 'Translations'}
      icon={<Globe className="h-4 w-4" aria-hidden />}
      right={working ? <span className="inline-flex items-center gap-1"><LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />Translating…</span> : undefined}
      aria-label="Translation progress"
    >
      <ul className="space-y-2.5">
        {rows.map(({ lang, spec, p, r, pct, blocking, exists }) => (
          <li key={lang} className="min-w-0">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[13.5px] font-semibold text-[var(--ds-ink)]">
                <span lang={lang} dir={dirOf(lang)}>{spec.endonym}</span>
                {spec.endonym !== spec.english && <span className="ml-1.5 text-[12px] font-normal text-[var(--ds-muted)]">{spec.english}</span>}
              </span>
              <span className="shrink-0 text-[12px] tabular-nums text-[var(--ds-muted)]">{exists ? `${p.done}/${p.total}` : 'not started'}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--ds-well-strong)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${spec.english}: ${pct}% translated`}>
              <div className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-[12px] leading-snug text-[var(--ds-muted)]">
              {r.publishable ? (
                <span className={`inline-flex items-center gap-1 ${TONE_TEXT.success}`}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Translated and reviewed — ready to publish</span>
              ) : blocking.length ? (
                blocking[0].text
              ) : (
                'Working on it…'
              )}
              {p.flagged > 0 && !r.publishable ? ` · ${plural(p.flagged, 'line')} flagged` : ''}
            </p>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <GhostButton size="sm" onClick={() => studio.setTab('languages')}>Review</GhostButton>
        {allReady && <PrimaryButton size="sm" onClick={() => studio.runClientAction({ type: 'open_share' })}>Publish…</PrimaryButton>}
      </div>
    </CardShell>
  );
};

export default TranslationCard;
