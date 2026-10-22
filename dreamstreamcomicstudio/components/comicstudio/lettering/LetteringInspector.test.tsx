import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, act, screen, within } from '@testing-library/react';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../shared/comic/lettering/layout';
import { LetteringInspector, placeInspector } from './LetteringInspector';
import { resolvePlacements } from './useLetterPlans';
import { computeSnap, snapTargets } from './SnapGuides';
import { nextSelection, useLetteringSelection } from './useLetteringSelection';
import { CoverTitleLayer, planCoverTitle } from './CoverTitleLayer';
import { PresetGallery } from './PresetGallery';
import { LetteringSvg } from './LetteringSvg';
import { ShapePicker, TailPicker } from './ShapePicker';
import { BUBBLE_SHAPES, TAIL_STYLES } from '../../../shared/comic/lettering/style';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;

const inspector = (lineIds: string[], extra: Partial<React.ComponentProps<typeof LetteringInspector>> = {}, doc = makeSampleDoc()) => {
  const page = doc.pages[0];
  const plans = planLettering(doc, page, ASPECT, estimateMeasure);
  const placements = resolvePlacements(doc, page, ASPECT, estimateMeasure);
  const apply = vi.fn();
  const utils = render(
    <LetteringInspector
      doc={doc}
      page={page}
      lineIds={lineIds}
      plans={plans}
      placements={placements}
      H={H}
      apply={apply}
      onEditText={vi.fn()}
      onAskAI={vi.fn()}
      onDeselect={vi.fn()}
      mode="easy"
      onModeChange={vi.fn()}
      canPro
      anchor={{ left: 100, top: 100, right: 200, bottom: 160 }}
      compact={false}
      onClose={vi.fn()}
      {...extra}
    />
  );
  return { ...utils, apply, doc, page };
};

describe('placeInspector (stays inside the viewport)', () => {
  const size = { w: 320, h: 400 };
  const vp = { w: 1280, h: 800 };
  it('prefers the right of the selection', () => {
    expect(placeInspector({ left: 100, top: 100, right: 200, bottom: 160 }, size, vp)).toEqual({ left: 212, top: 100, side: 'right' });
  });
  it('flips to the left near the right edge', () => {
    const p = placeInspector({ left: 1000, top: 100, right: 1200, bottom: 160 }, size, vp);
    expect(p.side).toBe('left');
    expect(p.left + size.w).toBeLessThanOrEqual(1000);
  });
  it('goes below/above when neither side fits, and is clamped as a last resort', () => {
    expect(placeInspector({ left: 100, top: 50, right: 1200, bottom: 120 }, size, vp).side).toBe('below');
    expect(placeInspector({ left: 100, top: 600, right: 1200, bottom: 780 }, size, vp).side).toBe('above');
    const last = placeInspector({ left: 0, top: 0, right: 1280, bottom: 800 }, size, vp);
    expect(last.left).toBeGreaterThanOrEqual(8);
    expect(last.top + size.h).toBeLessThanOrEqual(800 - 8);
  });
  it('clamps the vertical position near the bottom', () => {
    const p = placeInspector({ left: 100, top: 700, right: 200, bottom: 760 }, size, vp);
    expect(p.top + size.h).toBeLessThanOrEqual(800 - 8);
  });
});

