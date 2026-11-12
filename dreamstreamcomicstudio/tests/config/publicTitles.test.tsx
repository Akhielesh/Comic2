/**
 * Bridge D2 (docs/design/atlas-skin.md "Wave 9 (bridge)"): the display face is opt-in. The blanket
 * `[data-ds-skin] :is(h1…h4)` rule is gone, so a public title keeps Space Grotesk only when it asks for it
 * with FONT_DISPLAY (`.ds-font-display`), as Atlas's own public hero and section titles carry
 * `atlas-display`. These are the public titles that relied on the blanket rule: the comics landing's hero
 * and section titles and the public reader cover's title.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FONT_DISPLAY, OVERLINE_DISPLAY } from '../../components/chat/studioDesign';
import { ComicsLanding } from '../../components/comicshost/ComicsLanding';
import { ReaderCoverCard } from '../../components/comicstudio/reader/ReaderCoverCard';

afterEach(cleanup);

const classesOf = (el: Element) => el.className.split(/\s+/).filter(Boolean);

describe('public titles keep the display face under D2', () => {
  it('the comics landing: the hero h1 and the three section h2s ask for FONT_DISPLAY; the looks band title is the display eyebrow', () => {
    render(
      <ComicsLanding
        signedIn={false}
        onSignIn={vi.fn()}
        onRequestAccess={vi.fn()}
        onOpenComics={vi.fn()}
        onBrowseGallery={vi.fn()}
        onOpenPrivacy={vi.fn()}
        onOpenTerms={vi.fn()}
      />
    );
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(classesOf(h1)).toContain(FONT_DISPLAY);
    const sections = screen.getAllByRole('heading', { level: 2 }).filter((h) => /^comics-(how|read|access)$/.test(h.id));
    expect(sections.map((h) => h.id).sort()).toEqual(['comics-access', 'comics-how', 'comics-read']);
    for (const h of sections) expect(classesOf(h), h.id).toContain(FONT_DISPLAY);
    expect(classesOf(screen.getByRole('heading', { level: 2, name: 'One scene, six looks' }))).toContain(OVERLINE_DISPLAY);
  });

  it('the public reader cover: its title h1 asks for FONT_DISPLAY', () => {
    render(<ReaderCoverCard title="The Lantern Keeper" onRead={vi.fn()} />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'The Lantern Keeper' });
    expect(classesOf(h1)).toContain(FONT_DISPLAY);
  });

  it('FONT_DISPLAY is the skin class, never Tailwind `font-display` (Bangers, lettering content)', () => {
    expect(FONT_DISPLAY).toBe('ds-font-display');
  });
});
