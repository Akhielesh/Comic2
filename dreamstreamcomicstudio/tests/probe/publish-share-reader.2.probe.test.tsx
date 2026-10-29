// Probe (publish-share-reader, Share sheet): a finished translation can be ticked in the PublishPanel.
// The owner view's readiness only ever lists the already-published languages (see probe 1: for a
// never-published comic that is [{ lang: 'en' }]), and PublishPanel.tsx:79 treats every other edition as
// "not ready" (chip disabled, title "Finish and review this translation first") — so a complete,
// reviewed Hindi edition can never be published from the Share sheet.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../shared/comic/doc';
import { editionReadiness, lineSourceHash } from '../../shared/comic/i18n';
import type { PublicationOwnerView } from '../../shared/comic/publication';
import { makeSampleDoc } from '../../components/comicstudio/conversation/testing/fixtures';
import { PublishPanel } from '../../components/comicstudio/share/PublishPanel';

const withHindi = (doc: ComicDoc): ComicDoc => {
  doc.format = { ...doc.format, language: 'en', lettering: 'overlay' };
  const lines = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).filter((l) => l.text.trim());
  const translated = Object.fromEntries(lines.map((l) => [l.id, { text: `HI:${l.text}`, status: 'reviewed' as const, sourceHash: lineSourceHash(l), at: 1 }]));
  doc.i18n = { editions: { hi: { lang: 'hi', lines: translated, balloons: {}, register: 'everyday' } }, glossary: [] };
  return doc;
};

/** What GET /publication returns for a never-published comic (publication.ts getReadiness: wanted = [source]). */
const serverView = (): PublicationOwnerView => ({
  visibility: 'private',
  status: null,
  languages: ['en'],
  allowDownload: true,
  allowEmbed: true,
  showCreator: false,
  publishedRev: 0,
  docRev: 3,
  behind: false,
  readiness: {
    ok: true,
    drawnPages: 3,
    plannedPages: 3,
    missing: [],
    stalePages: [],
    safety: { status: 'cleared', blockedPages: [], reasons: [] },
    languages: [{ lang: 'en', publishable: true, blocking: [] }]
  }
});

describe('PublishPanel language chips', () => {
  it('a complete, reviewed Hindi edition is offered (enabled, not "not ready") on the first publish', () => {
    const doc = withHindi(makeSampleDoc());
    expect(editionReadiness(doc, 'hi').publishable).toBe(true); // precondition: the server would accept it
    render(<PublishPanel doc={doc} view={serverView()} visibility="unlisted" onPublish={vi.fn()} />);
    const hindi = screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi).not.toBeDisabled();
    expect(hindi.closest('label')?.textContent).not.toMatch(/not ready/);
  });
});
