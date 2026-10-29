// Publish panel (sharing.md §7.3 #2): readiness (drawn/planned pages, stale pages, safety by
// page, languages) plus the toggles (languages, downloads, embedding, show my name) and the
// primary "Publish" / "Update published version". Honest: blockers are listed in plain words,
// safety-blocked pages need an explicit "Publish without page N" tap, and nothing about the
// comic changes until the server confirms.

import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Globe2, Link2 } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { languageSpec } from '../../../shared/comic/languages';
import type { PublicationOwnerView, PublishReadiness, PublishRequest } from '../../../shared/comic/publication';
import { cx, plural } from '../conversation/ui';
import { pageIdsFor } from './shareModel';

export interface PublishPanelProps {
  doc: ComicDoc;
  view: PublicationOwnerView | null;
  visibility: 'unlisted' | 'public';
  busy?: boolean;
  error?: string | null;
  onPublish(request: PublishRequest): void;
  onCancel?(): void;
}

const Row: React.FC<{ ok: boolean | 'warn'; children: React.ReactNode }> = ({ ok, children }) => (
  <li className="flex min-w-0 items-start gap-2 text-[13px] leading-snug text-[var(--ds-ink)]">
    {ok === true ? (
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Ready" />
    ) : ok === 'warn' ? (
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Needs attention" />
    ) : (
      <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-label="Not ready" />
    )}
    <span className="min-w-0">{children}</span>
  </li>
);

