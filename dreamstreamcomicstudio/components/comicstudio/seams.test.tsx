// Client seams (contract §13.2–§13.3), as wired after wave 1 (P2-AMEND rewrote the wave-0 "inert stub"
// assertions): the real feature registries, and every cross-package component rendering its real UI
// with the props the wave-0 seams fixed — honest empty states, no fetch beyond the documented one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
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
import { __resetComicLibraryForTests, useComicLibrary } from './library/useComicLibrary';
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

afterEach(() => {
  vi.unstubAllGlobals();
  __resetComicLibraryForTests();
});

describe('feature registries (real wave-1 modules)', () => {
  it('fold the fourteen feature modules (eleven wave-1/2 modules + the W-M models, insights and reliability modules) into cards, tabs, header slots and admin sections', () => {
    expect(featureModules()).toHaveLength(14);
    // Feature order = precedence: breakdown, lettering, timeline, refs, share, safety, i18n, immersive, library, mobile, usage.
    // model_outage: M1-RELIABILITY's outage card (the W-M modules come last, lowest precedence).
    expect(registeredCardTypes()).toEqual(['breakdown', 'versions', 'refs', 'publish', 'share', 'translation', 'style_presets', 'model_outage']);
    expect(registeredTabs().map((t) => [t.id, t.order])).toEqual([['media', 500], ['languages', 800]]);
    // share 10 → mode 60 → savings 210 → usage 220 (P1-LIMITS' meter, registered by P2-AMEND).
    // … → model-status 1000 (M1-RELIABILITY's one-line banner sits after every header control).
    expect(registeredHeaderSlots().map((h) => [h.id, h.order])).toEqual([['share', 10], ['mode', 60], ['savings', 210], ['usage', 220], ['model-status', 1000], ['model-picker', 1010]]);
    expect(registeredAdminSections().map((a) => a.id)).toEqual(['comic-safety', 'library', 'model-lab', 'provider-status']);
    for (const reg of [...registeredTabs(), ...registeredHeaderSlots(), ...registeredAdminSections()]) expect(typeof reg.Component).toBe('function');
  });
});

describe('cross-package components render their real UI', () => {
  it('versions, timeline, rating, share, refs drawer and breakdown show honest content for the sample comic', () => {
    const studio = makeFakeStudio();
    const card = { type: 'breakdown', id: 'b1' } as Extract<Card, { type: 'breakdown' }>;
    render(
      <>
        <VersionStack studio={studio} target={{ kind: 'cover' }} />
        <BookTimeline studio={studio} compact reorderActivation="longpress" />
        <RatingBadge rating="PG" />
        <ShareButton studio={studio} compact />
        <RefsDrawer studio={studio} owner={{ kind: 'style' }} open onClose={vi.fn()} />
        <BreakdownCard card={card} message={{ id: 'm', role: 'assistant', text: '', at: 1 }} studio={studio} compact />
      </>
    );
    // An undrawn cover has nothing to pick from — and says so.
    expect(screen.getByText(/Cover isn.t drawn yet/)).toBeInTheDocument();
    // The timeline lists the cover, every page and the free "Add page" clip.
    const timeline = screen.getByRole('listbox', { name: 'Book timeline' });
    expect(within(timeline).getByRole('option', { name: /^Cover/ })).toBeInTheDocument();
    expect(within(timeline).getByRole('option', { name: /^Page 1/ })).toBeInTheDocument();
    expect(within(timeline).getByRole('option', { name: /Add page/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Rated PG' })).toBeInTheDocument();
    // Compact share button: a 44 px icon button that names the current visibility.
    const share = screen.getByRole('button', { name: /^Share/ });
    expect(share).toHaveAttribute('aria-haspopup', 'dialog');
    expect(share.className).toMatch(/\bw-11\b/);
    // The refs drawer opens with its honest empty state and the privacy line.
    expect(screen.getByRole('dialog', { name: 'Your style references' })).toBeInTheDocument();
    expect(screen.getByText(/Your photos stay private to you/)).toBeInTheDocument();
    // The breakdown card prices what is left to draw before anything is drawn.
    const breakdown = screen.getByRole('region', { name: 'Page breakdown' });
    expect(within(breakdown).getByText(/Nothing is drawn until you approve/)).toBeInTheDocument();
  });

  it('render nothing when there is nothing to show (no plans, painted cover title, one language)', () => {
    const doc = makeSampleDoc();
    const { container } = render(
      <>
        <LetteringSvg plans={[]} aspect={2 / 3} ariaHidden />
        <CoverTitleLayer doc={doc} aspect={2 / 3} />
        <ReaderLanguagePicker current="en" options={[{ code: 'en', label: 'English' }]} onChange={vi.fn()} />
      </>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ImmersiveReader portals a full-screen reader into document.body', () => {
    const studio = makeFakeStudio();
    const doc = makeSampleDoc();
    const onExit = vi.fn();
    const { container, unmount } = render(<ImmersiveReader doc={doc} urlFor={studio.urlFor} intro={false} onExit={onExit} />);
    expect(container).toBeEmptyDOMElement();
    const reader = screen.getByRole('dialog', { name: /^Reading / });
    expect(container.contains(reader)).toBe(false);
    expect(document.body.contains(reader)).toBe(true);
    expect(onExit).not.toHaveBeenCalled();
    unmount();
    expect(screen.queryByRole('dialog', { name: /^Reading / })).toBeNull();
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

  it('LibraryImage keeps its procedural fallback; a failed library fetch is "unavailable" (one fetch, no cookies)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<LibraryImage id="style.noir-ink" fallback={<span>procedural</span>} />);
    expect(screen.getByText('procedural')).toBeInTheDocument();
    const { result } = renderHook(() => useComicLibrary());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.byKind('style_preview')).toEqual([]);
    expect(result.current.preview('noir-ink')).toBeUndefined();
    expect(screen.getByText('procedural')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]).toEqual([expect.stringContaining('/api/comic/public/library'), expect.objectContaining({ credentials: 'omit' })]);
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

  it('AdaptiveSheet presents a labelled dialog; TouchCanvas is a zoomable canvas at rest (scale 1)', () => {
    render(
      <AdaptiveSheet open onClose={vi.fn()} label="Inspector" presentation="bottom" detents={['half']} title="Lettering">
        <p>sheet body</p>
      </AdaptiveSheet>
    );
    expect(screen.getByRole('dialog', { name: 'Inspector' })).toHaveTextContent('sheet body');

    const Probe = () => <span>scale {useContext(ZoomContext).scale}</span>;
    render(
      <TouchCanvas maxScale={4} oneFingerPan="whenZoomed">
        <Probe />
      </TouchCanvas>
    );
    const canvas = screen.getByRole('group', { name: 'Zoomable page' });
    expect(canvas).toHaveAttribute('data-zoom', '1.00');
    expect(canvas).toHaveAttribute('tabindex', '0');
    expect(within(canvas).getByText('scale 1')).toBeInTheDocument();
  });
});

describe('form factor classifier', () => {
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

describe('script fonts', () => {
  it('ensureFontsFor resolves (jsdom has no FontFaceSet: nothing to wait for); families come from the registry', async () => {
    await expect(ensureFontsFor(['te'], ['dialogue'], 'నమస్తే')).resolves.toEqual({ degraded: false });
    expect(cssFontFamily('te', 'dialogue')).toContain('"Noto Sans Telugu"');
    expect(cssFontFamily('xx-unknown', 'sfx')).toContain('"DSL Comic Neue"');
  });
});
