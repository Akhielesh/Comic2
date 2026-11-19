// Every place a look is chosen paints it through LookArt (stylepick SC-1): the Style tab (Choose a look, and the
// Current style strip), the director's "Styles that fit" card, the composer Style panel and a question's preset
// option. A Paper Boat look shows its bundled art in the first render, a look without art keeps the interim drawn
// thumbnail, and no surface asks the backend for the library index while it shows looks.
import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets';
import { StyleTab } from '../board/StyleTab';
import { makeSampleDoc as makeBoardDoc, makeStudio } from '../board/__fixtures__/sampleDoc';
import { OptionVisualArt } from '../conversation/cards/OptionsCard';
import { StylePanel } from '../conversation/panels/StylePanel';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { StylePresetsCard } from './StylePresetsCard';
import { __resetComicLibraryForTests } from './useComicLibrary';
import { SAMPLE_LOOKS } from './sampleArt';

let fetchSpy: ReturnType<typeof vi.fn>;
const libraryCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/comic/public/library'));
const bundled = (root: ParentNode, look: string) => root.querySelector(`img[src="/assets/comic-sample/${look}-thumb.webp"]`);

beforeEach(() => {
  __resetComicLibraryForTests();
  fetchSpy = vi.fn(async () => new Response('x', { status: 503 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetComicLibraryForTests();
});

describe('style surfaces paint looks through LookArt', () => {
  it('"Styles that fit": bundled art in the first render, the interim thumb for a look without art, no index fetch', () => {
    const doc = makeSampleDoc();
    doc.style = { status: 'empty', refs: [], options: [] };
    const { container } = render(
      <StylePresetsCard
        card={{ type: 'style_presets', id: 'c1', presetIds: ['noir-ink', 'cartoon-strip'] }}
        message={{ id: 'm', role: 'assistant', text: '', at: 0 }}
        studio={makeFakeStudio({ doc })}
      />
    );
    expect(bundled(container, 'noir-ink')).not.toBeNull();
    expect(container.querySelector('[data-preset-thumb="cartoon-strip"]')).not.toBeNull();
    expect(container.querySelector('[data-preset-thumb="noir-ink"]')).toBeNull();
    expect(libraryCalls()).toEqual([]);
  });

  it('composer Style panel: each Paper Boat look shows its own art at once; every tile has a picture', () => {
    const { container } = render(<StylePanel doc={makeSampleDoc()} patch={vi.fn()} act={vi.fn()} onDescribeOwn={vi.fn()} onDone={vi.fn()} />);
    for (const look of SAMPLE_LOOKS) expect(bundled(container, look), look).not.toBeNull();
    const tiles = container.querySelectorAll('[data-preset-art]');
    expect(tiles).toHaveLength(STYLE_PRESETS.length);
    for (const tile of tiles) expect(tile.querySelector('[data-look-art]')).not.toBeNull();
    expect(container.querySelectorAll('[data-preset-thumb]')).toHaveLength(STYLE_PRESETS.length - SAMPLE_LOOKS.length);
    expect(libraryCalls()).toEqual([]);
  });

  it('Style tab, Choose a look: the preset grid paints bundled art at once', () => {
    const studio = makeStudio(makeBoardDoc((d) => (d.style = { status: 'empty', refs: [], options: [] })));
    const { container } = render(<StyleTab studio={studio} doc={studio.doc!} />);
    for (const look of SAMPLE_LOOKS) expect(bundled(container, look), look).not.toBeNull();
    expect(libraryCalls()).toEqual([]);
  });

  it('Style tab, Current style: a preset look without a board shows its art strip', () => {
    const studio = makeStudio(
      makeBoardDoc((d) => {
        d.style = { ...d.style, status: 'drafted', presetId: 'watercolor-storybook', board: undefined };
      })
    );
    const { container } = render(<StyleTab studio={studio} doc={studio.doc!} />);
    expect(bundled(container, 'watercolor-storybook')).not.toBeNull();
  });

  it('a question option with a preset picture paints the same art', () => {
    const doc = makeSampleDoc();
    const art = render(<OptionVisualArt visual={{ kind: 'preset', presetId: 'retro-pop' }} doc={doc} urlFor={() => undefined} />);
    expect(bundled(art.container, 'retro-pop')).not.toBeNull();
    art.unmount();
    const interim = render(<OptionVisualArt visual={{ kind: 'preset', presetId: 'cozy-anime' }} doc={doc} urlFor={() => undefined} />);
    expect(interim.container.querySelector('[data-preset-thumb="cozy-anime"]')).not.toBeNull();
    expect(libraryCalls()).toEqual([]);
  });
});
