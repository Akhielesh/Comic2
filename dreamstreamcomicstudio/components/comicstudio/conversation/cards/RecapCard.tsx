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
          'tap-target shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40',
          inline && panel === k ? 'bg-[#D97757]/10 text-[var(--ds-ink)]' : 'text-[var(--ds-accent)] hover:bg-[var(--ds-hover)]'
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
            {/* Phones: the label sits above its value so the value gets the row's full width. */}
            <div className="flex min-w-0 items-start gap-3">
              <div className="min-w-0 flex-1 sm:flex sm:items-start sm:gap-3">
                <span className="block pt-px text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] sm:w-[4.25rem] sm:shrink-0">{row.label}</span>
                <span
                  className={cx(
                    'mt-0.5 block min-w-0 text-[13px] leading-snug [overflow-wrap:anywhere] sm:mt-0 sm:flex-1',
                    row.open ? 'text-[var(--ds-muted)]' : 'text-[var(--ds-ink)]'
                  )}
                >
                  {row.value}
                </span>
              </div>
              {changeButton(row.key)}
            </div>
            {panel === row.key && row.key === 'format' && (
              <div className="mt-2 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]">
                <FormatPanel doc={doc} patch={studio.patch} byok={studio.byok} />
              </div>
            )}
            {panel === row.key && row.key === 'style' && (
              <div className="mt-2 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]">
                <StylePanel
                  doc={doc}
                  patch={studio.patch}
                  act={studio.act}
                  byok={studio.byok}
                  onDone={() => setPanel(null)}
                  onDescribeOwn={() => composeInStudio({ text: 'Art style: ', hint: 'Describe the look — medium, line, color, mood…' })}
                />
              </div>
            )}
          </div>
        ))}
        {doc.cast.length > 0 && (
          <div className="py-2">
            <div className="flex min-w-0 items-start gap-3">
              <div className="min-w-0 flex-1 sm:flex sm:items-start sm:gap-3">
                <span className="block pt-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] sm:w-[4.25rem] sm:shrink-0">Cast</span>
                <div className="mt-1 min-w-0 sm:mt-0 sm:flex-1">
                  <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Cast">
                    {cast.map((c: Character) => {
                      const n = groupCount(c);
                      return (
                        <li key={c.id} className="min-w-0 max-w-full" title={c.look?.summary || c.name}>
                          <span className="flex max-w-[13rem] items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] py-0.5 pl-0.5 pr-2 text-[12px] text-[var(--ds-ink)]">
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
                              <span className="shrink-0 text-[10.5px] text-[var(--ds-muted)]" aria-hidden>
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
