// Wave-0 client seams (contract §13.3, build plan §10): every feature index registers nothing,
// and every cross-package stub has its final props with inert, safe behaviour.

import { describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { useContext } from 'react';
import { STYLE_PRESETS } from '../../shared/comic/stylePresets';
import type { AssetRef, Card } from '../../shared/comic/doc';
import { featureModules, registeredAdminSections, registeredCardTypes, registeredHeaderSlots, registeredTabs } from './features';
import { makeFakeStudio, makeSampleDoc } from './conversation/testing/fixtures';
import { AdaptiveSheet } from './mobile/sheets/AdaptiveSheet';
import { TouchCanvas, ZoomContext } from './mobile/touch/TouchCanvas';
import { classifyViewport, widthClassOf } from './mobile/formFactor';
import { useFormFactor } from './mobile/useFormFactor';
import { LayoutGlyph } from './library/procedural/LayoutGlyph';
import { PresetThumb } from './library/procedural/PresetThumb';
import { EmptyArt, type EmptyArtVariant } from './library/procedural/EmptyArt';
import { BubblePreview } from './library/procedural/BubblePreview';
import { LibraryImage } from './library/LibraryImage';
import { useComicLibrary } from './library/useComicLibrary';
import { VersionStack } from './timeline/VersionStack';
import { BookTimeline } from './timeline/BookTimeline';
import { LetteringSvg } from './lettering/LetteringSvg';
import { CoverTitleLayer } from './lettering/CoverTitleLayer';
import { SafetyVeil } from './safety/SafetyVeil';
import { RatingBadge } from './safety/RatingBadge';
import { ShareButton } from './share/ShareButton';
import { ReaderLanguagePicker } from './i18n/ReaderLanguagePicker';
import { cssFontFamily, ensureFontsFor } from './i18n/scriptFonts';
import { ImmersiveReader } from './immersive/ImmersiveReader';
import { RefsDrawer } from './refs/RefsDrawer';
import { BreakdownCard } from './breakdown/BreakdownCard';

describe('feature indexes (wave 0)', () => {
  it('are ten empty modules, so every registry is empty and the UI is unchanged', () => {
    expect(featureModules()).toHaveLength(10);
    for (const mod of featureModules()) expect(mod).toEqual({});
    expect(registeredCardTypes()).toEqual([]);
    expect(registeredTabs()).toEqual([]);
    expect(registeredHeaderSlots()).toEqual([]);
    expect(registeredAdminSections()).toEqual([]);
  });
});

describe('inert component stubs', () => {
  it('render nothing until their wave-1 owner lands', () => {
    const studio = makeFakeStudio();
    const doc = makeSampleDoc();
    const card = { type: 'breakdown', id: 'b1' } as Extract<Card, { type: 'breakdown' }>;
    const { container } = render(
      <>
        <VersionStack studio={studio} target={{ kind: 'cover' }} />
        <BookTimeline studio={studio} compact reorderActivation="longpress" />
        <LetteringSvg plans={[]} aspect={2 / 3} ariaHidden />
        <CoverTitleLayer doc={doc} aspect={2 / 3} />
        <RatingBadge rating="PG" />
        <ShareButton studio={studio} compact />
        <ReaderLanguagePicker current="en" options={[{ code: 'en', label: 'English' }]} onChange={vi.fn()} />
        <ImmersiveReader doc={doc} urlFor={studio.urlFor} intro={false} onExit={vi.fn()} />
        <RefsDrawer studio={studio} owner={{ kind: 'style' }} open onClose={vi.fn()} />
        <BreakdownCard card={card} message={{ id: 'm', role: 'assistant', text: '', at: 1 }} studio={studio} compact />
      </>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('SafetyVeil passes children through, but a blocked asset never becomes an <img>', () => {
    const ok: AssetRef = { path: 'u/x/p/a.webp', source: 'generated', at: 1, safety: { assessed: 'G', at: 1 } };
    const { container, rerender } = render(
      <SafetyVeil asset={ok} rating="G">
        <img src="https://cdn.test/a" alt="page 1" />
      </SafetyVeil>
    );
    expect(screen.getByAltText('page 1')).toBeInTheDocument();

    const blocked: AssetRef = { ...ok, safety: { assessed: 'X', at: 1 } };
    rerender(
      <SafetyVeil asset={blocked} rating="PG-13">
        <img src="https://cdn.test/a" alt="page 1" />
      </SafetyVeil>
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Image withheld' })).toBeInTheDocument();
  });

  it('LibraryImage shows its fallback; useComicLibrary is unavailable (no fetch)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<LibraryImage id="style.noir-ink" fallback={<span>procedural</span>} />);
    expect(screen.getByText('procedural')).toBeInTheDocument();
    const { result } = renderHook(() => useComicLibrary());
    expect(result.current.status).toBe('unavailable');
    expect(result.current.byKind('style_preview')).toEqual([]);
    expect(result.current.preview('noir-ink')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('procedural art renders plain SVG / swatches', () => {
    const page = makeSampleDoc().pages[0];
    const { container } = render(<LayoutGlyph page={page} aspect="2:3" />);
    expect(container.querySelectorAll('rect')).toHaveLength(1 + page.panels.length);

    const glyph = render(<LayoutGlyph panels={4} aspect="4:5" size={40} />);
    expect(glyph.container.querySelectorAll('rect')).toHaveLength(5);
    expect(glyph.container.querySelector('svg')).toHaveAttribute('height', '50');

    const thumb = render(<PresetThumb preset={STYLE_PRESETS[0]} />);
    expect((thumb.container.firstChild as HTMLElement).style.background).not.toBe('');

    for (const v of ['pages', 'cast', 'style', 'reader', 'studio', 'media'] as EmptyArtVariant[]) {
      const art = render(<EmptyArt variant={v} />);
      expect(art.container.querySelector('svg')).toHaveAttribute('aria-hidden');
    }

    const bubble = render(<BubblePreview style={{ shape: 'rect', fill: '#fff6c8' }} kind="caption" />);
    expect(bubble.container.querySelector('rect')).toHaveAttribute('fill', '#fff6c8');
  });

  it('AdaptiveSheet is today’s PopSheet; TouchCanvas is a passthrough with scale 1', () => {
    render(
      <AdaptiveSheet open onClose={vi.fn()} label="Inspector" presentation="bottom" detents={['half']} title="Lettering">
        <p>sheet body</p>
      </AdaptiveSheet>
    );
    expect(screen.getByRole('dialog', { name: 'Inspector' })).toHaveTextContent('sheet body');

    const Probe = () => <span>scale {useContext(ZoomContext).scale}</span>;
    const { container } = render(
      <TouchCanvas maxScale={4} oneFingerPan="whenZoomed">
        <Probe />
      </TouchCanvas>
    );
    expect(container.innerHTML).toBe('<span>scale 1</span>');
  });
});

describe('form factor (stub classifier)', () => {
  it('splits from 720 px; phones in landscape get the rail; two horizontal segments are dual-screen', () => {
    expect(classifyViewport({ w: 390, h: 844, coarse: true }).layout).toBe('single');
    expect(classifyViewport({ w: 719, h: 900, coarse: true }).layout).toBe('single');
    expect(classifyViewport({ w: 720, h: 900, coarse: true }).layout).toBe('split');
    expect(classifyViewport({ w: 744, h: 1133, coarse: true })).toEqual({ widthClass: 'medium', heightClass: 'regular', orientation: 'portrait', layout: 'split' });
    expect(classifyViewport({ w: 844, h: 390, coarse: true })).toMatchObject({ heightClass: 'compact', orientation: 'landscape', layout: 'single-rail' });
    expect(
      classifyViewport({ w: 1200, h: 900, coarse: true, segments: { count: 2, axis: 'horizontal', rects: [] } }).layout
    ).toBe('dual-screen');
    expect([599, 600, 839, 840, 1199, 1200].map(widthClassOf)).toEqual(['compact', 'medium', 'medium', 'expanded', 'expanded', 'large']);
  });

  it('useFormFactor reads the window', () => {
    const { result } = renderHook(() => useFormFactor());
    expect(result.current.width).toBe(window.innerWidth);
    expect(result.current.segments.count).toBe(1);
    expect(['single', 'single-rail', 'split']).toContain(result.current.layout);
  });
});

describe('script fonts (stub)', () => {
  it('ensureFontsFor resolves without loading anything; families come from the registry', async () => {
    await expect(ensureFontsFor(['te'], ['dialogue'], 'నమస్తే')).resolves.toEqual({ degraded: false });
    expect(cssFontFamily('te', 'dialogue')).toContain('"Noto Sans Telugu"');
    expect(cssFontFamily('xx-unknown', 'sfx')).toContain('"DSL Comic Neue"');
  });
});
