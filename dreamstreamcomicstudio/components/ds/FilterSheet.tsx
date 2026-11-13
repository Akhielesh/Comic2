/**
 * FilterSheet — every filter and sort in one sheet when the toolbar has no room (redesign plan §4, §6.2: the Library's
 * "Sort & view" sheet below 600 px, Discover's filters on phones and tablets). A bottom sheet on phones and a side
 * sheet beside the grid on tablets (`presentation`, from layout.ts `discover.filters` / the Library's width): the
 * mobile sheets (components/ds/sheet) bring the drag, Esc, the scrim, the back-stack and focus return.
 *
 * The body is the screen's (FilterChips groups, a Segmented sort, a Switch); the sheet adds a titled group per
 * section and one footer: "Clear filters" (only while something is set) and the primary "Show {resultText}"
 * ("Show 12 comics"), which closes the sheet. Filters apply as they change, so closing the sheet any other way
 * keeps them too. Nothing here fetches; no price, no spark.
 */
import React from 'react';
import { BottomSheet, SideSheet } from './sheet';
import { Button } from './Button';
import { OVERLINE } from './recipes';

export interface FilterSheetSection {
  id: string;
  title: string;
  content: React.ReactNode;
}

export interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  /** Bottom sheet on phones, side sheet beside the grid from 600 px. */
  presentation: 'sheet' | 'side-sheet';
  title?: string;
  sections: readonly FilterSheetSection[];
  /** The result count in words ("12 comics"): the primary reads "Show 12 comics". */
  resultText?: string;
  /** Clear every filter (shown while `active`). */
  onClear?: () => void;
  /** Whether any filter is set. */
  active?: boolean;
  /** The control that opened the sheet (focus returns there). */
  anchorRef?: React.RefObject<HTMLElement | null>;
  sideWidth?: number;
}

function Body({ sections, resultText, onClear, active, onClose }: Pick<FilterSheetProps, 'sections' | 'resultText' | 'onClear' | 'active' | 'onClose'>) {
  return (
    <div data-slot="filter-sheet" className="flex min-w-0 flex-col gap-5 px-4 pb-4 pt-1">
      {sections.map((s) => (
        <section key={s.id} aria-labelledby={`filter-sheet-${s.id}`} className="flex min-w-0 flex-col gap-2">
          <h3 id={`filter-sheet-${s.id}`} className={`m-0 ${OVERLINE}`}>
            {s.title}
          </h3>
          {s.content}
        </section>
      ))}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--ds-hairline)] pt-3">
        {active && onClear ? (
          <Button variant="ghost" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
        <Button onClick={onClose}>{resultText ? `Show ${resultText}` : 'Done'}</Button>
      </div>
    </div>
  );
}

export function FilterSheet({ open, onClose, presentation, title = 'Filters', sections, resultText, onClear, active = false, anchorRef, sideWidth = 360 }: FilterSheetProps) {
  const body = <Body sections={sections} resultText={resultText} onClear={onClear} active={active} onClose={onClose} />;
  if (presentation === 'side-sheet') {
    return (
      <SideSheet open={open} onClose={onClose} label={title} title={title} modal width={sideWidth} anchorRef={anchorRef}>
        {body}
      </SideSheet>
    );
  }
  return (
    <BottomSheet open={open} onClose={onClose} label={title} title={title} anchorRef={anchorRef}>
      {body}
    </BottomSheet>
  );
}
