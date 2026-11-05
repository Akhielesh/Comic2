/**
 * Atlas Studio's moment (its own HeroSearchDemo, smaller): a query types into the search bar, "Searching"
 * shimmers over skeleton rows, then matches from several connected accounts settle in (`.ds-stagger`).
 * Sample content only; every source named is one of Atlas's beta connectors.
 */
import React from 'react';
import { CornerDownLeft, FileSpreadsheet, FileText, Mail, Search } from 'lucide-react';
import { useMomentClock, type MomentStep } from './useMomentClock';

const QUERY = 'acme invoice 4821';

const STEPS: readonly MomentStep[] = [
  { id: 'type', ms: 250, type: QUERY },
  { id: 'search', ms: 900 },
  { id: 'hold', ms: 3200 },
  { id: 'clear', ms: 450 }
];

const RESULTS = [
  { title: 'Invoice #4821 from Acme', meta: 'Gmail · Attachment · PDF', Icon: Mail },
  { title: 'Acme_Invoice_4821.pdf', meta: 'Dropbox · Finance / 2026', Icon: FileText },
  { title: 'Vendor spend, Q3', meta: 'Google Drive · Row 212 matches', Icon: FileSpreadsheet }
];

export function AtlasMoment() {
  const clock = useMomentClock(STEPS, 'hold');
  const { animated, cycle, step } = clock;
  const showResults = clock.reached('hold');

  return (
    <div ref={clock.ref} data-inview={clock.inview} className="flex h-full flex-col gap-2 p-3">
      <div className="flex h-10 shrink-0 items-center gap-2.5 rounded-[var(--ds-radius-control)] border border-ds-control-border bg-ds-canvas px-3">
        <Search className="size-4 shrink-0 text-ds-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ds-ink">
          {clock.typed('type')}
          {clock.typing('type') ? <span className="ds-caret" /> : null}
        </span>
      </div>

      <div className={`min-h-0 flex-1 overflow-hidden transition-opacity duration-[var(--ds-motion-panel)] ease-[var(--ds-ease)] ${step === 'clear' ? 'opacity-0' : ''}`}>
        <p className="ds-overline flex h-7 items-center justify-between px-1">
          {showResults ? (
            <span key={`n-${cycle}`} className={animated ? 'ds-blur-in' : undefined}>
              3 results · 3 sources
            </span>
          ) : clock.reached('search') ? (
            <span className="ds-shimmer-text">Searching your sources…</span>
          ) : (
            <span>&nbsp;</span>
          )}
        </p>
        {showResults ? (
          <ul key={`r-${cycle}`} className={`flex flex-col gap-0.5 ${animated ? 'ds-stagger' : ''}`}>
            {RESULTS.map(({ title, meta, Icon }, i) => (
              <li key={title} className={`flex items-center gap-2.5 rounded-[var(--ds-radius-panel)] px-2 py-2 ${i === 0 ? 'bg-ds-accent-soft' : ''}`}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] border border-ds-hairline bg-ds-canvas text-ds-ink">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-ds-ink">{title}</span>
                  <span className="block truncate text-[11.5px] text-ds-muted">{meta}</span>
                </span>
                {i === 0 ? <CornerDownLeft className="size-3.5 shrink-0 text-ds-muted" aria-hidden="true" /> : null}
              </li>
            ))}
            <li className="mt-2 rounded-[var(--ds-radius-panel)] border border-ds-hairline bg-ds-canvas p-3">
              <span className="ds-overline block">Preview · Invoice #4821</span>
              <span className="mt-1.5 flex items-baseline justify-between gap-3 text-[12px] text-ds-ink">
                <span className="truncate">Acme Ltd · Design retainer, October</span>
                <span className="shrink-0 font-medium tabular-nums">$1,240.00</span>
              </span>
              <span className="mt-1 block truncate text-[11.5px] text-ds-muted">Due in 30 days · PDF, 2 pages</span>
            </li>
          </ul>
        ) : clock.reached('search') ? (
          <ul className="flex flex-col gap-0.5">
            {[64, 52, 40].map((w) => (
              <li key={w} className="flex items-center gap-2.5 px-2 py-2">
                <span className="ds-skeleton size-8 shrink-0 rounded-[var(--ds-radius-control)]" />
                <span className="flex flex-1 flex-col gap-1.5">
                  <span className="ds-skeleton block h-3 rounded-[var(--ds-radius-sm)]" style={{ width: `${w}%` }} />
                  <span className="ds-skeleton block h-2.5 w-1/3 rounded-[var(--ds-radius-sm)]" />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
