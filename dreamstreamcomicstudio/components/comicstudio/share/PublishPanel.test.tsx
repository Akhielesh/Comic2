// Publish panel readiness (sharing.md §7.3 #2; gate F3/F4 follow-up): a cover the publish gate would
// REFUSE — drawn, but from an image outside the studio (publication.ts OUTSIDE_IMAGE_STATUS) — says so
// in the readiness list, instead of 'No cover yet' while "Publish" then answers 422.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PublishReadiness } from '../../../shared/comic/publication';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { PublishPanel, readinessRows } from './PublishPanel';

/** The server's word for drawn art that isn't server-made (server/src/comic/publication/publication.ts OUTSIDE_IMAGE_STATUS). */
const OUTSIDE_IMAGE_STATUS = 'uses an image from outside the studio — redraw it or upload the image again';

const readiness = (missing: PublishReadiness['missing']): PublishReadiness => ({
  ok: missing.length === 0,
  drawnPages: 3,
  plannedPages: 3,
  missing,
  stalePages: [],
  safety: { status: 'cleared', blockedPages: [], reasons: [] },
  languages: [{ lang: 'en', publishable: true, blocking: [] }]
});

const coverRow = (r: PublishReadiness) => readinessRows(r, makeSampleDoc()).find((row) => /cover/i.test(row.text));

describe('readinessRows — the cover line', () => {
  it('a cover from outside the studio repeats the gate’s refusal (it is drawn, so never "No cover yet")', () => {
    const row = coverRow(readiness([{ kind: 'cover', status: OUTSIDE_IMAGE_STATUS }]));
    expect(row).toEqual({ ok: 'warn', text: `Cover ${OUTSIDE_IMAGE_STATUS}` });
    expect(readinessRows(readiness([{ kind: 'cover', status: OUTSIDE_IMAGE_STATUS }]), makeSampleDoc()).map((r) => r.text)).not.toContain('No cover yet — the preview uses page 1');
  });

  it('a cover with no art yet keeps the "No cover yet" line, whatever stage it is at', () => {
    for (const status of ['not drawn yet', 'waiting to draw', 'drawing now', "didn't draw"]) {
      expect(coverRow(readiness([{ kind: 'cover', status }]))).toEqual({ ok: 'warn', text: 'No cover yet — the preview uses page 1' });
    }
    // No readiness at all (still loading): the same calm line, never a claim of readiness.
    expect(coverRow(undefined as unknown as PublishReadiness)).toEqual({ ok: 'warn', text: 'No cover yet — the preview uses page 1' });
  });

  it('a cover the gate accepts reads "Cover ready", and pages keep their own lines', () => {
    expect(coverRow(readiness([]))).toEqual({ ok: true, text: 'Cover ready' });
    const rows = readinessRows(readiness([{ kind: 'page', n: 2, status: OUTSIDE_IMAGE_STATUS }]), makeSampleDoc());
    expect(rows.map((r) => r.text)).toContain(`Page 2: ${OUTSIDE_IMAGE_STATUS}`);
    expect(coverRow(readiness([{ kind: 'page', n: 2, status: OUTSIDE_IMAGE_STATUS }]))).toEqual({ ok: true, text: 'Cover ready' });
  });
});

describe('PublishPanel', () => {
  it('shows the outside-image cover line in the readiness list, marked as needing attention', () => {
    const doc = makeSampleDoc();
    render(
      <PublishPanel
        doc={doc}
        view={{ slug: null, status: 'draft', visibility: 'unlisted', languages: ['en'], allowDownload: true, allowEmbed: true, showCreator: false, readiness: readiness([{ kind: 'cover', status: OUTSIDE_IMAGE_STATUS }]) } as never}
        visibility="unlisted"
        onPublish={vi.fn()}
      />
    );
    const list = screen.getByRole('list', { name: 'Readiness' });
    const line = Array.from(list.querySelectorAll('li')).find((li) => li.textContent?.includes(`Cover ${OUTSIDE_IMAGE_STATUS}`));
    expect(line).toBeTruthy();
    expect(line!.querySelector('[aria-label="Needs attention"]')).toBeTruthy();
    expect(screen.queryByText('No cover yet — the preview uses page 1')).toBeNull();
  });
});