/** A labelled switch row (also the Share sheet's live "Link settings"). */
export const Toggle: React.FC<{ label: string; hint?: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void }> = ({ label, hint, checked, disabled, onChange }) => (
  <label className={cx('flex min-h-[44px] items-center justify-between gap-3 rounded-xl px-1 text-[13px] text-[var(--ds-ink)]', disabled ? 'opacity-60' : 'cursor-pointer')}>
    <span className="min-w-0">
      <span className="block font-medium">{label}</span>
      {hint && <span className="block text-[12px] text-[var(--ds-muted)]">{hint}</span>}
    </span>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 shrink-0 accent-[#D97757]" />
  </label>
);

/**
 * The server's readiness words for a cover that has NO publishable art yet (publication.ts STATUS_WORD).
 * Any other word on a cover entry describes art that exists but that publishing would refuse — today
 * "uses an image from outside the studio — redraw it or upload the image again" (OUTSIDE_IMAGE_STATUS) —
 * and the row repeats it instead of claiming there is no cover.
 */
const NO_COVER_ART_WORDS: ReadonlySet<string> = new Set(['not drawn yet', 'waiting to draw', 'drawing now', "didn't draw"]);

export function readinessRows(r: PublishReadiness | undefined, doc: ComicDoc): Array<{ ok: boolean | 'warn'; text: string }> {
  const rows: Array<{ ok: boolean | 'warn'; text: string }> = [];
  const planned = r?.plannedPages ?? doc.pages.length;
  const drawn = r?.drawnPages ?? doc.pages.filter((p) => p.render?.asset && (p.render.status === 'ready' || p.render.status === 'stale')).length;
  rows.push({ ok: drawn > 0 && drawn === planned ? true : drawn > 0 ? 'warn' : false, text: `${drawn} of ${plural(planned, 'page')} drawn${drawn < planned && drawn > 0 ? ' — undrawn pages are left out' : ''}` });
  const missingPages = (r?.missing || []).filter((m) => m.kind === 'page');
  for (const m of missingPages.slice(0, 4)) rows.push({ ok: 'warn', text: `Page ${m.n}: ${m.status}` });
  const coverMissing = r?.missing.find((m) => m.kind === 'cover');
  const coverWord = typeof coverMissing?.status === 'string' ? coverMissing.status.trim() : '';
  if (r && !coverMissing) rows.push({ ok: true, text: 'Cover ready' });
  else if (coverWord && !NO_COVER_ART_WORDS.has(coverWord)) rows.push({ ok: 'warn', text: `Cover ${coverWord}` });
  else rows.push({ ok: 'warn', text: 'No cover yet — the preview uses page 1' });
  if (r?.stalePages.length) rows.push({ ok: 'warn', text: `${r.stalePages.length === 1 ? 'Page' : 'Pages'} ${r.stalePages.join(', ')} changed since drawing (the drawn version is published)` });
  if (r?.safety.status === 'blocked') rows.push({ ok: false, text: `Page ${r.safety.blockedPages.join(', ')} ${r.safety.blockedPages.length === 1 ? "doesn't" : "don't"} fit the content rules` });
  else if (r?.safety.status === 'needs_check') rows.push({ ok: 'warn', text: 'A quick safety check runs when you publish (free)' });
  else if (r) rows.push({ ok: true, text: 'Safety check passed' });
  return rows;
}

export const PublishPanel: React.FC<PublishPanelProps> = ({ doc, view, visibility, busy, error, onPublish, onCancel }) => {
  const source = doc.format?.language || 'en';
  const editions = useMemo(() => Object.keys(doc.i18n?.editions || {}), [doc.i18n]);
  const readiness = view?.readiness;
  const publishable = new Set((readiness?.languages || []).filter((l) => l.publishable).map((l) => l.lang));
  // The original is always published (readers always get it; the server adds it even when left out).
  const [languages, setLanguages] = useState<string[]>(() => {
    const chosen = view?.languages?.length ? view.languages : [];
    return [source, ...chosen.filter((l) => l !== source)];
  });
  const [allowDownload, setAllowDownload] = useState(view?.allowDownload ?? true);
  const [allowEmbed, setAllowEmbed] = useState(view?.allowEmbed ?? true);
  const [showCreator, setShowCreator] = useState(view?.showCreator ?? false);
  const blocked = readiness?.safety.status === 'blocked' ? readiness.safety.blockedPages : [];
  const live = !!view?.slug && view.status === 'live';
  const drawn = readiness?.drawnPages ?? 0;

  const request = (exclude?: number[]): PublishRequest => ({
    visibility,
    languages: [source, ...languages.filter((l) => l !== source)],
    allowDownload,
    allowEmbed,
    showCreator,
    ...(exclude?.length ? { excludePageIds: pageIdsFor(doc, exclude) } : {})
  });

  return (
    <div className="min-w-0 space-y-4">
      <p className="flex items-start gap-2 text-[13px] text-[var(--ds-muted)]">
        {visibility === 'public' ? <Globe2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <Link2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
        <span>
          {visibility === 'public'
            ? 'Anyone with the link can read it, and it’s listed in the public gallery.'
            : 'Anyone with the link can read it. It isn’t listed or searchable.'}{' '}
          Readers can never edit. Later changes stay private until you update.
        </span>
      </p>
      <ul className="m-0 list-none space-y-1.5 p-0" aria-label="Readiness">
        {readinessRows(readiness, doc).map((r, i) => (
          <Row key={i} ok={r.ok}>
            {r.text}
          </Row>
        ))}
      </ul>
      {(editions.length > 0 || languages.length > 1) && (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Languages</legend>
          <div className="flex flex-wrap gap-2">
            {[source, ...editions.filter((e) => e !== source)].map((lang) => {
              const isSource = lang === source;
              const ready = isSource || publishable.has(lang);
              const on = isSource || languages.includes(lang);
              return (
                <label
                  key={lang}
                  className={cx(
                    'inline-flex min-h-[44px] items-center gap-2 rounded-full border px-3 text-[13px]',
                    on ? 'border-[#D97757]/45 bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]',
                    !ready && 'opacity-60'
                  )}
                  title={isSource ? 'The original is always published' : ready ? undefined : 'Finish and review this translation first'}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={isSource || !ready}
                    onChange={(e) => !isSource && setLanguages((cur) => (e.target.checked ? [...cur, lang] : cur.filter((l) => l !== lang)))}
                    className="h-4 w-4 accent-[#D97757]"
                  />
                  {languageSpec(lang)?.endonym || lang}
                  {isSource && <span className="text-[11px] text-[var(--ds-muted)]">original</span>}
                  {!ready && <span className="text-[11px] text-[var(--ds-muted)]">not ready</span>}
                </label>
              );
            })}
          </div>
          <p className="m-0 mt-1.5 text-[12px] text-[var(--ds-muted)]">Readers always get the original and can switch to any language you publish.</p>
        </fieldset>
      )}
      <div className="divide-y divide-[var(--ds-hairline-soft)]">
        <Toggle label="Readers can download" hint="PDF and page images of the published version" checked={allowDownload} onChange={setAllowDownload} />
        <Toggle label="Allow embedding" hint="Lets websites show it in a frame" checked={allowEmbed} onChange={setAllowEmbed} />
        <Toggle label="Show my username" hint="Off keeps you anonymous to readers" checked={showCreator} onChange={setShowCreator} />
      </div>
      {error && (
        <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-[13px] text-[var(--ds-ink)]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="min-h-[44px] rounded-xl px-4 text-[14px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]">
            Not now
          </button>
        )}
        {blocked.length > 0 && (
          <button
            type="button"
            disabled={busy || drawn <= blocked.length}
            onClick={() => onPublish(request(blocked))}
            className="min-h-[44px] rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-4 text-[14px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:opacity-45"
          >
            Publish without page {blocked.join(', ')}
          </button>
        )}
        <button
          type="button"
          disabled={busy || drawn === 0 || blocked.length > 0}
          aria-busy={busy || undefined}
          onClick={() => onPublish(request())}
          className="min-h-[44px] rounded-xl bg-[var(--ds-accent)] px-5 text-[14px] font-semibold text-white hover:bg-[var(--ds-accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? 'Publishing…' : live ? 'Update published version' : 'Publish'}
        </button>
      </div>
      {drawn === 0 && <p className="text-right text-[12px] text-[var(--ds-muted)]">Draw at least one page to publish.</p>}
    </div>
  );
};

export default PublishPanel;
