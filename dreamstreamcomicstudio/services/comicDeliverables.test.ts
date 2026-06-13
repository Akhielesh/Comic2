import { describe, expect, it } from 'vitest';
import { buildComicExportManifest, buildComicHtmlDocument } from './comicDeliverables';
import type { ComicPanel } from '../types';

const panels: ComicPanel[] = [
  {
    id: 'panel-1',
    sceneId: 1,
    description: 'Maya opens the glowing door.',
    dialogue: 'Maya: "Whoa."',
    imageId: 'image-1',
    imageUrl: 'data:image/png;base64,panel',
    imageIdHistory: ['image-1']
  }
];

describe('comicDeliverables', () => {
  it('builds an offline HTML comic document with escaped title and panel images', () => {
    const html = buildComicHtmlDocument({
      projectName: 'Maya & <Door>',
      panels,
      coverDataUrl: 'data:image/png;base64,cover',
      textLayout: 'caption'
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Maya &amp; &lt;Door&gt;');
    expect(html).toContain('data:image/png;base64,cover');
    expect(html).toContain('data:image/png;base64,panel');
    expect(html).toContain('id="zoomTarget"');
  });

  it('omits imageless (failed/planned) panels from the HTML export', () => {
    const html = buildComicHtmlDocument({
      projectName: 'Maya',
      panels: [
        ...panels,
        {
          id: 'panel-2',
          sceneId: 1,
          description: 'A panel that never rendered.',
          dialogue: '',
          imageIdHistory: [],
          failureReason: 'No image was returned for this panel.'
        }
      ],
      coverDataUrl: 'data:image/png;base64,cover',
      textLayout: 'caption'
    });

    // Only the rendered panel makes the cut — no broken <img src=""> frames.
    expect(html).toContain('data:image/png;base64,panel');
    expect(html).not.toContain('src=""');
    expect((html.match(/<div class="panel">/g) || []).length).toBe(1);
  });

  it('builds a compact export manifest for agent-prepared outputs', () => {
    const manifest = JSON.parse(buildComicExportManifest({
      projectId: 'project-1',
      projectName: 'Maya',
      panels,
      coverImageId: 'cover-1',
      outputTargets: ['comic', 'book', 'html']
    }));

    expect(manifest.kind).toBe('dreamstream_comic_export_manifest');
    expect(manifest.panelCount).toBe(1);
    expect(manifest.renderedPanels).toBe(1);
    expect(manifest.panels[0]).toMatchObject({ id: 'panel-1', imageId: 'image-1' });
  });
});
