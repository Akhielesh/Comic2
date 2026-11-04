/**
 * Every interactive primitive is a 44 px target under a coarse pointer (the `coarse:` screen,
 * tailwind.config.cjs) and keeps an edge forced-colours mode can draw. Controls that are small by design
 * (Switch, Checkbox) reach 44 × 44 through an invisible hit area instead of growing.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Star } from 'lucide-react';
import { Button, BUTTON_SIZES } from './Button';
import { IconButton } from './IconButton';
import { Input, Textarea } from './Input';
import { Select } from './Select';
import { Segmented } from './Segmented';
import { Tabs, TabsList, TabsTrigger } from './Tabs';
import { Switch } from './Switch';
import { Slider } from './Slider';
import { Checkbox } from './Checkbox';
import { DENSITY } from './recipes';
import { expectClasses } from './ds.testkit';

const TOUCH = 'coarse:min-h-[var(--ds-density-touch)]';
const TOUCH_SQUARE = 'coarse:min-h-[var(--ds-density-touch)] coarse:min-w-[var(--ds-density-touch)]';
/** A 1 px edge (any colour, transparent included): forced-colours mode paints it in the system colour. */
const hasEdge = (el: Element) => el.classList.contains('border');

describe('coarse pointer: 44 px on every interactive primitive', () => {
  it('the density token is the 44 px the recipes read', () => {
    expect(DENSITY.coarse).toBe(TOUCH);
    expect(DENSITY.coarseSquare).toBe(TOUCH_SQUARE);
  });

  it('Button (every size), IconButton (square)', () => {
    for (const size of BUTTON_SIZES) {
      const { unmount } = render(
        <Button size={size} aria-label={`b-${size}`}>
          <Star />
        </Button>
      );
      const btn = screen.getByRole('button', { name: `b-${size}` });
      expectClasses(btn, size === 'icon' ? TOUCH_SQUARE : TOUCH);
      expect(hasEdge(btn), size).toBe(true);
      unmount();
    }
    render(
      <IconButton label="Star">
        <Star />
      </IconButton>
    );
    const icon = screen.getByRole('button', { name: 'Star' });
    expectClasses(icon, TOUCH_SQUARE);
    expect(hasEdge(icon)).toBe(true);
  });

  it('Input, Textarea, Select', () => {
    render(
      <>
        <Input aria-label="i" />
        <Textarea aria-label="t" />
        <Select aria-label="s" options={[{ value: 'a', label: 'A' }]} />
      </>
    );
    for (const name of ['i', 's']) {
      const el = screen.getByLabelText(name);
      expectClasses(el, TOUCH);
      expect(hasEdge(el), name).toBe(true);
    }
    // The textarea is at least 64 px everywhere; a coarse min-height of 44 px would LOWER its floor there.
    const ta = screen.getByLabelText('t');
    expectClasses(ta, 'min-h-16');
    expect(ta.className).not.toContain('coarse:min-h-');
    expect(hasEdge(ta)).toBe(true);
  });

  it('Segmented items and tab triggers', () => {
    render(
      <>
        <Segmented label="seg" value="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} onChange={() => undefined} />
        <Tabs defaultValue="x">
          <TabsList label="tabs">
            <TabsTrigger value="x">X</TabsTrigger>
            <TabsTrigger value="y">Y</TabsTrigger>
          </TabsList>
        </Tabs>
      </>
    );
    for (const el of [...screen.getAllByRole('radio'), ...screen.getAllByRole('tab')]) {
      expectClasses(el, TOUCH);
      expect(hasEdge(el)).toBe(true);
    }
  });

  it('Slider: the control is 44 px tall (the 16 px track stays centred)', () => {
    render(<Slider aria-label="r" />);
    expectClasses(screen.getByRole('slider', { name: 'r' }), TOUCH);
  });

  it('Switch: a 44 × 44 invisible hit area centred on the 32 × 18 track; edges on the track and the thumb', () => {
    render(<Switch aria-label="sw" />);
    const sw = screen.getByRole('switch', { name: 'sw' });
    expectClasses(
      sw,
      'coarse:after:absolute coarse:after:left-1/2 coarse:after:top-1/2 coarse:after:h-[var(--ds-density-touch)] coarse:after:w-[var(--ds-density-touch)] coarse:after:-translate-x-1/2 coarse:after:-translate-y-1/2',
      'relative'
    );
    expect(hasEdge(sw)).toBe(true);
    expect(hasEdge(sw.querySelector('[data-slot="switch-thumb"]')!)).toBe(true);
  });

  it('Checkbox: the native input spreads to 44 × 44 over the 16 px box; the drawn box keeps its edge; the label row is 44 px', () => {
    render(<Checkbox label="cb" />);
    const input = screen.getByRole('checkbox', { name: 'cb' });
    expectClasses(input, 'absolute inset-0 coarse:-inset-[calc((var(--ds-density-touch)_-_100%)/2)] opacity-0');
    expect(hasEdge(input.parentElement!.querySelector('[data-slot="checkbox-box"]')!)).toBe(true);
    expectClasses(input.closest('[data-slot="checkbox-row"]')!, TOUCH);
  });
});
