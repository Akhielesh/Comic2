// "recap" card — "Here's what I've got" (director.md §3.2). The director says one line; this
// card shows, LIVE, everything the studio understood: the story, format, audience, setting,
// look and the cast (kind icons, ×counts, companions). Each row has a "Change" that goes
// straight to the right place: format and look open their panels right here in the card (no
// AI call, instant), story and cast open their board tabs. The acting chips under the message
// ("Looks right → plan it" / "Change something") come from the message's nextSteps.

import React, { useState } from 'react';
import { PenLine, Sparkles } from 'lucide-react';
import { type Card, type Character } from '../../../../shared/comic/doc';
import type { ComicStudioController } from '../../useStudio';
import { composeInStudio } from '../composerBus';
import { CardShell, GhostButton, cx } from '../ui';
import { FormatPanel } from '../panels/FormatPanel';
import { StylePanel } from '../panels/StylePanel';
import { CastAvatar, castAriaLabel, castRoleLabel, groupCount } from './castVisual';
import { hasRecap, recapRows, type RecapKey } from './recap';

type RecapCardData = Extract<Card, { type: 'recap' }>;

const CHANGE_LABEL: Record<RecapKey | 'cast', string> = {
  story: 'Change the story',
  format: 'Change the format',
  audience: 'Change who it is for',
  setting: 'Change the setting',
  style: 'Change the look',
  cast: 'Change the cast'
};

const MAX_CAST_CHIPS = 8;

// Container-driven rows (no viewport breakpoints — the card lives in panes of every width):
//   ROW       wraps Change under the row when the row is narrower than the main block's basis + Change;
//   ROW_MAIN  the label and its value, wrapping the value under the label below ~16.75rem;
//   ROW_VALUE never narrower than its content allows (min-w-0) and never under 12rem beside a label.
const ROW = 'flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1';
const ROW_MAIN = 'flex min-w-0 flex-[1_1_12rem] flex-wrap items-start gap-x-3 gap-y-0.5';
const ROW_LABEL = 'block w-[4.25rem] shrink-0 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]';
const ROW_VALUE = 'block min-w-0 max-w-full flex-[1_1_12rem]';

