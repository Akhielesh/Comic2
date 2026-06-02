// Lettering. Composites caption/dialogue text boxes onto a page image with sharp + an SVG
// overlay. The ComicForge data model does not yet carry per-panel dialogue, so when no
// `elements` are supplied this is a correct no-content pass (it returns the page unchanged);
// it becomes meaningful as soon as dialogue/balloon zones are populated upstream.

import sharp from 'sharp';
import { persistGeneratedImage } from '../../services/imageStorage.js';
import { downloadImageBuffer, listProjectPageImages } from './pageAssets.js';

type LetteringElement = {
  text: string;
  xPct?: number;
  yPct?: number;
  wPct?: number;
  hPct?: number;
};

const escapeXml = (value: string): string =>
  value.replace(/[<>&'"]/g, (char) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char] || char)
  );

const pageIndexFromId = (pageId: string): number => {
  const match = /(\d+)\s*$/.exec(pageId);
  const n = match ? Number(match[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n - 1 : 0;
};

const buildOverlaySvg = (width: number, height: number, elements: LetteringElement[]): string => {
  const boxes = elements.map((el) => {
    const x = Math.round(((el.xPct ?? 5) / 100) * width);
    const y = Math.round(((el.yPct ?? 5) / 100) * height);
    const w = Math.round(((el.wPct ?? 35) / 100) * width);
    const h = Math.round(((el.hPct ?? 18) / 100) * height);
    const fontSize = Math.max(14, Math.round(h / 5));
    return `
      <g>
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.round(h / 6)}"
              fill="white" stroke="black" stroke-width="3" opacity="0.95" />
        <foreignObject x="${x + 8}" y="${y + 6}" width="${w - 16}" height="${h - 12}">
          <div xmlns="http://www.w3.org/1999/xhtml"
               style="font-family: 'Comic Sans MS', sans-serif; font-size:${fontSize}px; color:#000; line-height:1.1; text-align:center;">
            ${escapeXml(el.text)}
          </div>
        </foreignObject>
      </g>`;
  }).join('');

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${boxes}</svg>`;
};

export const runLetteringWorker = async (payload: Record<string, unknown>) => {
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  const pageId = typeof payload.pageId === 'string' ? payload.pageId : 'page-1';
  if (!projectId || !userId) {
    throw new Error('render_lettering job is missing projectId/userId.');
  }

  const elements = Array.isArray(payload.elements)
    ? (payload.elements as unknown[]).filter(
        (el): el is LetteringElement =>
          typeof el === 'object' && el !== null && typeof (el as LetteringElement).text === 'string'
      )
    : [];

  const pages = await listProjectPageImages(projectId);
  const page = pages[pageIndexFromId(pageId)] || pages[0];
  if (!page) {
    throw new Error('No generated page image available to letter. Run generation first.');
  }

  // Nothing to overlay yet — return the existing page unchanged (correct no-content pass).
  if (elements.length === 0) {
    return {
      lettered: true,
      pageId,
      imageId: page.imageId,
      imageUrl: page.imageUrl,
      elementsRendered: 0,
      completedAt: Date.now()
    };
  }

  const baseBuffer = await downloadImageBuffer(page.bucket, page.imageId);
  const image = sharp(baseBuffer, { failOnError: false });
  const metadata = await image.metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;

  const svg = buildOverlaySvg(width, height, elements);
  const composited = await image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  const dataUrl = `data:image/png;base64,${composited.toString('base64')}`;
  const saved = await persistGeneratedImage({
    userId,
    projectId,
    dataUrl,
    source: 'upload'
  });

  return {
    lettered: true,
    pageId,
    imageId: saved.imageId,
    imageUrl: saved.imageUrl,
    elementsRendered: elements.length,
    completedAt: Date.now()
  };
};
