import { render, screen, waitFor, within } from '@testing-library/react';
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
    const pageById = (id: string) => {
      const el = screen.getAllByTestId('comic-page').find((p) => p.getAttribute('data-page-id') === id);
      expect(el).toBeDefined();
      return el!;
    };
    const drawn = pageById('gl_page1');
    const planned = pageById('gl_page2');

    // Overlay lettering on the drawn page. The lettering engine (lettering/svgMarkup.ts) wraps a balloon
    // into one SVG <text> per line and draws it in comic uppercase, so a whole line is never one text node:
    // read what each balloon draws (its runs, in order) and what it announces.
    const balloonFor = (line: RegExp) => {
      const hits = within(drawn)
        .getAllByTestId('balloon')
        .filter((b) => line.test(b.getAttribute('aria-label') ?? ''));
      expect(hits).toHaveLength(1);
      return hits[0];
    };
    const drawnRuns = (balloon: Element) =>
      Array.from(balloon.querySelectorAll('text'), (t) => (t.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);

    const caption = balloonFor(/the night the lights went out/i);
    expect(caption).toHaveAttribute('data-kind', 'caption');
    expect(caption).toHaveAttribute('aria-label', 'Caption: Neo-Mumbai. The night the lights went out.');
    expect(drawnRuns(caption).join(' ')).toBe('NEO-MUMBAI. THE NIGHT THE LIGHTS WENT OUT.');

    const speech = balloonFor(/you said the signal came from up here/i);
    expect(speech).toHaveAttribute('data-kind', 'speech');
    expect(speech).toHaveAttribute('aria-label', 'Speech — Maya: You said the signal came from up here.');
    expect(drawnRuns(speech).join(' ')).toBe('YOU SAID THE SIGNAL CAME FROM UP HERE.');

    // The showcase page is editable, so the drawing itself is aria-hidden and every lettered line is
    // announced (and keyboard-reachable) through its movable balloon, in reading order.
    expect(within(drawn).getByTestId('lettering-svg')).toHaveAttribute('aria-hidden', 'true');
    expect(within(drawn).getByRole('button', { name: /^Caption: Neo-Mumbai\. The night the lights went out\./ })).toHaveAttribute(
      'aria-roledescription',
      'movable balloon'
    );
    expect(within(drawn).getByRole('button', { name: /^Speech — Maya: You said the signal came from up here\./ })).toHaveAttribute(
      'aria-roledescription',
      'movable balloon'
    );
    const { drawnPage } = buildComicStudioGallerySample(createEmptyDoc);
    const sampleLines = drawnPage.panels.flatMap((p) => p.lines);
    const movable = within(drawn).getAllByRole('button', { name: /drag or use the arrow keys to move/i });
    expect(movable).toHaveLength(sampleLines.length);
    sampleLines.forEach((line, i) => {
      expect(movable[i]).toHaveAttribute('data-line-id', line.id);
      expect(movable[i].getAttribute('aria-label')).toContain(line.text);
      expect(within(drawn).getAllByTestId('balloon').filter((b) => b.getAttribute('data-line-id') === line.id)).toHaveLength(1);
    });

    // The planned page shows the plan sketch instead of art, and nothing is lettered over it.
    expect(screen.getByRole('img', { name: 'Page 2 plan sketch' })).toBeInTheDocument();
    expect(within(planned).getByRole('img', { name: 'Page 2 plan sketch' })).toBeInTheDocument();
    expect(within(planned).queryByTestId('balloon-layer')).toBeNull();
  });

  it('is not an artifact type, so the coverage contract is unchanged', () => {
    expect(GALLERY_DEMO_TYPES).not.toContain('comic_studio');
    expect(ARTIFACT_TYPES).not.toContain('comic_studio');
  });
});
