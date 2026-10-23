// Sent photos say where they went ("→ MAYA") or ask "Unassigned · Assign" (refs.md §7.2): the
// client side of "Who's in these photos?" — filing is a free, undoable patch, no director call.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { applyOps } from '../../../shared/comic/ops';
import { UserBubble, assignPhotoOps, photoOwnerLabel } from './MessageItem';
import { makeFakeStudio, makeSampleDoc } from './testing/fixtures';

const photo = (path: string): AssetRef => ({ path, source: 'upload', at: 1, w: 800, h: 600 });

const docWith = (): ComicDoc => {
  const doc = makeSampleDoc();
  return {
    ...doc,
    cast: doc.cast.map((c) => (c.id === 'c_maya' ? { ...c, refs: [{ ...photo('u/1/ref/maya1.webp') }] } : c)),
    refInbox: [photo('u/1/ref/inbox/waiting.webp')]
  };
};

describe('photo owners', () => {
  it('photoOwnerLabel finds where a sent photo lives (never the inbox)', () => {
    const doc = docWith();
    expect(photoOwnerLabel(doc, 'u/1/ref/maya1.webp')).toBe('MAYA');
    expect(photoOwnerLabel(doc, 'u/1/ref/inbox/waiting.webp')).toBeNull();
    expect(photoOwnerLabel(doc, 'u/1/ref/nowhere.webp')).toBeNull();
    const styled = { ...doc, style: { ...doc.style, refs: [photo('u/1/ref/maya1.webp')] } };
    expect(photoOwnerLabel(styled, 'u/1/ref/maya1.webp')).toBe('Style +1');
  });

  it('assignPhotoOps adds a message photo, moves an inbox photo, and creates a new character once', () => {
    const doc = docWith();
    const add = assignPhotoOps(doc, [photo('u/1/ref/msg.webp')], { kind: 'character', id: 'c_arjun' });
    expect(add.ops).toEqual([{ op: 'ref_add', owner: { kind: 'character', id: 'c_arjun' }, ref: { path: 'u/1/ref/msg.webp', source: 'upload', at: 1, w: 800, h: 600 } }]);
    const move = assignPhotoOps(doc, [photo('u/1/ref/inbox/waiting.webp')], { kind: 'style' });
    expect(move.ops).toEqual([{ op: 'ref_transfer', from: { kind: 'inbox' }, to: { kind: 'style' }, path: 'u/1/ref/inbox/waiting.webp' }]);
    const fresh = assignPhotoOps(doc, [photo('u/1/ref/a.webp'), photo('u/1/ref/b.webp')], { kind: 'new_character', name: ' Bruno ' });
    expect(fresh.ops[0]).toMatchObject({ op: 'character', patch: { name: 'Bruno', tier: 'support' } });
    expect(fresh.ops.filter((o) => o.op === 'ref_add')).toHaveLength(2);
    // Applying them really files both photos under the new character.
    const after = applyOps(doc, fresh.ops);
    const bruno = after.cast.find((c) => c.name === 'Bruno');
    expect(bruno?.refs.map((r) => r.path)).toEqual(['u/1/ref/a.webp', 'u/1/ref/b.webp']);
    // An existing name is reused, not duplicated.
    expect(assignPhotoOps(doc, [photo('u/1/ref/c.webp')], { kind: 'new_character', name: 'maya' }).ops).toEqual([
      { op: 'ref_add', owner: { kind: 'character', id: 'c_maya' }, ref: expect.objectContaining({ path: 'u/1/ref/c.webp' }) }
    ]);
    expect(assignPhotoOps(doc, [photo('x')], null).ops).toEqual([]);
  });
});

describe('UserBubble — sent photos', () => {
  it('shows "→ MAYA" for a filed photo and "Unassigned · Assign" for the rest; assigning patches for free', () => {
    const doc = docWith();
    const studio = makeFakeStudio({ doc });
    render(<UserBubble text="These are Maya" attachments={[photo('u/1/ref/maya1.webp'), photo('u/1/ref/new.webp')]} urlFor={studio.urlFor} studio={studio} />);
    expect(screen.getByText('→ MAYA')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Unassigned · Assign/ }));
    const menu = screen.getByRole('menu', { name: "Who's in this photo?" });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /ARJUN/ }));
    const [ops, opts] = studio.patch.mock.calls[0] as [DocOp[], { label: string }];
    expect(ops).toEqual([{ op: 'ref_add', owner: { kind: 'character', id: 'c_arjun' }, ref: expect.objectContaining({ path: 'u/1/ref/new.webp' }) }]);
    expect(opts.label).toBe('file a photo under ARJUN');
  });

  it('tapping an unassigned photo assigns just that one; several unassigned photos can be assigned at once', () => {
    const doc = docWith();
    const studio = makeFakeStudio({ doc });
    render(<UserBubble text="" attachments={[photo('u/1/ref/a.webp'), photo('u/1/ref/b.webp')]} urlFor={studio.urlFor} studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Photo 2 is unassigned — assign it' }));
    expect(screen.getByRole('menu', { name: "Who's in this photo?" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /Art style reference/ }));
    expect((studio.patch.mock.calls[0][0] as DocOp[]).map((o) => (o as { ref?: { path: string } }).ref?.path)).toEqual(['u/1/ref/b.webp']);
    fireEvent.click(screen.getByRole('button', { name: /Unassigned · Assign 2/ }));
    expect(screen.getByRole('menu', { name: "Who's in these 2 photos?" })).toBeInTheDocument();
  });

  it('a brand-new character is saved first, then the photos follow (the server checks them against the comic as it is)', async () => {
    const doc = docWith();
    const studio = makeFakeStudio({ doc });
    render(<UserBubble text="" attachments={[photo('u/1/ref/dog.webp')]} urlFor={studio.urlFor} studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /Unassigned · Assign/ }));
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /New character/ }));
    fireEvent.change(screen.getByLabelText("New character's name"), { target: { value: 'Bruno' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(studio.patch).toHaveBeenCalledTimes(2));
    const [first, second] = studio.patch.mock.calls.map((c) => c[0] as DocOp[]);
    expect(first).toEqual([expect.objectContaining({ op: 'character', patch: expect.objectContaining({ name: 'Bruno' }) })]);
    const id = (first[0] as { id: string }).id;
    expect(second).toEqual([{ op: 'ref_add', owner: { kind: 'character', id }, ref: expect.objectContaining({ path: 'u/1/ref/dog.webp' }) }]);
  });

  it('a full owner is offered but disabled, with the reason', () => {
    const doc = docWith();
    const full = { ...doc, cast: doc.cast.map((c) => (c.id === 'c_arjun' ? { ...c, refs: Array.from({ length: 12 }, (_, i) => photo(`u/1/ref/a${i}.webp`)) } : c)) };
    const studio = makeFakeStudio({ doc: full });
    render(<UserBubble text="" attachments={[photo('u/1/ref/x.webp')]} urlFor={studio.urlFor} studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /Unassigned · Assign/ }));
    const arjun = within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /ARJUN/ });
    expect(arjun).toBeDisabled();
    expect(arjun).toHaveTextContent(/remove one first/);
  });

  it('pending (unsent) messages and bubbles without a studio show plain thumbnails', () => {
    render(<UserBubble text="hi" attachments={[{ name: 'p.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA' }]} urlFor={() => undefined} />);
    expect(screen.getByAltText('p.png')).toBeInTheDocument();
    expect(screen.queryByText(/Unassigned/)).toBeNull();
  });
});