describe('LetteringInspector', () => {
  it('Easy shows 8 presets and 6 shapes and hides the Pro tabs', () => {
    inspector(['pg_1_l4']);
    const panel = screen.getByTestId('lettering-inspector');
    expect(within(panel).getByRole('radiogroup', { name: 'Lettering style' }).querySelectorAll('[role="radio"]')).toHaveLength(8);
    expect(within(panel).getByRole('radiogroup', { name: 'Balloon type' }).querySelectorAll('[role="radio"]')).toHaveLength(6);
    expect(within(panel).queryByRole('tablist')).toBeNull();
  });

  it('Easy: transparent bubbles, opacity steps and preset switching are one free op each', () => {
    const { apply } = inspector(['pg_1_l4']);
    fireEvent.click(screen.getByRole('radio', { name: 'See-through' }));
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { fill: '#ffffff99' } }], { label: 'Bubble opacity' });
    fireEvent.click(screen.getByRole('radio', { name: 'Clear' }));
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { fill: 'none' } }], { label: 'See-through bubble' });
    fireEvent.click(screen.getByRole('radio', { name: 'Kids storybook' }));
    expect(apply).toHaveBeenLastCalledWith([{ op: 'letter_style', patch: { presetId: 'storybook', keepOverrides: false, auto: null } }], { label: 'Change lettering style' });
  });

  it('multi-select colour → ONE line_style with both ids', () => {
    const { apply } = inspector(['pg_1_l2', 'pg_1_l4']);
    expect(screen.getByText('2 balloons')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Text colour: #e63946' }));
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l2', 'pg_1_l4'], patch: { textColor: '#e63946' } }], { label: 'Text colour' });
  });

  it('Pro “Apply to all speech in the comic” writes letter_style.kinds.speech', () => {
    const doc = makeSampleDoc((d) => (d.pages[0].panels[2].lines[1].style = { fill: '#ffd84a', font: 'andika' }));
    const { apply } = inspector(['pg_1_l4'], { mode: 'pro' }, doc);
    fireEvent.click(screen.getByRole('tab', { name: 'Apply' }));
    fireEvent.click(screen.getByRole('radio', { name: 'All speech in the comic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const [ops] = apply.mock.calls.at(-1)!;
    expect(ops[0]).toEqual({ op: 'letter_style', patch: { kinds: { speech: { fill: '#ffd84a', font: 'andika' } } } });
  });

  it('Pro bubble tab: shape, fill opacity, border style, padding', () => {
    const { apply } = inspector(['pg_1_l4'], { mode: 'pro' });
    fireEvent.click(screen.getByRole('tab', { name: 'Bubble' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Explosion' }));
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { shape: 'explosion' } }], { label: 'Bubble shape' });
    fireEvent.change(screen.getAllByLabelText('Opacity')[0], { target: { value: '40' } });
    const [ops, opts] = apply.mock.calls.at(-1)!;
    expect(ops[0].patch).toEqual({ fill: '#ffffff66' });
    expect(opts.coalesce).toMatch(/^style:pg_1:pg_1_l4:fill/);
    fireEvent.click(screen.getByRole('radio', { name: 'Double' }));
    expect(apply.mock.calls.at(-1)![0][0].patch).toEqual({ borderStyle: 'double' });
  });

  it('Pro text tab disables italics and letter-spacing for complex scripts, with a reason', () => {
    const doc = makeSampleDoc((d) => (d.format.language = 'te'));
    inspector(['pg_1_l4'], { mode: 'pro' }, doc);
    expect(screen.getByRole('switch', { name: 'Italic' })).toBeDisabled();
    expect(screen.getByLabelText('Letter spacing')).toBeDisabled();
    expect(screen.getByText(/Spacing would break this script/)).toBeInTheDocument();
  });

  it('honest warnings with free fixes: outside the safe area', () => {
    const doc = makeSampleDoc((d) => (d.pages[0].balloons[0] = { lineId: 'pg_1_l1', x: 0.7904, y: 0.04, w: 0.2096, pinned: true }));
    const { apply } = inspector(['pg_1_l1'], {}, doc);
    fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
    expect(apply.mock.calls.at(-1)![0][0]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l1' });
  });

  it('crowded panel: free fixes — shorten, keep it here (pins the drawn balloon), or move it to another panel', () => {
    const doc = makeSampleDoc();
    const base = resolvePlacements(doc, doc.pages[0], ASPECT, estimateMeasure);
    const id = [...base.fallback][0];
    expect(id).toBeTruthy();
    const onEditText = vi.fn();
    const { apply } = inspector([id], { placements: { ...base, crowded: new Set([id]) }, onEditText }, doc);
    expect(screen.getByText(/Crowded panel/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Shorten' }));
    expect(onEditText).toHaveBeenCalledWith(id);
    fireEvent.click(screen.getByRole('button', { name: 'Keep here' }));
    const [ops, opts] = apply.mock.calls.at(-1)!;
    expect(opts).toEqual({ label: 'Keep balloon here' });
    // A software-placed balloon: the FULL drawn balloon is stored, pinned (no jump to a default width).
    expect(ops[0]).toMatchObject({ op: 'balloon', lineId: id, patch: { ...(({ lineId: _l, ...rest }) => rest)(base.balloons.get(id)!), pinned: true } });
    expect(screen.getByRole('button', { name: /^Move to panel \d+$/ })).toBeInTheDocument();
  });

  it('overflow "Widen" never narrows the balloon', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const plans = planLettering(doc, page, ASPECT, estimateMeasure).map((p) => (p.lineId === 'pg_1_l4' ? { ...p, overflow: true } : p));
    const { apply } = inspector(['pg_1_l4'], { plans }, doc);
    fireEvent.click(screen.getByRole('button', { name: 'Widen' }));
    const patch = apply.mock.calls.at(-1)![0][0].patch as { w: number };
    expect(patch.w).toBeGreaterThan(plans.find((p) => p.lineId === 'pg_1_l4')!.w / 1000);
  });

  it('caps.proEditor false hides the Pro view (Easy keeps every capability)', () => {
    inspector(['pg_1_l4'], { mode: 'pro', canPro: false });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Pro' })).toBeNull();
    expect(screen.getByTestId('easy-lettering')).toBeInTheDocument();
  });

  it('is a bottom sheet on narrow screens', () => {
    inspector(['pg_1_l4'], { compact: true });
    expect(screen.getByTestId('lettering-inspector').dataset.presentation).toBe('sheet');
  });
});

describe('selection and snapping', () => {
  it('Shift-click toggles; a plain click replaces', () => {
    expect(nextSelection(['a'], 'b', true)).toEqual(['b', 'a']);
    expect(nextSelection(['b', 'a'], 'b', true)).toEqual(['a']);
    expect(nextSelection(['b', 'a'], 'c')).toEqual(['c']);
    expect(nextSelection(['a'], null)).toEqual([]);
  });

  it('mirrors the selection to the studio (chat focus) and clears it on unmount', () => {
    const setStudioSelection = vi.fn();
    const { result, unmount } = renderHook(() => useLetteringSelection({ pageId: 'pg_1', setStudioSelection, panelOf: () => 3 }));
    act(() => result.current.select('l1'));
    expect(setStudioSelection).toHaveBeenLastCalledWith({ pageId: 'pg_1', lineIds: ['l1'], surface: 'page_editor', panelN: 3 });
    act(() => {
      result.current.cycle(['l1', 'l2', 'l3'], 1);
    });
    expect(result.current.ids).toEqual(['l2']);
    unmount();
    expect(setStudioSelection).toHaveBeenLastCalledWith(null);
  });

  it('snaps an outline edge or centre to the nearest guide within the threshold', () => {
    const targets = snapTargets({ panels: [{ x: 0.02, y: 0.02, w: 0.5, h: 0.4 }], others: [{ x: 0.6, y: 0.1, w: 0.2, h: 0.1 }], safe: { x: 0.03, y: 0.02, w: 0.94, h: 0.96 } });
    const s = computeSnap({ x: 0.596, y: 0.3, w: 0.2, h: 0.1 }, targets, { x: 0.01, y: 0.01 });
    expect(s.dx).toBeCloseTo(0.004, 6);
    expect(s.guides).toContainEqual({ axis: 'x', at: 0.6 });
    expect(computeSnap({ x: 0.3, y: 0.7, w: 0.05, h: 0.05 }, { x: [0.9], y: [0.1] }, { x: 0.01, y: 0.01 })).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

describe('previews and the cover title', () => {
  it('the preset gallery draws every preset with the real engine (free, exact)', () => {
    const onChange = vi.fn();
    const { container } = render(<PresetGallery value="classic" onChange={onChange} />);
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(8);
    expect(container.querySelectorAll('svg [data-testid="balloon"]').length).toBeGreaterThanOrEqual(8);
    fireEvent.click(screen.getByRole('radio', { name: /Noir/ }));
    expect(onChange).toHaveBeenCalledWith('noir');
  });

  it('shape and tail pickers offer the whole vector library', () => {
    render(
      <>
        <ShapePicker value="squircle" onChange={vi.fn()} />
        <TailPicker value="auto" onChange={vi.fn()} />
      </>
    );
    expect(screen.getByRole('radiogroup', { name: 'Bubble shape' }).querySelectorAll('[role="radio"]')).toHaveLength(BUBBLE_SHAPES.length);
    expect(screen.getByRole('radiogroup', { name: 'Tail style' }).querySelectorAll('[role="radio"]')).toHaveLength(TAIL_STYLES.length);
  });

  it('LetteringSvg renders nothing for no plans and marks selections', () => {
    const doc = makeSampleDoc();
    const plans = planLettering(doc, doc.pages[0], ASPECT, estimateMeasure);
    const { container, rerender } = render(<LetteringSvg plans={[]} aspect={ASPECT} />);
    expect(container.innerHTML).toBe('');
    rerender(<LetteringSvg plans={plans} aspect={ASPECT} selectedLineIds={new Set(['pg_1_l4'])} />);
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 1000 1500');
    expect(container.querySelectorAll('[data-selection]')).toHaveLength(1);
  });

  it('overlay covers letter the (localized) title and tagline; painted covers render nothing', () => {
    const painted = makeSampleDoc();
    const { container, rerender } = render(<CoverTitleLayer doc={painted} aspect={ASPECT} />);
    expect(container.innerHTML).toBe('');
    const overlay = makeSampleDoc((d) => {
      d.cover = { ...d.cover, lettering: 'overlay', title: 'The Saffron Thief', tagline: 'One tin too many' };
    });
    rerender(<CoverTitleLayer doc={overlay} aspect={ASPECT} />);
    const svg = screen.getByTestId('cover-title');
    expect(svg).toHaveAttribute('aria-label', 'THE SAFFRON THIEF — One tin too many');
    const plan = planCoverTitle(overlay, ASPECT, estimateMeasure);
    expect(plan.title!.lines.join(' ')).toBe('THE SAFFRON THIEF');
    // The title block stays inside its box.
    expect(plan.title!.ys[plan.title!.ys.length - 1]).toBeLessThan((0.04 + 0.2) * H + 1);
    expect(plan.tagline!.fontSize).toBeLessThan(plan.title!.fontSize);
  });

  it('a Telugu overlay cover loads the Telugu script face it is drawn in (not only the Latin title face)', () => {
    vi.stubGlobal('FontFace', class {});
    Object.defineProperty(document, 'fonts', { value: { load: vi.fn(async () => []), check: () => true, forEach: () => undefined, add: vi.fn(), addEventListener: vi.fn() }, configurable: true });
    try {
      const te = makeSampleDoc((d) => {
        d.format = { ...d.format, language: 'te' };
        d.cover = { ...d.cover, lettering: 'overlay', title: 'కుంకుమపువ్వు దొంగ' };
      });
      render(<CoverTitleLayer doc={te} aspect={ASPECT} />);
      const plan = planCoverTitle(te, ASPECT, estimateMeasure);
      expect(plan.title!.style.font).toBe('noto-sans-telugu');
      const hrefs = [...document.head.querySelectorAll<HTMLLinkElement>('link[data-ds-lettering-fonts]')].map((l) => l.href);
      expect(hrefs.some((h) => h.includes('Noto+Sans+Telugu'))).toBe(true);
    } finally {
      document.head.querySelectorAll('link[data-ds-lettering-fonts]').forEach((l) => l.remove());
      delete (document as unknown as { fonts?: unknown }).fonts;
      vi.unstubAllGlobals();
    }
  });
});
