// The Layers eye (PE-INSPECT wave note 3, wired at the S2b integration): a balloon hidden in this view is neither drawn
// nor hit-tested in the EDITOR, and nothing else changes — a reader's layer (not editable) draws everything even if a
// set is passed, and no op is ever sent.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BalloonLayer } from './BalloonLayer';
import { makeSampleDoc } from './__fixtures__/sampleDoc';

afterEach(cleanup);

const W = 600;
const HPX = 900;

const mount = (editable: boolean, viewHidden?: ReadonlySet<string>) => {
  const doc = makeSampleDoc();
  const page = doc.pages[0];
  const onOps = vi.fn();
  const onBalloonChange = vi.fn();
  const utils = render(
    <div style={{ position: 'relative', width: W, height: HPX }}>
      <BalloonLayer doc={doc} page={page} pageWidth={W} pageHeight={HPX} editable={editable} onOps={onOps} onBalloonChange={onBalloonChange} viewHidden={viewHidden} />
    </div>
  );
  const drawn = (id: string) => utils.container.querySelector(`svg [data-line-id="${id}"]`);
  const hit = (id: string) => utils.container.querySelector(`[data-testid="balloon-hit"][data-line-id="${id}"]`);
  const ids = page.panels.flatMap((p) => p.lines.map((l) => l.id)).filter((id) => drawn(id));
  return { ...utils, drawn, hit, ids, onOps, onBalloonChange };
};

describe('BalloonLayer viewHidden (the Layers eye)', () => {
  it('editor: a hidden balloon is neither drawn nor hit-tested; the others are untouched; no op is sent', () => {
    const all = mount(true);
    expect(all.ids.length).toBeGreaterThan(2);
    const [gone, ...kept] = all.ids;
    expect(all.hit(gone)).not.toBeNull();
    cleanup();
    const view = mount(true, new Set([gone]));
    expect(view.drawn(gone)).toBeNull();
    expect(view.hit(gone)).toBeNull();
    for (const id of kept) {
      expect(view.drawn(id), id).not.toBeNull();
      expect(view.hit(id), id).not.toBeNull();
    }
    expect(view.onOps).not.toHaveBeenCalled();
    expect(view.onBalloonChange).not.toHaveBeenCalled();
  });

  it('an empty set changes nothing', () => {
    const all = mount(true);
    const n = all.ids.length;
    cleanup();
    const view = mount(true, new Set());
    expect(view.ids).toHaveLength(n);
  });

  it('reader (not editable): the set is ignored, every balloon is drawn', () => {
    const all = mount(false);
    const [first] = all.ids;
    const n = all.ids.length;
    cleanup();
    const reader = mount(false, new Set([first]));
    expect(reader.drawn(first)).not.toBeNull();
    expect(reader.ids).toHaveLength(n);
  });
});
