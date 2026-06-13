import type { ComicPanel, TextLayout } from '../types';
import { EXPORT_DIALOGUE_CSS, buildPanelDialogueHtml } from './panelLayout';

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');

export type ComicHtmlPanel = ComicPanel & {
  dataUrl?: string;
};

export interface ComicHtmlDocumentInput {
  projectName: string;
  panels: ComicHtmlPanel[];
  coverDataUrl?: string;
  textLayout: TextLayout;
}

export const buildComicHtmlDocument = ({
  projectName,
  panels,
  coverDataUrl,
  textLayout
}: ComicHtmlDocumentInput) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)}</title>
  <style>
    body{margin:0;padding:20px;background:#eee;font-family:Arial,sans-serif;}
    .toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;}
    .comic-container{max-width:900px;margin:0 auto;background:white;padding:20px;box-shadow:0 4px 6px rgba(0,0,0,0.1);}
    .cover{margin-bottom:24px;border:4px solid #000;overflow:hidden;}
    .cover img{width:100%;display:block;}
    .panel{margin-bottom:20px;border:2px solid black;position:relative;overflow:hidden;}
    .panel img{width:100%;display:block;}
    .zoom-wrapper{transform-origin:top center;}
    @media print {
      body{background:white;padding:0;}
      .toolbar{display:none;}
      .comic-container{box-shadow:none;max-width:none;}
      .panel{break-inside:avoid;page-break-inside:avoid;}
    }
    ${EXPORT_DIALOGUE_CSS}
  </style>
</head>
<body>
  <div class="toolbar">
    <label for="zoom">Zoom</label>
    <input id="zoom" type="range" min="0.5" max="2" value="1" step="0.1" />
    <button type="button" onclick="adjustZoom(-0.1)">-</button>
    <button type="button" onclick="adjustZoom(0.1)">+</button>
  </div>
  <div class="comic-container zoom-wrapper" id="zoomTarget">
    ${coverDataUrl ? `<div class="cover"><img src="${coverDataUrl}" alt="${escapeHtml(projectName)} cover" /></div>` : ''}
    ${panels.map((panel) => `<div class="panel">
      <img src="${panel.dataUrl || panel.imageUrl || ''}" alt="${escapeHtml(panel.description || panel.id)}" />
      ${buildPanelDialogueHtml(panel, textLayout)}
    </div>`).join('')}
  </div>
  <script>
    const zoom = document.getElementById('zoom');
    const target = document.getElementById('zoomTarget');
    const applyZoom = () => { target.style.transform = 'scale(' + zoom.value + ')'; };
    zoom.addEventListener('input', applyZoom);
    const adjustZoom = (delta) => { zoom.value = Math.min(2, Math.max(0.5, Number(zoom.value) + delta)); applyZoom(); };
    applyZoom();
  </script>
</body>
</html>`;

export const buildComicExportManifest = (input: {
  projectId: string;
  projectName: string;
  panels: ComicPanel[];
  coverImageId?: string;
  coverImageUrl?: string;
  outputTargets: string[];
}) => JSON.stringify({
  kind: 'dreamstream_comic_export_manifest',
  projectId: input.projectId,
  projectName: input.projectName,
  preparedAt: new Date().toISOString(),
  panelCount: input.panels.length,
  renderedPanels: input.panels.filter((panel) => panel.imageId || panel.imageUrl).length,
  coverImageId: input.coverImageId,
  hasCoverImageUrl: Boolean(input.coverImageUrl),
  outputTargets: input.outputTargets,
  panels: input.panels.map((panel, index) => ({
    id: panel.id,
    index,
    sceneId: panel.sceneId,
    imageId: panel.imageId,
    hasImageUrl: Boolean(panel.imageUrl),
    description: panel.description,
    dialogue: panel.dialogue
  }))
}, null, 2);
