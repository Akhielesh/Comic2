// "cast" card: the characters the director just captured, with their model-sheet status.
// Tapping a character opens the board's Cast tab; leads/supports without a sheet can be
// drawn from here (sheets are the identity anchors for every page).
//
// Non-human cast is first-class (director.md §3.5): animals, creatures, robots, toys,
// vehicles and props carry a kind icon, a group shows "×3", and a recurring non-human
// support reads as a "Companion". The status line is a real truncating text span (visualqa
// P1-4: `truncate` on a flex container never shows an ellipsis).

import React from 'react';
import { AlertTriangle, Check, Users } from 'lucide-react';
import type { Card, Character } from '../../../../shared/comic/doc';
import { estimateDocJobs } from '../../../../shared/comic/plan';
import type { ComicStudioController } from '../../useStudio';
import { useCostFormat } from '../cost';
import { CardShell, GhostButton, cx, plural } from '../ui';
import { CastAvatar, KIND_NAME, castAriaLabel, castRoleLabel, groupCount, kindOf } from './castVisual';
import { useAction } from './useAction';

type CastCardData = Extract<Card, { type: 'cast' }>;

export const sheetStatus = (c: Character): { text: string; tone: 'ok' | 'busy' | 'bad' | 'none' } => {
  // An extra is described in words until it has a ready sheet; a ready sheet is attached on every page it is on.
  if (c.tier === 'extra') return c.sheet.status === 'ready' ? { text: 'Sheet ready · used on pages', tone: 'ok' } : { text: 'Described in text', tone: 'none' };
  switch (c.sheet.status) {
    case 'ready':
      return { text: 'Sheet ready', tone: 'ok' };
    case 'queued':
      return { text: 'Queued', tone: 'busy' };
    case 'rendering':
      return { text: 'Drawing sheet…', tone: 'busy' };
    case 'failed':
      return { text: 'Sheet didn’t finish', tone: 'bad' };
    case 'stale':
      return { text: 'Sheet out of date', tone: 'none' };
    default:
      return { text: 'No sheet yet', tone: 'none' };
  }
};

const needsSheet = (c: Character) => c.tier !== 'extra' && c.sheet.status !== 'ready' && c.sheet.status !== 'queued' && c.sheet.status !== 'rendering';

/** "Lead · cat burglar · Sheet ready" / "Companion · ×3 · No sheet yet". */
export const castStatusLine = (c: Character): string => {
  const n = groupCount(c);
  const kind = kindOf(c);
  const label = castRoleLabel(c);
  const parts = [label];
  if (c.role) parts.push(c.role);
  else if (kind !== 'person' && !n && label !== 'Prop') parts.push(KIND_NAME[kind].toLowerCase());
  if (n) parts.push(`group of ${n}`);
  parts.push(sheetStatus(c).text);
  return parts.join(' · ');
};

export const CastCard: React.FC<{ card: CastCardData; studio: ComicStudioController }> = ({ card, studio }) => {
  const doc = studio.doc;
  const { run, isPending } = useAction(studio.act);
  const cost = useCostFormat(studio);
  if (!doc) return null;
  const ids = Array.isArray(card.characterIds) && card.characterIds.length ? card.characterIds : doc.cast.map((c) => c.id);
  const cast = ids.map((id) => doc.cast.find((c) => c.id === id)).filter((c): c is Character => !!c);
  const missing = cast.filter(needsSheet);
  const ready = cast.filter((c) => c.tier !== 'extra' && c.sheet.status === 'ready').length;
  const sheeted = cast.filter((c) => c.tier !== 'extra').length;
  // Only worth saying while a companion still needs its sheet.
  const companions = cast.filter((c) => castRoleLabel(c) === 'Companion' && needsSheet(c)).length;
  // On the comic's locked model when it has one (the server draws and gates the sheets there).
  const estimate = estimateDocJobs(doc, [{ kind: 'sheet', count: missing.length, label: 'character sheets' }], { byok: studio.byok });

  return (
    <CardShell
      title="Cast"
      icon={<Users className="h-4 w-4" />}
      right={sheeted ? `${ready} of ${sheeted} sheets ready` : undefined}
      aria-label="Cast"
      className="min-w-0 max-w-full"
    >
      {cast.length === 0 ? (
        <p className="text-[13px] text-[var(--ds-muted)]">These characters were removed from the comic.</p>
      ) : (
        <ul className="flex min-w-0 flex-wrap gap-2">
          {cast.map((c) => {
            const status = sheetStatus(c);
            const n = groupCount(c);
            return (
              <li key={c.id} className="min-w-0 max-w-full">
                <button
                  type="button"
                  onClick={() => studio.setTab('cast')}
                  title={c.look.summary || c.name}
                  aria-label={`${castAriaLabel(c)}. ${status.text}. Open the cast`}
                  className="flex w-full max-w-[16rem] items-center gap-2.5 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] py-1.5 pl-1.5 pr-3 text-left transition-colors duration-200 hover:border-[#D97757]/35 hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
                >
                  <CastAvatar character={c} urlFor={studio.urlFor} size={40} busy={status.tone === 'busy'} showCount={false} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1">
                      <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--ds-ink)]">{c.name}</span>
                      {n && <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-[var(--ds-accent)]">×{n}</span>}
                    </span>
                    <span
                      className={cx(
                        'flex min-w-0 items-center gap-1 text-[11px]',
                        status.tone === 'bad' ? 'text-amber-700 dark:text-amber-300' : 'text-[var(--ds-muted)]'
                      )}
                    >
                      {status.tone === 'ok' && <Check className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden />}
                      {status.tone === 'bad' && <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />}
                      {status.tone === 'busy' && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ds-accent)] motion-reduce:animate-none" aria-hidden />}
                      <span className="min-w-0 truncate">{castStatusLine(c)}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {companions > 0 && (
        <p className="mt-2 text-[11.5px] leading-snug text-[var(--ds-muted)]">
          {companions === 1 ? 'The companion gets' : 'Companions get'} a reference sheet too, so {companions === 1 ? 'it looks' : 'they look'} the same on every page.
        </p>
      )}
      {missing.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <GhostButton
            size="sm"
            className="tap-target !h-auto min-h-8 max-w-full flex-wrap py-1 text-center coarse:min-h-11"
            busy={isPending('sheets')}
            onClick={() =>
              void run('sheets', {
                type: 'render_sheets',
                characterIds: missing.map((c) => c.id),
                force: missing.some((c) => c.sheet.status === 'failed'),
                quotedUsd: estimate.usd
              })
            }
          >
            Draw {plural(missing.length, 'sheet')} <span className="text-[var(--ds-muted)]">{cost.approx(estimate.usd)}</span>
          </GhostButton>
          <span className="min-w-0 text-[11.5px] text-[var(--ds-muted)]">Sheets keep faces, outfits and markings consistent on every page.</span>
        </div>
      )}
    </CardShell>
  );
};
