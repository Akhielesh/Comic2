import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cn } from '../../lib/utils';
import { Segmented, SEGMENTED_ITEM_EDGE, SEGMENTED_SIZE } from './Segmented';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs';
import { Switch, SWITCH_THUMB, SWITCH_TRACK } from './Switch';
import { Slider, SLIDER_CLASSES, snapToStep } from './Slider';
import { Checkbox, CHECKBOX_BOX, CHECKBOX_INPUT } from './Checkbox';
import { Progress, PROGRESS_BAR, PROGRESS_TRACK } from './Progress';
import { FOCUS_RING, FOCUS_RING_FLUSH, SEGMENTED_ITEM, SEGMENTED_TRACK, STATUS_DOT } from './recipes';
import { nextRovingIndex } from './roving';
import { expectClasses } from './testUtils';

const VIEWS = [
  { value: 'scroll', label: 'Scroll' },
  { value: 'page', label: 'Page' },
  { value: 'spread', label: 'Spread', disabled: true },
  { value: 'grid', label: 'Grid' }
] as const;
type View = (typeof VIEWS)[number]['value'];

function ControlledSegmented({ onChange }: { onChange?: (v: View) => void }) {
  const [value, setValue] = useState<View>('scroll');
  return (
    <Segmented<View>
      label="Reading view"
      value={value}
      options={VIEWS}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe('roving focus', () => {
  it('moves to the next / previous enabled item, wraps, jumps with Home / End and mirrors Left / Right in RTL', () => {
    const enabled = [true, true, false, true];
    expect(nextRovingIndex('ArrowRight', 1, enabled)).toBe(3);
    expect(nextRovingIndex('ArrowRight', 3, enabled)).toBe(0);
    expect(nextRovingIndex('ArrowLeft', 0, enabled)).toBe(3);
    expect(nextRovingIndex('ArrowDown', 0, enabled)).toBe(1);
    expect(nextRovingIndex('ArrowUp', 1, enabled)).toBe(0);
    expect(nextRovingIndex('Home', 3, enabled)).toBe(0);
    expect(nextRovingIndex('End', 0, enabled)).toBe(3);
    expect(nextRovingIndex('ArrowRight', 1, enabled, true)).toBe(0);
    expect(nextRovingIndex('ArrowLeft', 1, enabled, true)).toBe(3);
    expect(nextRovingIndex('a', 1, enabled)).toBeNull();
  });
});

describe('Segmented — a radio group on the track with the gliding pill', () => {
  it('radios with aria-checked, one tab stop on the chosen item, the Atlas item recipe and the flush focus outline', () => {
    render(<ControlledSegmented />);
    const group = screen.getByRole('radiogroup', { name: 'Reading view' });
    expectClasses(group, SEGMENTED_TRACK);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(radios[2]).toBeDisabled();
    expectClasses(radios[0], cn(SEGMENTED_ITEM, SEGMENTED_SIZE.default, SEGMENTED_ITEM_EDGE), FOCUS_RING_FLUSH);
  });

  it('arrow keys choose as they move (skipping the disabled item), Home / End jump', () => {
    const onChange = vi.fn();
    render(<ControlledSegmented onChange={onChange} />);
    const radios = () => screen.getAllByRole('radio');
    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('page');
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios()[1]).toHaveFocus();
    expect(radios()[1].tabIndex).toBe(0);
    fireEvent.keyDown(radios()[1], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('grid'); // "Spread" is disabled
    fireEvent.keyDown(radios()[3], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('scroll'); // wraps
    fireEvent.keyDown(radios()[0], { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('grid');
    fireEvent.keyDown(radios()[3], { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('scroll');
    fireEvent.click(radios()[1]);
    expect(onChange).toHaveBeenLastCalledWith('page');
  });

  it('a value that names no enabled item leaves the first enabled one in the tab order', () => {
    render(<Segmented label="Mode" value={'x' as string} options={[{ value: 'a', label: 'A', disabled: true }, { value: 'b', label: 'B' }]} onChange={() => undefined} />);
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, 0]);
  });
});

describe('Tabs — WAI-ARIA tabs with automatic activation', () => {
  const renderTabs = (onValueChange?: (v: string) => void) =>
    render(
      <Tabs defaultValue="pages" onValueChange={onValueChange}>
        <TabsList label="Comic sections">
          <TabsTrigger value="pages">Pages</TabsTrigger>
          <TabsTrigger value="cast">Cast</TabsTrigger>
          <TabsTrigger value="notes" disabled>
            Notes
          </TabsTrigger>
          <TabsTrigger value="share">Share</TabsTrigger>
        </TabsList>
        <TabsContent value="pages">Pages panel</TabsContent>
        <TabsContent value="cast">Cast panel</TabsContent>
        <TabsContent value="share">Share panel</TabsContent>
      </Tabs>
    );

  it('tabs with aria-selected, the selected one controlling its labelled panel; one tab stop', () => {
    renderTabs();
    const list = screen.getByRole('tablist', { name: 'Comic sections' });
    expectClasses(list, SEGMENTED_TRACK);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    const panel = screen.getByRole('tabpanel', { name: 'Pages' });
    expect(panel).toHaveTextContent('Pages panel');
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
    expect(screen.queryByText('Cast panel')).toBeNull();
    expectClasses(tabs[0], SEGMENTED_ITEM_EDGE, FOCUS_RING_FLUSH);
    expectClasses(panel, FOCUS_RING);
  });

  it('arrow keys move and select (skipping disabled tabs), Home / End jump, the panel follows', () => {
    const onValueChange = vi.fn();
    renderTabs(onValueChange);
    const tab = (name: string) => screen.getByRole('tab', { name });
    tab('Pages').focus();
    fireEvent.keyDown(tab('Pages'), { key: 'ArrowRight' });
    expect(tab('Cast')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Cast')).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Cast' })).toHaveTextContent('Cast panel');
    fireEvent.keyDown(tab('Cast'), { key: 'ArrowRight' });
    expect(tab('Share')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab('Share'), { key: 'Home' });
    expect(tab('Pages')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab('Pages'), { key: 'End' });
    expect(tab('Share')).toHaveAttribute('aria-selected', 'true');
    expect(onValueChange.mock.calls.map((c) => c[0])).toEqual(['cast', 'share', 'pages', 'share']);
  });

  it('without a value the first enabled tab is selected, so there is always a tab stop and a panel', () => {
    render(
      <Tabs>
        <TabsList label="Views">
          <TabsTrigger value="a" disabled>
            A
          </TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="b">B panel</TabsContent>
      </Tabs>
    );
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('B panel');
  });
});

describe('Switch — role switch, aria-checked, Space and Enter', () => {
  it('toggles on click, Space and Enter; a held key does not repeat; reports each change', () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Autosave" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole('switch', { name: 'Autosave' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAttribute('type', 'button');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(sw, { key: ' ' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(sw, { key: 'Enter', repeat: true });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(sw, { key: 'a' });
    expect(onCheckedChange.mock.calls.map((c) => c[0])).toEqual([true, false, true]);
  });

  it('controlled: shows the value it is given; disabled does not toggle', () => {
    const onCheckedChange = vi.fn();
    const { rerender } = render(<Switch aria-label="Sync" checked onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole('switch', { name: 'Sync' });
    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    rerender(<Switch aria-label="Sync" checked={false} disabled onCheckedChange={onCheckedChange} />);
    fireEvent.keyDown(sw, { key: ' ' });
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
  });

  it('the Atlas track and thumb, the state on both, the focus outline', () => {
    render(<Switch aria-label="Dark" defaultChecked />);
    const sw = screen.getByRole('switch', { name: 'Dark' });
    expectClasses(sw, SWITCH_TRACK, FOCUS_RING);
    expect(sw).toHaveAttribute('data-state', 'checked');
    const thumb = sw.querySelector('[data-slot="switch-thumb"]')!;
    expectClasses(thumb, SWITCH_THUMB);
    expect(thumb).toHaveAttribute('data-state', 'checked');
    expect(SWITCH_TRACK).toContain('data-[state=checked]:bg-[var(--ds-accent-fill)]');
    expect(SWITCH_THUMB).toContain('rtl:data-[state=checked]:-translate-x-[calc(100%-2px)]');
  });
});

describe('Slider — native range, the keyboard handled here', () => {
  it('snapToStep clamps and snaps without float noise', () => {
    expect(snapToStep(0.30000000000000004, 0, 1, 0.1)).toBe(0.3);
    expect(snapToStep(7, 0, 10, 5)).toBe(5);
    expect(snapToStep(-3, 0, 10, 1)).toBe(0);
    expect(snapToStep(12, 0, 10, 1)).toBe(10);
  });

  it('arrows move a step, Page Up / Down a tenth, Home / End the ends; values clamp; aria-valuetext speaks', () => {
    const onValueChange = vi.fn();
    render(<Slider aria-label="Panel gutter" defaultValue={50} step={2} onValueChange={onValueChange} valueText={(v) => `${v} pixels`} />);
    const slider = screen.getByRole('slider', { name: 'Panel gutter' }) as HTMLInputElement;
    expect(slider.value).toBe('50');
    expect(slider).toHaveAttribute('aria-valuetext', '50 pixels');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.value).toBe('52');
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(slider.value).toBe('50');
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(slider.value).toBe('60');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.value).toBe('100');
    fireEvent.keyDown(slider, { key: 'ArrowRight' }); // already at max: no change reported
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.value).toBe('0');
    expect(slider).toHaveAttribute('aria-valuetext', '0 pixels');
    expect(onValueChange.mock.calls.map((c) => c[0])).toEqual([52, 50, 60, 100, 0]);
    // The fill follows the value.
    expect(slider.style.getPropertyValue('--slider-fill')).toBe('0%');
  });

  it('pointer changes come through the native input; the Atlas track and thumb, the focus outline', () => {
    const onValueChange = vi.fn();
    render(<Slider aria-label="Zoom" min={50} max={200} defaultValue={100} onValueChange={onValueChange} />);
    const slider = screen.getByRole('slider', { name: 'Zoom' });
    fireEvent.change(slider, { target: { value: '150' } });
    expect(onValueChange).toHaveBeenLastCalledWith(150);
    expectClasses(slider, SLIDER_CLASSES, FOCUS_RING);
    expect(SLIDER_CLASSES).toContain('[&::-webkit-slider-runnable-track]:h-4');
    expect(SLIDER_CLASSES).toContain('[&::-webkit-slider-thumb]:size-4');
  });

  it('disabled ignores the keyboard', () => {
    const onValueChange = vi.fn();
    render(<Slider aria-label="Locked" disabled defaultValue={3} max={10} onValueChange={onValueChange} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Locked' }), { key: 'ArrowRight' });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('Checkbox — native, with indeterminate', () => {
  it('indeterminate sets the input’s DOM flag (spoken as mixed) and a press reports true', () => {
    const onCheckedChange = vi.fn();
    const { rerender } = render(<Checkbox aria-label="Select all pages" checked="indeterminate" onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole('checkbox', { name: 'Select all pages' }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
    expect(box).toHaveAttribute('data-state', 'indeterminate');
    fireEvent.click(box);
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    // A parent that keeps "indeterminate" keeps the flag on the input.
    rerender(<Checkbox aria-label="Select all pages" checked="indeterminate" onCheckedChange={onCheckedChange} />);
    expect(box.indeterminate).toBe(true);
    rerender(<Checkbox aria-label="Select all pages" checked onCheckedChange={onCheckedChange} />);
    expect(box.indeterminate).toBe(false);
    expect(box.checked).toBe(true);
    expect(box).toHaveAttribute('data-state', 'checked');
  });

  it('uncontrolled toggles natively; a label row names it and is the target; the drawn box and marks are hidden', () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Show page numbers" description="In the reader and the PDF." onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole('checkbox', { name: 'Show page numbers' });
    expect(box).toHaveAccessibleDescription('In the reader and the PDF.');
    fireEvent.click(screen.getByText('Show page numbers')); // the label toggles it
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    expect(box).toBeChecked();
    expectClasses(box, CHECKBOX_INPUT);
    const wrap = box.parentElement!;
    expectClasses(wrap.querySelector('[data-slot="checkbox-box"]')!, CHECKBOX_BOX);
    for (const slot of ['checkbox-box', 'checkbox-check', 'checkbox-dash']) expect(wrap.querySelector(`[data-slot="${slot}"]`)).toHaveAttribute('aria-hidden', 'true');
    // The drawn box takes FOCUS_RING from the input (peer-focus-visible), spelled out in full.
    expect(CHECKBOX_BOX).toContain(FOCUS_RING.replace(/focus-visible:/g, 'peer-focus-visible:'));
  });
});

describe('Progress', () => {
  it('a determinate bar: progressbar with its range, the width, the accent or a status tone', () => {
    const { rerender } = render(<Progress label="Drawing pages" value={30} valueText="3 of 10 pages" />);
    const bar = screen.getByRole('progressbar', { name: 'Drawing pages' });
    expect(bar).toHaveAttribute('aria-valuenow', '30');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuetext', '3 of 10 pages');
    expectClasses(bar, PROGRESS_TRACK);
    const fill = bar.querySelector('[data-slot="progress-bar"]') as HTMLElement;
    expectClasses(fill, PROGRESS_BAR, 'bg-[var(--ds-accent)]');
    expect(fill.style.width).toBe('30%');
    rerender(<Progress label="Drawing pages" value={140} tone="error" />);
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar).toHaveAttribute('data-state', 'complete');
    expectClasses(fill, STATUS_DOT.error);
  });

  it('indeterminate: no aria-valuenow, a pulsing third (still under reduced motion)', () => {
    render(<Progress label="Preparing" />);
    const bar = screen.getByRole('progressbar', { name: 'Preparing' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
    expectClasses(bar.querySelector('[data-slot="progress-bar"]')!, 'w-1/3 motion-safe:animate-pulse');
  });

  it('forced colours (Atlas): the track outlined in the text colour, the bar in the system highlight', () => {
    expect(PROGRESS_TRACK).toContain('forced-colors:border forced-colors:border-[CanvasText]');
    expect(PROGRESS_BAR).toContain('forced-colors:[forced-color-adjust:none] forced-colors:bg-[Highlight]');
  });
});
