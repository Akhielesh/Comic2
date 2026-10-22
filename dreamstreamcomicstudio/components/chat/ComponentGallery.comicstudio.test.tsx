import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, normalizeDoc } from '../../shared/comic/doc';
import { ARTIFACT_TYPES } from './artifacts/ChatArtifacts';
import { ComicStudioGallerySection, GALLERY_DEMO_TYPES, buildComicStudioGallerySample } from './ComponentGallery';

describe('Gallery — Comic Studio showcase', () => {
  it('builds a valid sample doc: a drawn, overlay-lettered page and a planned page', () => {
    const { doc, drawnPage, plannedPage } = buildComicStudioGallerySample(createEmptyDoc);

    // The sample survives normalization unchanged in shape (it is a real ComicDoc).
    const normalized = normalizeDoc(doc);
    expect(normalized.pages).toHaveLength(2);
    expect(doc.format.lettering).toBe('overlay');

    expect(drawnPage.render.status).toBe('ready');
    expect(drawnPage.render.qc?.panelBoxes).toHaveLength(drawnPage.panels.length);
    // Every lettered line has a balloon, and every balloon points at a real line.
    const lineIds = drawnPage.panels.flatMap((p) => p.lines.map((l) => l.id));
    expect(drawnPage.balloons.map((b) => b.lineId).sort()).toEqual([...lineIds].sort());
    // Speakers are on the page's cast.
    const castIds = new Set(doc.cast.map((c) => c.id));
    for (const line of drawnPage.panels.flatMap((p) => p.lines)) {
      if (line.speakerId) expect(castIds.has(line.speakerId)).toBe(true);
    }

    expect(plannedPage.render.status).toBe('none');
    expect(plannedPage.render.asset).toBeUndefined();
  });

  it('lazily renders the drawn page with balloons and the plan sketch', async () => {
    render(<ComicStudioGallerySection />);
    expect(screen.getByRole('region', { name: 'Comic Studio' })).toBeInTheDocument();

    await waitFor(() => expect(screen.getAllByTestId('comic-page')).toHaveLength(2), { timeout: 5000 });
    // Overlay lettering on the drawn page (comic lettering is uppercase).
    expect(screen.getByText(/the night the lights went out/i)).toBeInTheDocument();
    expect(screen.getByText(/you said the signal came from up here/i)).toBeInTheDocument();
    // The planned page shows the plan sketch instead of art.
    expect(screen.getByRole('img', { name: 'Page 2 plan sketch' })).toBeInTheDocument();
  });

  it('is not an artifact type, so the coverage contract is unchanged', () => {
    expect(GALLERY_DEMO_TYPES).not.toContain('comic_studio');
    expect(ARTIFACT_TYPES).not.toContain('comic_studio');
  });
});
