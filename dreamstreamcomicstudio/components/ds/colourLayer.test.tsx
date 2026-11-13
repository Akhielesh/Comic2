/**
 * The colour layer "Ink & Spark" on the primitives (docs/design/design-system.md § Colour layer): the one DreamStream
 * Button variant `create` (the spark fill, data-variant="create" for the layout smoke's one-per-viewport count) and
 * Progress `tone="making"` (the spark bar while the studio draws). Atlas's six variants and its status vocabulary
 * are untouched. colourLayer.css.test.ts compiles the recipes and checks the hand-written classes.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as studioDesign from '../chat/studioDesign';
import { Button, BUTTON_EXTENSION_VARIANTS, BUTTON_VARIANT, BUTTON_VARIANTS, buttonClasses } from './Button';
import { IconButton } from './IconButton';
import { Progress, PROGRESS_BAR, PROGRESS_MAKING, type ProgressTone } from './Progress';
import { FOCUS_RING, SHADOW_SOFT, SPARK_FILL, STATUS_DOT } from './recipes';
import * as recipes from './recipes';
import * as ds from './index';
import { expectClasses } from './ds.testkit';

describe('the colour layer reaches the components/ds barrel (CL-0 #1, #2)', () => {
  it('Button’s extension variants and Progress’s making bar and tone come through components/ds', () => {
    expect(ds.BUTTON_EXTENSION_VARIANTS).toBe(BUTTON_EXTENSION_VARIANTS);
    expect(ds.PROGRESS_MAKING).toBe(PROGRESS_MAKING);
    expectTypeOf<ds.ProgressTone>().toEqualTypeOf<ProgressTone>();
  });

  it('recipes re-exports the three hand-written colour-layer classes (and so does the barrel), identical to studioDesign', () => {
    for (const name of ['BENDAY', 'MAKING_SWEEP', 'MAKING_TEXT'] as const) {
      expect(recipes[name], name).toBe(studioDesign[name]);
      expect(ds[name], name).toBe(studioDesign[name]);
    }
  });
});

describe('Button `create` — the spark fill, beside Atlas’s six', () => {
  it('renders the spark fill with its label token, the focus outline and data-variant="create"', () => {
    render(<Button variant="create">New comic</Button>);
    const btn = screen.getByRole('button', { name: 'New comic' });
    expectClasses(btn, SPARK_FILL, SHADOW_SOFT, FOCUS_RING);
    expect(btn).toHaveClass('bg-[var(--ds-spark)]', 'text-[var(--ds-on-spark)]', 'hover:bg-[var(--ds-spark-hover)]', 'border-transparent');
    expect(btn).toHaveAttribute('data-slot', 'button');
    expect(btn).toHaveAttribute('data-variant', 'create');
    // Keyboard focus stays the ink outline (never spark): FOCUS_RING reads --ds-focus.
    expect(btn.className).toContain('focus-visible:outline-[color:var(--ds-focus)]');
    expect(btn.className).not.toMatch(/outline-\[color:var\(--ds-spark/);
  });

  it('is an extension, not an Atlas variant: the six stay 1:1 and the default primary is still the ink accent', () => {
    expect(BUTTON_VARIANTS).not.toContain('create');
    expect(BUTTON_EXTENSION_VARIANTS).toEqual(['create']);
    expect(BUTTON_VARIANT.default).not.toMatch(/spark/);
    render(<Button>Approve</Button>);
    expect(screen.getByRole('button', { name: 'Approve' }).className).not.toMatch(/spark/);
  });

  it('works through buttonClasses (a link that starts something) and IconButton (composer Send)', () => {
    render(
      <>
        <a href="/new" className={buttonClasses({ variant: 'create', size: 'lg' })}>
          Start a comic
        </a>
        <IconButton label="Send" variant="create">
          <svg aria-hidden="true" />
        </IconButton>
      </>
    );
    expectClasses(screen.getByRole('link', { name: 'Start a comic' }), SPARK_FILL, FOCUS_RING);
    const send = screen.getByRole('button', { name: 'Send' });
    expectClasses(send, SPARK_FILL);
    expect(send).toHaveAttribute('data-variant', 'create');
  });

  it('keeps the 1 px edge (forced colours still draw it) and the 44 px coarse target like every variant', () => {
    expect(BUTTON_VARIANT.create).toMatch(/(^|\s)border-transparent(\s|$)/);
    render(<Button variant="create">Send</Button>);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('coarse:min-h-[var(--ds-density-touch)]');
  });
});

describe('Progress `tone="making"` — the spark bar while the studio draws', () => {
  it('paints the bar in the spark and keeps the progressbar semantics and words', () => {
    render(<Progress label="Drawing pages" value={2} max={6} valueText="Drawing page 3 of 6" tone="making" />);
    const bar = screen.getByRole('progressbar', { name: 'Drawing pages' });
    expect(bar).toHaveAttribute('aria-valuetext', 'Drawing page 3 of 6');
    const fill = bar.querySelector('[data-slot="progress-bar"]') as HTMLElement;
    expectClasses(fill, PROGRESS_BAR, PROGRESS_MAKING);
    expect(fill).not.toHaveClass('bg-[var(--ds-accent)]');
  });

  it('a status tone is unchanged (StatusState stays Atlas’s), and making is not one of them', () => {
    render(<Progress label="Done" value={6} max={6} tone="healthy" />);
    const fill = screen.getByRole('progressbar', { name: 'Done' }).querySelector('[data-slot="progress-bar"]')!;
    expectClasses(fill, STATUS_DOT.healthy);
    expect(Object.keys(STATUS_DOT)).toEqual(['healthy', 'active', 'waiting', 'attention', 'error']);
    expect(PROGRESS_MAKING).toBe('bg-[var(--ds-spark)]');
  });

  it('indeterminate making still pulses only when motion is allowed', () => {
    render(<Progress label="Drawing" tone="making" />);
    expectClasses(screen.getByRole('progressbar', { name: 'Drawing' }).querySelector('[data-slot="progress-bar"]')!, PROGRESS_MAKING, 'w-1/3 motion-safe:animate-pulse');
  });
});

describe('the colour specimen (CL-6, "Ink, Paper & Colour")', () => {
  it('shows the seven hues with an ink chip, an icon in the text step and an icon on each solid; words on a solid only on slots 1, 5 and 6', async () => {
    const { ColourSpecimen } = await import('./specimens/ColourSpecimen');
    const { container } = render(<ColourSpecimen />);
    const hues = within(screen.getByRole('list', { name: 'The seven hues' })).getAllByRole('listitem');
    expect(hues).toHaveLength(7);
    hues.forEach((li, i) => {
      const chip = li.querySelector(`.bg-\\[var\\(--ds-hue-${i + 1}-soft\\)\\]`) as HTMLElement;
      expect(chip, `slot ${i + 1} chip`).not.toBeNull();
      expect(chip).toHaveClass('text-[var(--ds-ink)]');
      const solid = li.querySelector(`.bg-\\[var\\(--ds-hue-${i + 1}-solid\\)\\]`) as HTMLElement;
      expect(solid.textContent, `slot ${i + 1} solid holds an icon`).toBe('');
    });
    // The words-on-a-solid row uses exactly slots 1, 5 and 6.
    const worded = [...container.querySelectorAll('[class*="-solid)]"]')].filter((el) => (el.textContent ?? '').trim()).map((el) => /--ds-hue-(\d)-solid/.exec(el.className)![1]);
    expect(worded).toEqual(['1', '5', '6']);
    // Charts: a legend in chart order, the plot on the card, never the raised step.
    expect(within(screen.getByRole('list', { name: 'Chart series legend' })).getAllByRole('listitem')).toHaveLength(7);
    const plot = screen.getByRole('img', { name: 'Sample bars, one per series' });
    expect(plot.closest('.bg-\\[var\\(--ds-surface\\)\\]')).not.toBeNull();
    expect([...plot.querySelectorAll('rect')].map((r) => r.getAttribute('class'))).toEqual([1, 2, 6, 7, 3, 4, 5].map((n) => `fill-[var(--ds-hue-${n})]`));
    // Studios: four accents and Comic Studio's none; a comic's tint inside its art scope.
    expect([...container.querySelectorAll('[data-ds-studio]')].map((el) => el.getAttribute('data-ds-studio'))).toEqual(['chat', 'live', 'models', 'atlas', 'comic']);
    const art = container.querySelector('[data-qa-art]') as HTMLElement;
    expect(art).toHaveClass('ds-art-scope', 'bg-[var(--ds-art-soft)]', 'border-[color:var(--ds-art-edge)]');
    expect(art.style.getPropertyValue('--ds-art')).toBe('var(--ds-hue-3)');
    // No price and no spend control anywhere; no spark fill.
    expect(container.textContent).not.toMatch(/\$|¢|of your usage|Approve|Redraw|Translate|Get more/);
    expect(container.querySelector('[data-variant="create"]')).toBeNull();
  });
});
