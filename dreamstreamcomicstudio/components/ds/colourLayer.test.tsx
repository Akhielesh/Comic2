/**
 * The colour layer "Ink & Spark" on the primitives (docs/design/design-system.md § Colour layer): the one DreamStream
 * Button variant `create` (the spark fill, data-variant="create" for the layout smoke's one-per-viewport count) and
 * Progress `tone="making"` (the spark bar while the studio draws). Atlas's six variants and its status vocabulary
 * are untouched. colourLayer.css.test.ts compiles the recipes and checks the hand-written classes.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, BUTTON_EXTENSION_VARIANTS, BUTTON_VARIANT, BUTTON_VARIANTS, buttonClasses } from './Button';
import { IconButton } from './IconButton';
import { Progress, PROGRESS_BAR, PROGRESS_MAKING } from './Progress';
import { FOCUS_RING, SHADOW_SOFT, SPARK_FILL, STATUS_DOT } from './recipes';
import { expectClasses } from './ds.testkit';

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
