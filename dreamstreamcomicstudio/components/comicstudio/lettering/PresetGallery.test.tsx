// The lettering style gallery (declutter DX-0): each style is a picture drawn by the real lettering engine (a caption,
// a speech balloon and a shout), named on the tile, its description in the hover hint and the radio's accessible
// description. The states that showed the wrong thing are honest: an unknown id and a style the Director chose are
// shown first and chosen; a translated edition offers the styles but leaves them to the original language.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { LETTERING_PRESETS, LETTERING_PRESET_IDS, type LetteringPresetId } from '../../../shared/comic/lettering/style';
import { estimateMeasure, planLettering } from '../../../shared/comic/lettering/layout';
import { proLooks } from '../editor/inspector/proSwitch';
import { CUSTOM_STYLE_NAME, DIRECTOR_STYLE_HINT, PRESET_PREVIEW_ASPECT, PresetGallery, previewDoc } from './PresetGallery';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const group = () => screen.getByRole('radiogroup', { name: 'Lettering style' });

describe('PresetGallery (grid)', () => {
  it('eight tiles named by the style; the blurb is the radio’s description, never visible text', () => {
    render(<PresetGallery value="classic" onChange={vi.fn()} />);
    const radios = within(group()).getAllByRole('radio');
    expect(radios).toHaveLength(8);
    for (const id of LETTERING_PRESET_IDS) {
      const p = LETTERING_PRESETS[id];
      const tile = within(group()).getByRole('radio', { name: p.name });
      expect(tile).toHaveAccessibleDescription(p.blurb);
      expect(tile).toHaveAttribute('title', p.blurb);
      // Not printed on the tile: the only visible words are the name.
      expect(screen.queryByText(p.blurb, { ignore: '[hidden], [hidden] *' })).toBeNull();
    }
    expect(within(group()).getByRole('radio', { name: /Noir/ })).toBeTruthy();
    expect(within(group()).getByRole('radio', { name: 'Classic comic' })).toHaveAttribute('aria-checked', 'true');
  });

  it('each tile letters a caption, a speech balloon and a shout with the real engine', () => {
    render(<PresetGallery value="classic" onChange={vi.fn()} />);
    for (const tile of within(group()).getAllByRole('radio')) {
      const balloons = tile.querySelectorAll('svg [data-testid="balloon"]');
      expect(balloons).toHaveLength(3);
      expect([...balloons].map((b) => b.getAttribute('data-kind')).sort()).toEqual(['caption', 'shout', 'speech']);
      // The drawing fills the art box (scaled to fit, never a fixed 40 px strip).
      const svg = tile.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe('100%');
      expect(svg.getAttribute('height')).toBe('100%');
      expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    }
    expect(screen.getAllByText('Meanwhile…', { exact: false }).length).toBeGreaterThan(0);
  });

  it('a right-to-left language mirrors the sample: the caption moves to the right', () => {
    const centre = (lang: string) => {
      const { doc, page } = previewDoc('classic', { lang });
      const plans = planLettering(doc, page, PRESET_PREVIEW_ASPECT, estimateMeasure);
      const of = (kind: string) => plans.find((p) => p.kind === kind)!;
      return { caption: of('caption').x + of('caption').w / 2, speech: of('speech').x + of('speech').w / 2 };
    };
    const ltr = centre('en');
    const rtl = centre('ar');
    expect(ltr.caption).toBeLessThan(500);
    expect(rtl.caption).toBeGreaterThan(500);
    expect(Math.abs(rtl.caption - (1000 - ltr.caption))).toBeLessThan(40);
    const caption = previewDoc('classic', { lang: 'ar' }).page.balloons.find((b) => b.lineId === 'pv_caption')!;
    expect(caption.x).toBeGreaterThan(0.5);
  });

  it('an unknown (newer) style id is the first tile, named “Custom style”, and chosen', () => {
    render(<PresetGallery value={'gothic_v9' as LetteringPresetId} onChange={vi.fn()} />);
    const radios = within(group()).getAllByRole('radio');
    expect(radios).toHaveLength(9);
    expect(radios[0]).toHaveAccessibleName(CUSTOM_STYLE_NAME);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0].querySelectorAll('svg [data-testid="balloon"]')).toHaveLength(3);
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    // Never the raw id.
    expect(screen.queryByText('gothic_v9')).toBeNull();
  });

  it('a Pro style the Director set (people cannot pick Pro styles yet) is the first tile, named and chosen', () => {
    const look = proLooks()[0];
    expect(look).toBeTruthy();
    render(<PresetGallery value={look.id as LetteringPresetId} onChange={vi.fn()} />);
    const radios = within(group()).getAllByRole('radio');
    expect(radios).toHaveLength(9);
    expect(radios[0]).toHaveAccessibleName(look.name);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0].getAttribute('title')!.startsWith('Chosen by the Director')).toBe(true);
    expect(radios[0]).toHaveAccessibleDescription(DIRECTOR_STYLE_HINT);
    // The Pro offer list (pro) does not duplicate it: a gallery that asks for Pro looks while they are not writable
    // still shows 8 + the chosen one.
    expect(within(group()).getAllByRole('radio', { name: look.name })).toHaveLength(1);
  });

  it('disabled: every tile is disabled and a tap changes nothing', () => {
    const onChange = vi.fn();
    render(<PresetGallery value="classic" onChange={onChange} disabled />);
    const radios = within(group()).getAllByRole('radio');
    expect(radios.every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(within(group()).getByRole('radio', { name: 'Manga' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('columns follow the container: 2 below 400 px, 3 below 640 px, else 4', () => {
    let width = 360;
    let fire: (() => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 600, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, toJSON: () => ({}) }) as DOMRect);
    render(<PresetGallery value="classic" onChange={vi.fn()} />);
    expect(group().style.getPropertyValue('--cols')).toBe('2');
    width = 560;
    act(() => fire?.());
    expect(group().style.getPropertyValue('--cols')).toBe('3');
    width = 800;
    act(() => fire?.());
    expect(group().style.getPropertyValue('--cols')).toBe('4');
  });

  it('arrow keys move through the styles and choose (one radiogroup)', () => {
    const onChange = vi.fn();
    render(<PresetGallery value="classic" onChange={onChange} />);
    const classic = within(group()).getByRole('radio', { name: 'Classic comic' });
    expect(classic).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(classic, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(LETTERING_PRESET_IDS[1]);
    fireEvent.click(within(group()).getByRole('radio', { name: /Noir/ }));
    expect(onChange).toHaveBeenLastCalledWith('noir');
  });
});

describe('PresetGallery (chips)', () => {
  it('a bigger drawing (56 px) and a 12 px name that is never cut', () => {
    render(<PresetGallery variant="chips" value="classic" onChange={vi.fn()} />);
    const radios = within(group()).getAllByRole('radio');
    expect(radios).toHaveLength(8);
    for (const r of radios) {
      expect(r.querySelector('svg')!.getAttribute('height')).toBe('56');
      const name = r.querySelector('[data-slot="preset-chip-name"]')!;
      expect(name.className).toContain('text-[12px]');
      expect(name.className).not.toContain('truncate');
      expect(r.className).toContain('min-w-[6.5rem]');
    }
    expect(within(group()).getByRole('radio', { name: 'Indie handwritten' })).toHaveAccessibleDescription(LETTERING_PRESETS.handwritten.blurb);
  });

  it('disabled chips change nothing', () => {
    const onChange = vi.fn();
    render(<PresetGallery variant="chips" value="classic" onChange={onChange} disabled />);
    fireEvent.click(within(group()).getByRole('radio', { name: 'Manga' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