export const RecapCard: React.FC<{ card: RecapCardData; studio: ComicStudioController }> = ({ studio }) => {
  const doc = studio.doc;
  const [panel, setPanel] = useState<'format' | 'style' | null>(null);
  if (!doc) return null;

  if (!hasRecap(doc)) {
    return (
      <CardShell title="Here’s what I’ve got" icon={<Sparkles className="h-4 w-4" />} aria-label="What I understood" className="min-w-0 max-w-full">
        <p className="text-[13px] leading-snug text-[var(--ds-muted)]">
          Nothing yet — tell me what your comic is about. A sentence is enough; I’ll fill in the rest and show it here.
        </p>
        <div className="mt-3">
          <GhostButton
            size="sm"
            className="tap-target"
            onClick={() => composeInStudio({ hint: 'What happens, who it’s for, and the vibe — e.g. “a toddler and three ducklings by a lake, for ages 2–6”' })}
          >
            <PenLine className="h-3.5 w-3.5" aria-hidden /> Describe your story
          </GhostButton>
        </div>
      </CardShell>
    );
  }

  const rows = recapRows(doc);
  const cast = doc.cast.slice(0, MAX_CAST_CHIPS);
  const moreCast = doc.cast.length - cast.length;
  const drawnAny = doc.pages.some((p) => p.render.status === 'ready');

  const change = (key: RecapKey | 'cast') => {
    if (key === 'format' || key === 'style') {
      setPanel((p) => (p === key ? null : key));
      return;
    }
    studio.setTab(key === 'cast' ? 'cast' : 'story');
  };

  // A render function (not a nested component) so toggling keeps focus on the same button.
  const changeButton = (k: RecapKey | 'cast') => {
    const inline = k === 'format' || k === 'style';
    return (
      <button
        type="button"
        onClick={() => change(k)}
        aria-label={CHANGE_LABEL[k]}
        aria-expanded={inline ? panel === k : undefined}
        className={cx(
          // Real heights (no ::after spilling over the row above): 28 px with a mouse, 44 px on touch.
          'ml-auto inline-flex min-h-[28px] shrink-0 items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-[44px] coarse:px-3',
          inline && panel === k ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-ink)]' : 'text-[var(--ds-accent)] hover:bg-[var(--ds-hover)]'
        )}
      >
        {inline && panel === k ? 'Done' : 'Change'}
      </button>
    );
  };

  return (
    <CardShell title="Here’s what I’ve got" icon={<Sparkles className="h-4 w-4" />} aria-label="What I understood" className="min-w-0 max-w-full">
      <div className="divide-y divide-[var(--ds-hairline-soft)]">
        {rows.map((row) => (
          <div key={row.key} className="py-2 first:pt-0">
            {/* The card's own width decides (not the window's): the label sits beside its value when
                there is room and above it when not, and Change drops under the row in a very narrow
                column (an iPad split pane at Text size XL) instead of being overlapped by the value. */}
            <div className={ROW}>
              <div className={ROW_MAIN}>
                <span className={cx(ROW_LABEL, 'pt-px')}>{row.label}</span>
                <span className={cx(ROW_VALUE, 'text-[13px] leading-snug [overflow-wrap:anywhere]', row.open ? 'text-[var(--ds-muted)]' : 'text-[var(--ds-ink)]')}>{row.value}</span>
              </div>
              {changeButton(row.key)}
            </div>
            {panel === row.key && row.key === 'format' && (
              <div className="mt-2 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]">
                <FormatPanel doc={doc} patch={studio.patch} byok={studio.byok} caps={studio.caps} />
              </div>
            )}
            {panel === row.key && row.key === 'style' && (
              <div className="mt-2 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]">
                <StylePanel
                  doc={doc}
                  patch={studio.patch}
                  act={studio.act}
                  byok={studio.byok}
                  caps={studio.caps}
                  onDone={() => setPanel(null)}
                  onDescribeOwn={() => composeInStudio({ text: 'Art style: ', hint: 'Describe the look — medium, line, color, mood…' })}
                />
              </div>
            )}
          </div>
        ))}
        {doc.cast.length > 0 && (
          <div className="py-2">
            <div className={ROW}>
              <div className={ROW_MAIN}>
                <span className={cx(ROW_LABEL, 'pt-1')}>Cast</span>
                <div className={ROW_VALUE}>
                  <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Cast">
                    {cast.map((c: Character) => {
                      const n = groupCount(c);
                      return (
                        <li key={c.id} className="min-w-0 max-w-full" title={c.look?.summary || c.name}>
                          <span className="flex max-w-[min(13rem,100%)] items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] py-0.5 pl-0.5 pr-2 text-[12px] text-[var(--ds-ink)]">
                            <CastAvatar character={c} urlFor={studio.urlFor} size={22} showCount={false} />
                            <span className="sr-only">{castAriaLabel(c)}</span>
                            <span className="min-w-0 truncate font-medium" aria-hidden>
                              {c.name}
                            </span>
                            {n && (
                              <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--ds-accent)]" aria-hidden>
                                ×{n}
                              </span>
                            )}
                            {castRoleLabel(c) === 'Companion' && (
                              <span className="min-w-0 truncate text-[10.5px] text-[var(--ds-muted)]" aria-hidden>
                                companion
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                    {moreCast > 0 && <li className="self-center text-[11.5px] text-[var(--ds-muted)]">+{moreCast} more</li>}
                  </ul>
                </div>
              </div>
              {changeButton('cast')}
            </div>
          </div>
        )}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--ds-muted)]">
        {drawnAny
          ? 'Changes here are free. Drawn pages are only redrawn when you ask.'
          : 'All of this is free to change — nothing is drawn until you say so.'}
      </p>
    </CardShell>
  );
};
