// "cast" card: the characters the director just captured, with their model-sheet status.
// Tapping a character opens the board's Cast tab; leads/supports without a sheet can be
// drawn from here (sheets are the identity anchors for every page).

import React from 'react';
import { AlertTriangle, Check, Users } from 'lucide-react';
import type { Card, Character } from '../../../../shared/comic/doc';
import { estimateJobs, formatUsd } from '../../../../shared/comic/models';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton, cx, plural } from '../ui';
import { useAction } from './useAction';

type CastCardData = Extract<Card, { type: 'cast' }>;

const TINTS = ['#E9D5C9', '#D6E4E5', '#E3DCEF', '#DDE7D3', '#F0E1C6', '#D9DFF0'];
const tintFor = (id: string) => TINTS[[...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % TINTS.length];
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

const TIER_LABEL: Record<Character['tier'], string> = { lead: 'Lead', support: 'Support', extra: 'Extra' };

const sheetStatus = (c: Character): { text: string; tone: 'ok' | 'busy' | 'bad' | 'none' } => {
  if (c.tier === 'extra') return { text: 'Described in text', tone: 'none' };
  switch (c.sheet.status) {
    case 'ready':
      return { text: 'Sheet ready', tone: 'ok' };
    case 'queued':
      return { text: 'Queued', tone: 'busy' };
    case 'rendering':
      return { text: 'Drawing sheet…', tone: 'busy' };
    case 'failed':
      return { text: 'Sheet failed', tone: 'bad' };
    default:
      return { text: 'No sheet yet', tone: 'none' };
  }
};

const needsSheet = (c: Character) => c.tier !== 'extra' && c.sheet.status !== 'ready' && c.sheet.status !== 'queued' && c.sheet.status !== 'rendering';

export const CastCard: React.FC<{ card: CastCardData; studio: ComicStudioController }> = ({ card, studio }) => {
  const doc = studio.doc;
  const { run, isPending } = useAction(studio.act);
  if (!doc) return null;
  const ids = Array.isArray(card.characterIds) && card.characterIds.length ? card.characterIds : doc.cast.map((c) => c.id);
  const cast = ids.map((id) => doc.cast.find((c) => c.id === id)).filter((c): c is Character => !!c);
  const missing = cast.filter(needsSheet);
  const ready = cast.filter((c) => c.tier !== 'extra' && c.sheet.status === 'ready').length;
  const sheeted = cast.filter((c) => c.tier !== 'extra').length;
  const estimate = estimateJobs([{ kind: 'sheet', count: missing.length, label: 'character sheets' }], doc.settings.quality, {
    override: doc.settings.imageModelOverride,
    byok: studio.byok
  });

  return (
    <CardShell
      title="Cast"
      icon={<Users className="h-4 w-4" />}
      right={sheeted ? `${ready} of ${sheeted} sheets ready` : undefined}
      aria-label="Cast"
    >
      {cast.length === 0 ? (
        <p className="text-[13px] text-[var(--ds-muted)]">These characters were removed from the comic.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {cast.map((c) => {
            const status = sheetStatus(c);
            const url = c.sheet.status === 'ready' ? studio.urlFor(c.sheet.asset) : c.refs[0] ? studio.urlFor(c.refs[0]) : undefined;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => studio.setTab('cast')}
                  title={c.look.summary || c.name}
                  className="flex max-w-[15rem] items-center gap-2.5 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] py-1.5 pl-1.5 pr-3 text-left transition-all duration-200 hover:border-[#D97757]/35 hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
                >
                  <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-xl" style={{ background: tintFor(c.id) }}>
                    {url ? (
                      <img src={url} alt="" className="h-full w-full object-cover object-left" />
                    ) : (
                      <span className="grid h-full w-full place-items-center text-[13px] font-semibold text-[#3d3a33]">{initials(c.name)}</span>
                    )}
                    {status.tone === 'busy' && <span className="studio-shimmer absolute inset-0" aria-hidden />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-[var(--ds-ink)]">{c.name}</span>
                    <span
                      className={cx(
                        'flex items-center gap-1 truncate text-[11px]',
                        status.tone === 'bad' ? 'text-red-600 dark:text-red-300' : 'text-[var(--ds-muted)]'
                      )}
                    >
                      {status.tone === 'ok' && <Check className="h-3 w-3 text-emerald-600" aria-hidden />}
                      {status.tone === 'bad' && <AlertTriangle className="h-3 w-3" aria-hidden />}
                      {status.tone === 'busy' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ds-accent)]" aria-hidden />}
                      {TIER_LABEL[c.tier]}
                      {c.role ? ` · ${c.role}` : ''} · {status.text}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {missing.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <GhostButton
            size="sm"
            busy={isPending('sheets')}
            onClick={() => void run('sheets', { type: 'render_sheets', characterIds: missing.map((c) => c.id), force: missing.some((c) => c.sheet.status === 'failed') })}
          >
            Draw {plural(missing.length, 'sheet')} <span className="text-[var(--ds-muted)]">≈ {formatUsd(estimate.usd)}</span>
          </GhostButton>
          <span className="text-[11.5px] text-[var(--ds-muted)]">Sheets keep faces and outfits consistent on every page.</span>
        </div>
      )}
    </CardShell>
  );
};
