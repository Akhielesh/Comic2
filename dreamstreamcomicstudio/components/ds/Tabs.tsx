/**
 * Tabs — Atlas Tabs / PanelTabs: a tab list on SEGMENTED_TRACK with the gliding SEGMENTED_PILL under
 * the selected tab, and the panels it controls.
 *
 *   <Tabs defaultValue="pages">
 *     <TabsList label="Comic sections"><TabsTrigger value="pages">Pages</TabsTrigger>…</TabsList>
 *     <TabsContent value="pages">…</TabsContent>
 *   </Tabs>
 *
 * WAI-ARIA tabs with automatic activation: the arrow keys (mirrored right-to-left) move to the next
 * enabled tab and select it, Home / End jump; only the selected tab is in the tab order, and its panel
 * (role tabpanel, labelled by the tab, focusable) follows it. Inactive panels are not rendered. Controlled
 * (`value` + `onValueChange`) or not (`defaultValue`).
 */
import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING, FOCUS_RING_FLUSH, SEGMENTED_ITEM, SEGMENTED_PILL, SEGMENTED_TRACK } from './recipes';
import { isRtl, nextRovingIndex } from './roving';
import { SEGMENTED_ITEM_EDGE, SEGMENTED_SIZE, type SegmentedSize } from './Segmented';
import { useGlidingPill } from './useGlidingPill';

interface TabsContextValue {
  value: string;
  select: (value: string) => void;
  idFor: (kind: 'tab' | 'panel', value: string) => string;
}
const TabsContext = createContext<TabsContextValue | null>(null);
/** The list's size, for its triggers. */
const TabsSizeContext = createContext<SegmentedSize>('default');
const useTabs = (part: string): TabsContextValue => {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error(`${part} must be inside <Tabs>`);
  return ctx;
};

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function Tabs({ value, defaultValue, onValueChange, className, children, ...rest }: TabsProps) {
  const [inner, setInner] = useState(defaultValue ?? '');
  const current = value ?? inner;
  const base = useId().replace(/:/g, '');
  const select = useCallback(
    (next: string) => {
      if (value === undefined) setInner(next);
      onValueChange?.(next);
    },
    [value, onValueChange]
  );
  const ctx = useMemo<TabsContextValue>(
    () => ({ value: current, select, idFor: (kind, v) => `tabs-${base}-${kind}-${v.replace(/[^\w-]/g, '_')}` }),
    [current, select, base]
  );
  return (
    <TabsContext.Provider value={ctx}>
      <div {...rest} data-slot="tabs" className={cn('flex min-w-0 flex-col gap-2', className)}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The tab list's accessible name. */
  label: string;
  size?: SegmentedSize;
  fullWidth?: boolean;
}

export function TabsList({ label, size = 'default', fullWidth = false, className, children, ...rest }: TabsListProps) {
  const { value, select } = useTabs('TabsList');
  const track = useRef<HTMLDivElement>(null);
  const { rect, ready } = useGlidingPill(track, '[role="tab"][aria-selected="true"]', '[role="tab"]', `${value}|${React.Children.count(children)}`);
  // No tab chosen (no value / defaultValue, or it names no tab): the first enabled tab is selected, so the
  // list is never without a tab stop and a panel.
  useEffect(() => {
    const el = track.current;
    if (!el || el.querySelector('[role="tab"][aria-selected="true"]')) return;
    const first = el.querySelector<HTMLButtonElement>('[role="tab"]:not([disabled])');
    if (first?.dataset.value !== undefined) select(first.dataset.value);
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(track.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const at = tabs.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    const next = nextRovingIndex(e.key, at, tabs.map((t) => !t.disabled), isRtl(track.current));
    if (next === null) return;
    e.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  };

  return (
    <div
      {...rest}
      ref={track}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      data-slot="tabs-list"
      data-size={size}
      onKeyDown={onKeyDown}
      className={cn(SEGMENTED_TRACK, fullWidth ? 'flex w-full' : 'w-fit', className)}
    >
      {rect ? (
        <span
          aria-hidden="true"
          data-slot="tabs-pill"
          className={cn(SEGMENTED_PILL, !ready && 'transition-none')}
          style={{ width: rect.width, transform: `translateX(${rect.left}px)` }}
        />
      ) : null}
      <TabsSizeContext.Provider value={size}>{children}</TabsSizeContext.Provider>
    </div>
  );
}

export interface TabsTriggerProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  value: string;
}

export const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(function TabsTrigger({ value, className, children, onClick, ...rest }, ref) {
  const tabs = useTabs('TabsTrigger');
  const selected = tabs.value === value;
  const size = useContext(TabsSizeContext);
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role="tab"
      id={tabs.idFor('tab', value)}
      aria-selected={selected}
      aria-controls={selected ? tabs.idFor('panel', value) : undefined}
      tabIndex={selected ? 0 : -1}
      data-state={selected ? 'active' : 'inactive'}
      data-value={value}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented && !selected) tabs.select(value);
      }}
      className={`${cn(SEGMENTED_ITEM, SEGMENTED_SIZE[size], SEGMENTED_ITEM_EDGE, DENSITY.coarse, className)} ${FOCUS_RING_FLUSH}`}
    >
      {children}
    </button>
  );
});

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ value, className, children, ...rest }: TabsContentProps) {
  const tabs = useTabs('TabsContent');
  if (tabs.value !== value) return null;
  return (
    <div
      {...rest}
      role="tabpanel"
      id={tabs.idFor('panel', value)}
      aria-labelledby={tabs.idFor('tab', value)}
      tabIndex={0}
      data-slot="tabs-content"
      className={`${cn('min-w-0 flex-1 rounded-[var(--ds-radius-sm)]', className)} ${FOCUS_RING}`}
    >
      {children}
    </div>
  );
}
