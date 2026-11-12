/**
 * EGRESS-DB E1 review: the library opens this modal with a comic's CARD, which carries no image tags and no custom
 * aspect ratio. The gallery and the exports read the full state from the export payload (exportProject reads the
 * whole row), and the image-tag effect never assigns tags from the card (they would replace the comic's own).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../../types';
import { CARD_STATE } from '../../services/projectCardState';

const { loadJsPdfMock, exportProjectMock, downloadBlobMock } = vi.hoisted(() => ({
  loadJsPdfMock: vi.fn(),
  exportProjectMock: vi.fn(),
  downloadBlobMock: vi.fn()
}));

vi.mock('../../services/legacyPdfLoader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/legacyPdfLoader')>()),
  loadJsPdf: loadJsPdfMock,
  isLegacyPdfReady: vi.fn(() => false)
}));
vi.mock('../../services/db', () => ({
  exportProject: exportProjectMock,
  loadArtifactsForProject: vi.fn(async () => [])
}));
vi.mock('../../services/download', () => ({ downloadBlob: downloadBlobMock }));

import { ProjectInfoModal } from './ProjectInfoModal';

const TAGS = {
  'user-1/cover.png': { imageId: 'user-1/cover.png', tag: 'COVER-0003', category: 'COVER', createdAt: 2 },
  'user-1/p1.png': { imageId: 'user-1/p1.png', tag: 'PANEL-0007', category: 'PANEL', createdAt: 1 }
};
const shared = {
  step: 6, script: 'Maya opens a door.', scenes: [], overview: '', comments: [], isFeatured: false, styleVariants: [],
  characters: [], items: [], locations: [], layoutType: 'grid', textLayout: 'caption', styleCategory: 'Ligne Claire',
  styleAspectRatio: '1:1', imageResolution: '1K', coverImageId: 'user-1/cover.png'
};
/** What the library holds: the card keys only, with the previews it signed. */
const cardState = {
  [CARD_STATE]: true,
  ...shared,
  coverImageUrl: 'https://signed.test/cover.png',
  panels: [{ id: 'p1', imageId: 'user-1/p1.png', imageUrl: 'https://signed.test/p1.png' }]
} as unknown as ComicState;
/** The stored row's state (exportProject selects the whole row). */
const storedState = {
  ...shared,
  maxStepReached: 7,
  panels: [{ id: 'p1', imageId: 'user-1/p1.png' }],
  imageTags: TAGS,
  imageTagCounters: { COVER: 3, PANEL: 7 },
  customAspectRatioEnabled: true,
  customAspectRatio: '2:3',
  versions: [{ id: 'v1', name: 'Old', createdAt: 1, state: {} }]
};
const card: Project = { id: 'project-1', name: 'Maya and the Door', createdAt: 1, updatedAt: 2, state: cardState };

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 200;
  height = 300;
  set src(_value: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

beforeEach(() => {
  loadJsPdfMock.mockReset();
  downloadBlobMock.mockReset();
  exportProjectMock.mockReset();
  exportProjectMock.mockResolvedValue({ project: { id: 'project-1', name: 'Maya and the Door', state: storedState }, images: {}, artifacts: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('Image', FakeImage);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProjectInfoModal opened from the library with a card', () => {
  it('never assigns image tags from the card', async () => {
    const onUpdateProject = vi.fn();
    render(<ProjectInfoModal project={card} onClose={vi.fn()} onUpdateProject={onUpdateProject} />);
    await waitFor(() => expect(exportProjectMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 700)); // past the 400 ms artifacts load the effect also waits on
    expect(onUpdateProject).not.toHaveBeenCalled();
  });

  it('the gallery shows the comic\'s stored tags and categories', async () => {
    render(<ProjectInfoModal project={card} onClose={vi.fn()} onUpdateProject={vi.fn()} />);
    expect(await screen.findByText('COVER-0003')).toBeInTheDocument();
    expect(screen.getByText('PANEL-0007')).toBeInTheDocument();
    expect(screen.getByText('2 images')).toBeInTheDocument();
  });

  it('the PDF follows the stored custom aspect ratio', async () => {
    const orientations: string[] = [];
    class FakePdf {
      internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
      constructor(orientation: string) {
        orientations.push(orientation);
      }
      addPage() {}
      addImage() {}
      output() {
        return new Blob(['pdf']);
      }
    }
    loadJsPdfMock.mockResolvedValue(FakePdf);
    render(<ProjectInfoModal project={card} onClose={vi.fn()} onUpdateProject={vi.fn()} />);
    await waitFor(() => expect(exportProjectMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalled());
    // 2:3 is portrait; the card alone (1:1) would have made it landscape.
    expect(orientations).toEqual(['p']);
  });
});
