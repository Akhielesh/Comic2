// Q-SETTLE: a notice's fixes are alternatives for one problem. Once one is taken (tapped and running, a free fix in the
// comic, a paid one drawing), the other fixes for the same page are not offered any more; a fix for another page stays.
// Read from the live doc, so a reload agrees.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { emptyRender, type Card, type ComicDoc, type Page } from '../../../../shared/comic/doc';
import { applyOps, type DocOp } from '../../../../shared/comic/ops';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities';
import { makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';
import { NoticeCard, type NoticeCardStudio } from './NoticeCard';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

type Notice = Extract<Card, { type: 'notice' }>;

const page = (id: string, n: number): Page => ({
  id,
  n,
  summary: `Page ${n}.`,
  layout: 'Row 1: two equal panels.',
  panels: [1, 2].map((k) => ({
    id: `${id}_p${k}`,
    n: k,
    size: 'medium' as const,
    shot: 'medium' as const,
    action: `Beat ${k}.`,
    castIds: ['c_maya'],
    lines: k === 2 ? [{ id: `${id}_l`, kind: 'speech' as const, speakerId: 'c_maya', text: 'We wait until dark.' }] : []
  })),
  render: emptyRender(),
  balloons: []
});
const docWith = (): ComicDoc => ({ ...makeSampleDoc(), pages: [page('pg_2', 2), page('pg_3', 3)] });
const caption = (pageId: string): DocOp[] => [{ op: 'line', pageId, panelId: `${pageId}_p2`, id: `${pageId}_l`, patch: { kind: 'caption' } }];

/** A page check on page 2 (free caption fix, then two paid redraws), plus a free fix for page 3. */
const notice = (): Notice => ({
  type: 'notice',
  id: 'n_qc',
  tone: 'warn',
  text: 'Check panels on page 2: Maya may not be drawn in panel 2, but she speaks there.',
  fixes: [
    { label: "Make Maya's line in panel 2 a caption", free: true, action: { type: 'patch', ops: caption('pg_2') } },
    { label: 'Redraw panel 2 with Maya', free: false, action: { type: 'edit_page', pageId: 'pg_2', panelN: 2, instruction: 'Draw MAYA in panel 2.', quotedUsd: 0.0845 } },
    { label: 'Redraw page 2', free: false, action: { type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0.0845 } },
    { label: "Make page 3's line a caption", free: true, action: { type: 'patch', ops: caption('pg_3') } }
  ]
});

const studioFor = (doc: ComicDoc, over: Partial<NoticeCardStudio> = {}): NoticeCardStudio & { act: ReturnType<typeof vi.fn> } =>
  ({ act: vi.fn(async () => undefined), byok: false, caps: DEFAULT_CAPS, doc, ...over }) as NoticeCardStudio & { act: ReturnType<typeof vi.fn> };
const fixes = () => within(screen.getByRole('group', { name: 'Fixes' }));
const reload = (doc: ComicDoc): ComicDoc => JSON.parse(JSON.stringify(doc)) as ComicDoc;

describe('a notice’s fixes settle once one is taken', () => {
  it('control: every fix is offered while none is taken', () => {
    render(<NoticeCard card={notice()} studio={studioFor(docWith())} />);
    expect(fixes().getAllByRole('button')).toHaveLength(4);
  });

  it('a free fix in the comic retires the paid alternatives for its page; the other page’s fix stays; a reload agrees', () => {
    const fixed = applyOps(docWith(), caption('pg_2'));
    for (const doc of [fixed, reload(fixed)]) {
      const r = render(<NoticeCard card={notice()} studio={studioFor(doc)} />);
      expect(fixes().getByRole('button', { name: /Make Maya's line in panel 2 a caption, Done/ })).toBeDisabled();
      expect(fixes().queryByRole('button', { name: /Redraw panel 2 with Maya/ })).toBeNull();
      expect(fixes().queryByRole('button', { name: /Redraw page 2/ })).toBeNull();
      expect(fixes().getByRole('button', { name: /Make page 3's line a caption/ })).toBeEnabled();
      r.unmount();
    }
  });

  it('a paid redraw drawing its page retires the free caption fix for that page', () => {
    const drawing: ComicDoc = { ...docWith(), pages: docWith().pages.map((p) => (p.id === 'pg_2' ? { ...p, render: { ...p.render, status: 'rendering' } } : p)) };
    render(<NoticeCard card={notice()} studio={studioFor(drawing)} />);
    expect(fixes().queryByRole('button', { name: /Make Maya's line in panel 2 a caption/ })).toBeNull();
    expect(fixes().getByRole('button', { name: /Redraw page 2, Started/ })).toBeDisabled();
    expect(fixes().getByRole('button', { name: /Make page 3's line a caption/ })).toBeEnabled();
  });

  it('a tap hides the alternatives while it runs; a refused one brings them back', async () => {
    let finish!: (v: unknown) => void;
    const studio = studioFor(docWith(), { act: vi.fn(() => new Promise((r) => (finish = r))) });
    render(<NoticeCard card={notice()} studio={studio} />);
    fireEvent.click(fixes().getByRole('button', { name: /Make Maya's line in panel 2 a caption/ }));
    expect(fixes().queryByRole('button', { name: /Redraw panel 2 with Maya/ })).toBeNull();
    expect(fixes().getByRole('button', { name: /Make page 3's line a caption/ })).toBeEnabled();
    await act(async () => finish({ ok: false }));
    expect(fixes().getByRole('button', { name: /Redraw panel 2 with Maya/ })).toBeEnabled();
  });
});
