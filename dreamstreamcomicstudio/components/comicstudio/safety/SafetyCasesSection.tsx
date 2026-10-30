// Admin console section "Comic safety" (safety.md §3.4; owner P1-SAFETY). The moderator queue for
// reader reports, owner appeals and automatic flags. Images load only on request through a
// 5-minute signed URL (audited server-side) and stay blurred until the moderator reveals them.
// Every action asks for a short reason; the owner only ever sees a neutral summary.

import React, { useCallback, useEffect, useState } from 'react';
import type { ContentRating } from '../../../shared/comic/safety';
import { getComicCaseAsset, listComicCases, resolveComicCase, type ComicCaseFilter } from '../studioApi';

/** GET /api/moderation/comic-cases item (routes/comicSafety.ts caseView). */
export interface ComicCase {
  id: string;
  kind: 'report' | 'appeal' | 'auto';
  status: 'open' | 'auto_cleared' | 'resolved' | 'dismissed';
  projectId: string;
  projectName?: string;
  reason: string;
  note?: string;
  reporter: 'user' | 'anonymous' | 'owner' | 'system';
  target: { kind?: string; page?: number; label?: string; hasAsset: boolean; check?: { assessed?: string; categories?: string[]; by?: string } };
  resolution?: string;
  createdAt: number;
  resolvedAt?: number;
}

type Action = 'dismiss' | 'withhold' | 'restore' | 'force_private';

const KIND_LABEL: Record<ComicCase['kind'], string> = { report: 'Reader report', appeal: 'Owner appeal', auto: 'Automatic flag' };
const REASON_LABEL: Record<string, string> = {
  sexual: 'Sexual content or nudity',
  violent: 'Graphic violence or gore',
  hateful: 'Hate or harassment',
  self_harm: 'Self-harm',
  real_person: 'Real person shown badly',
  copyright: 'Copied work',
  kids_unsafe: 'Unsafe for kids',
  spam: 'Spam',
  other: 'Something else'
};

const BTN =
  'inline-flex min-h-[44px] items-center justify-center rounded-full px-3 text-[13px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 disabled:cursor-not-allowed disabled:opacity-50';
const QUIET = `${BTN} border border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`;
const PRIMARY = `${BTN} bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]`;

const when = (t: number) => {
  try {
    return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
};

const CaseCard: React.FC<{ item: ComicCase; onResolved(): void }> = ({ item, onResolved }) => {
  const [image, setImage] = useState<{ url: string; expiresAt?: number } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const [reason, setReason] = useState('');
  const [assessed, setAssessed] = useState<ContentRating>('PG');
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = item.status === 'open';

  const loadImage = async () => {
    setLoadingImage(true);
    setError(null);
    try {
      const out = await getComicCaseAsset(item.id);
      if (out) setImage(out);
      else setError('No image for this case (it may have been removed).');
    } catch {
      setError("Couldn't load the image — try again.");
    } finally {
      setLoadingImage(false);
    }
  };

  const resolve = async (action: Action) => {
    if (action !== 'dismiss' && !reason.trim()) {
      setError('Add a short reason first.');
      return;
    }
    setBusy(action);
    setError(null);
    try {
      await resolveComicCase(item.id, { action, reason: reason.trim(), ...(action === 'restore' ? { assessed } : {}) });
      onResolved();
    } catch (err) {
      setError((err as Error)?.message || "Couldn't save that decision — try again.");
    } finally {
      setBusy(null);
    }
  };

  const check = item.target.check;
  return (
    <li className="min-w-0 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-3 shadow-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--ds-muted)]">
        <span className="rounded-full bg-[#D97757]/10 px-2 py-0.5 font-medium text-[var(--ds-ink)]">{KIND_LABEL[item.kind]}</span>
        <span className="min-w-0 truncate">{item.projectName || item.projectId}</span>
        <span aria-hidden>·</span>
        <span>{when(item.createdAt)}</span>
        {item.status !== 'open' && <span className="rounded-full border border-[var(--ds-hairline)] px-2 py-0.5">{item.status.replace('_', ' ')}</span>}
      </div>
      <p className="mt-1.5 break-words text-[14px] font-medium text-[var(--ds-ink)]">
        {REASON_LABEL[item.reason] || item.reason}
        {item.target.label ? <span className="font-normal text-[var(--ds-muted)]"> — {item.target.label}{item.target.page && item.target.label !== `Page ${item.target.page}` ? ` ${item.target.page}` : ''}</span> : null}
      </p>
      {item.note && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-[var(--ds-ink)]">“{item.note}”</p>}
      <p className="mt-1 text-[12px] text-[var(--ds-muted)]">
        From: {item.reporter === 'user' ? 'a signed-in reader' : item.reporter === 'anonymous' ? 'an anonymous reader' : item.reporter === 'owner' ? 'the creator' : 'the safety system'}
        {check?.assessed ? ` · check: ${check.assessed}${check.categories?.length ? ` (${check.categories.join(', ')})` : ''}` : ''}
      </p>
      {item.resolution && <p className="mt-1 break-words text-[12px] text-[var(--ds-muted)]">Resolution: {item.resolution}</p>}

      {item.target.hasAsset && (
        <div className="mt-2">
          {!image ? (
            <button type="button" className={QUIET} onClick={() => void loadImage()} disabled={loadingImage}>
              {loadingImage ? 'Loading…' : 'View image (5-minute link)'}
            </button>
          ) : (
            <div className="relative max-w-[320px] overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]">
              <img
                src={image.url}
                alt="Flagged image"
                referrerPolicy="no-referrer"
                className={`block h-auto w-full ${revealed ? '' : '[filter:blur(18px)]'}`}
                onError={() => {
                  // The 5-minute link expired (or the object moved): offer a fresh one.
                  setImage(null);
                  setRevealed(false);
                  setError('That image link expired — load it again.');
                }}
              />
              {!revealed && (
                <div className="absolute inset-0 grid place-items-center">
                  <button type="button" className={QUIET} onClick={() => setRevealed(true)}>
                    Reveal
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {open && (
        <div className="mt-3 min-w-0">
          <label className="block text-[12px] font-medium text-[var(--ds-muted)]" htmlFor={`reason-${item.id}`}>
            Reason (the creator sees a neutral summary)
          </label>
          <input
            id={`reason-${item.id}`}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 block min-h-[44px] w-full min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 text-[14px] text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button type="button" className={QUIET} disabled={!!busy} onClick={() => void resolve('dismiss')}>
              {busy === 'dismiss' ? 'Saving…' : 'Dismiss'}
            </button>
            <button type="button" className={PRIMARY} disabled={!!busy} onClick={() => void resolve('withhold')}>
              {busy === 'withhold' ? 'Saving…' : 'Withhold'}
            </button>
            <span className="inline-flex items-center gap-1">
              <select
                aria-label="Rating to restore at"
                value={assessed}
                onChange={(e) => setAssessed(e.target.value as ContentRating)}
                className="min-h-[44px] rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2 text-[13px] text-[var(--ds-ink)]"
              >
                <option value="G">G</option>
                <option value="PG">PG</option>
                <option value="PG-13">PG-13</option>
              </select>
              <button type="button" className={QUIET} disabled={!!busy} onClick={() => void resolve('restore')}>
                {busy === 'restore' ? 'Saving…' : 'Restore'}
              </button>
            </span>
            <button type="button" className={QUIET} disabled={!!busy} onClick={() => void resolve('force_private')}>
              {busy === 'force_private' ? 'Saving…' : 'Make private'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 break-words text-[13px] text-[var(--ds-ink)]">
          {error}
        </p>
      )}
    </li>
  );
};

export interface SafetyCasesSectionProps {
  /** Override the queue fetch (tests). */
  load?(filter: ComicCaseFilter): Promise<ComicCase[]>;
}

export const SafetyCasesSection: React.FC<SafetyCasesSectionProps> = ({ load }) => {
  const [filter, setFilter] = useState<ComicCaseFilter>({ status: 'open' });
  const [cases, setCases] = useState<ComicCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await (load ? load(filter) : listComicCases<ComicCase>(filter));
      setCases(list);
    } catch {
      // Never claim "the queue is clear" when it could not be read.
      setCases(null);
      setError("Couldn't load the safety queue — try again.");
    }
  }, [filter, load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section aria-labelledby="comic-safety-heading" className="min-w-0 text-[var(--ds-ink)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="comic-safety-heading" className="text-[16px] font-semibold">
            Comic safety
          </h2>
          <p className="text-[13px] text-[var(--ds-muted)]">Reader reports, creator appeals and automatic flags. Every image view and decision is audited.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Status"
            value={filter.status || 'open'}
            onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value as 'open' | 'resolved' }))}
            className="min-h-[44px] rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-3 text-[13px]"
          >
            <option value="open">Open</option>
            <option value="resolved">Closed</option>
          </select>
          <select
            aria-label="Kind"
            value={filter.kind || ''}
            onChange={(e) => setFilter((f) => ({ ...f, kind: (e.target.value || undefined) as ComicCaseFilter['kind'] }))}
            className="min-h-[44px] rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-3 text-[13px]"
          >
            <option value="">All kinds</option>
            <option value="report">Reports</option>
            <option value="appeal">Appeals</option>
            <option value="auto">Automatic</option>
          </select>
          <button type="button" className={QUIET} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[13px]">
          {error}
        </p>
      )}
      {cases === null ? (
        error ? null : (
          <p role="status" className="mt-4 text-[13px] text-[var(--ds-muted)]">
            Loading…
          </p>
        )
      ) : cases.length === 0 ? (
        <p className="mt-4 text-[13px] text-[var(--ds-muted)]">{filter.status === 'resolved' ? 'No closed cases yet.' : 'Nothing waiting — the queue is clear.'}</p>
      ) : (
        <ul className="mt-3 grid min-w-0 gap-2">
          {cases.map((c) => (
            <CaseCard key={c.id} item={c} onResolved={() => void refresh()} />
          ))}
        </ul>
      )}
    </section>
  );
};

export default SafetyCasesSection;
