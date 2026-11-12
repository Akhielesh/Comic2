// @vitest-environment jsdom
// Project info on Atlas (DS-3): a centred modal dialog titled with DIALOG_TITLE that Escape closes (the image
// gallery on top takes Escape first), and money read the way THIS user should see it — governed users never
// see a dollar figure, in the dialog or in the project ZIP it downloads (house rule; P1-LIMITS).
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllowanceStatus } from '../../services/usageAllowance';
import type { Project } from '../../types';
import { DIALOG_TITLE } from '../chat/studioDesign';

const allowance = vi.hoisted(() => ({ status: null as AllowanceStatus | null }));
vi.mock('../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

const db = vi.hoisted(() => ({ exportProject: vi.fn(), loadArtifactsForProject: vi.fn() }));
vi.mock('../../services/db', () => db);

const download = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('../../services/download', () => download);

import { ProjectInfoModal } from './ProjectInfoModal';

const GOVERNED: AllowanceStatus = {
  enabled: true,
  governed: true,
  pctUsed: 10,
  pctLeft: 90,
  exhausted: false,
  crossed: [],
  resetsAt: null,
  friendlyUnits: { standardPages: 40, draftPages: 80, pctPerStandardPage: 2, label: 'about 40 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false
};
const ADMIN: AllowanceStatus = { ...GOVERNED, governed: false };

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const project = {
  id: 'p1',
  name: 'The Lantern Keeper',
  updatedAt: 1_700_000_000_000,
  isPublic: false,
  state: {
    step: 0,
    overview: '',
    comments: [],
    styleVariants: [],
    characters: [],
    items: [],
    locations: [],
    panels: [],
    scenes: [],
    layoutType: 'grid',
    textLayout: 'caption',
    imageTags: { img1: { tag: 'P1', label: 'Panel 1', category: 'PANEL', createdAt: 1 }, img2: { tag: 'P2', label: 'Panel 2', category: 'PANEL', createdAt: 2 } },
    imageTagCounters: {}
  }
} as unknown as Project;

/** The stored project row: its state carries dollar figures (the story plan's estimate, the agent's cap, a v4 image's cost). */
const projectRow = () => ({
  id: 'p1',
  name: 'The Lantern Keeper',
  state: {
    storyPlanning: { approved: true, estimatedCostRange: { currency: '$', minUsd: 1.2, maxUsd: 3.4 } },
    agentSettings: { autoPageCount: true, budgetCapUsd: 5 },
    studioPages: [{ id: 'pg1', variants: [{ path: 'pages/pg1/a.png', costUsd: 0.04 }] }]
  }
});

/** One generation record, with the local dollar estimate every record carries (GenerationArtifact.cost). */
const ARTIFACT = {
  id: 'a1',
  projectId: 'p1',
  timestamp: 1_700_000_000_500,
  type: 'image',
  model: 'm',
  prompt: 'The keeper lights the lantern',
  stage: 'panel',
  success: true,
  cost: { currency: '$', value: 0.25, isEstimated: true }
};

const exportPayload = () => ({
  project: projectRow(),
  images: { img1: PNG, img2: PNG },
  artifacts: [{ id: 'a1', type: 'image', cost: { value: 0.25, currency: '$' } }],
  report: {
    cost_summary: {
      totalCost: 0.5,
      currency: '$',
      estimatedArtifactCount: 2,
      byType: { image: { cost: 0.4, tokens: 0 }, text: { cost: 0.1, tokens: 120 } },
      byModel: { m: { cost: 0.5, tokens: 120 } },
      byStage: { panel: { cost: 0.5, tokens: 120 } }
    },
    ai_usage: {
      totalArtifacts: 1,
      totalTokens: 120,
      byModel: { m: { cost: 0.5, tokens: 120 } },
      byStage: {},
      byType: {},
      artifacts: [{ id: 'a1', totalTokens: 120, cost: { value: 0.25, currency: '$' }, stage: 'panel', type: 'image', model: 'm' }]
    },
    storage: { imageCount: 2, imageBytes: 2048 }
  }
});

const open = async (onClose = vi.fn()) => {
  render(<ProjectInfoModal project={project} onClose={onClose} onUpdateProject={vi.fn()} />);
  await screen.findByText('Artifacts'); // the report has loaded
  return onClose;
};

beforeEach(() => {
  allowance.status = GOVERNED;
  db.exportProject.mockResolvedValue(exportPayload());
  db.loadArtifactsForProject.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectInfoModal — a centred Atlas dialog', () => {
  it('is a modal dialog named by its DIALOG_TITLE heading, with focus moved in', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: 'The Lantern Keeper' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const title = within(dialog).getByRole('heading', { level: 2, name: 'The Lantern Keeper' });
    for (const cls of DIALOG_TITLE.split(' ')) expect(title.className.split(/\s+/)).toContain(cls);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close project info' }));
    // No comic chrome on the surface (the legacy kit), and no hard white on a fill.
    expect(dialog.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red)|text-white/);
  });

  it('Escape closes it; with the gallery open on top, Escape closes only the gallery', async () => {
    const onClose = await open();
    fireEvent.click(await screen.findByRole('button', { name: /P1/ }));
    const gallery = await screen.findByRole('dialog', { name: /P1 · Panel 1/ });
    expect(gallery).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /P1 · Panel 1/ })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectInfoModal — cost reads the way this user should see it', () => {
  it('a governed user sees shares of their usage and never a dollar sign', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Show Advanced' }));
    const dialog = screen.getByRole('dialog', { name: 'The Lantern Keeper' });
    const cost = within(dialog).getByTestId('project-cost');
    expect(within(cost).getByRole('heading', { name: 'Usage' })).toBeInTheDocument();
    expect(cost.textContent).toMatch(/of your usage/);
    expect(dialog.textContent).not.toMatch(/\$|¢/);
  });

  it('an admin (no limit applies) still sees the dollar report', async () => {
    allowance.status = ADMIN;
    await open();
    const cost = screen.getByTestId('project-cost');
    expect(within(cost).getByRole('heading', { name: 'Cost & Usage' })).toBeInTheDocument();
    expect(cost.textContent).toContain('$0.5000');
  });

  it('a status that has not loaded yet never shows dollars (fails closed)', async () => {
    allowance.status = null;
    await open();
    expect(screen.getByRole('dialog', { name: 'The Lantern Keeper' }).textContent).not.toMatch(/\$/);
  });

  const zipReport = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
    await waitFor(() => expect(download.downloadBlob).toHaveBeenCalledTimes(1));
    const blob = download.downloadBlob.mock.calls[0][0] as Blob;
    const zip = await act(async () => JSZip.loadAsync(blob));
    const read = async (name: string) => JSON.parse(await zip.file(name)!.async('string'));
    return {
      summary: await read('report/cost_summary.json'),
      usage: await read('report/ai_usage.json'),
      artifacts: await read('artifacts/artifacts.json'),
      projectJson: await zip.file('project.json')!.async('string')
    };
  };

  it('the project ZIP a governed user downloads carries token counts, not dollar estimates', async () => {
    await open();
    const { summary, usage, artifacts, projectJson } = await zipReport();
    expect(JSON.stringify([summary, usage, artifacts])).not.toMatch(/"cost"|totalCost|"currency"/);
    expect(summary.byModel).toEqual({ m: { tokens: 120 } });
    expect(usage.totalTokens).toBe(120);
    expect(artifacts).toEqual([{ id: 'a1', type: 'image' }]);
    // project.json is the whole project, without the dollar figures its state carries.
    expect(projectJson).not.toMatch(/Usd|"currency"|estimatedCostRange/);
    const row = JSON.parse(projectJson);
    expect(row.state.storyPlanning).toEqual({ approved: true });
    expect(row.state.agentSettings).toEqual({ autoPageCount: true });
    expect(row.state.studioPages).toEqual([{ id: 'pg1', variants: [{ path: 'pages/pg1/a.png' }] }]);
  });

  it('an admin’s ZIP keeps the full report', async () => {
    allowance.status = ADMIN;
    await open();
    const { summary, artifacts, projectJson } = await zipReport();
    expect(summary.totalCost).toBe(0.5);
    expect(artifacts[0].cost).toEqual({ value: 0.25, currency: '$' });
    expect(JSON.parse(projectJson)).toEqual(projectRow());
  });

  const viewArtifact = async () => {
    db.loadArtifactsForProject.mockResolvedValue([{ ...ARTIFACT }]);
    await open();
    // The generation log loads a moment after the dialog opens (one 400 ms wait, never repeated).
    fireEvent.click(await screen.findByRole('button', { name: 'View' }, { timeout: 2000 }));
    return screen.getByTestId('artifact-json');
  };

  it('a governed user’s generation log “View” shows the record without its dollar estimate', async () => {
    const json = await viewArtifact();
    expect(json.textContent).toContain('"prompt": "The keeper lights the lantern"');
    expect(json.textContent).not.toMatch(/"cost"|\$/);
    expect(screen.getByRole('dialog', { name: 'The Lantern Keeper' }).textContent).not.toMatch(/\$|¢/);
  });

  it('an admin’s “View” keeps the whole record, its cost included', async () => {
    allowance.status = ADMIN;
    const json = await viewArtifact();
    expect(JSON.parse(json.textContent || '{}')).toEqual(ARTIFACT);
  });
});

describe('ProjectInfoModal — the Library setting', () => {
  it('is a switch with one name (never “Public” or “Private” as its name), its state in aria-checked', async () => {
    const onUpdateProject = vi.fn();
    render(<ProjectInfoModal project={project} onClose={vi.fn()} onUpdateProject={onUpdateProject} />);
    await screen.findByText('Artifacts');
    const toggle = screen.getByRole('switch', { name: 'Public in the Library' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: /^(Public|Private)$/ })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('switch', { name: 'Public in the Library' })).toHaveAttribute('aria-checked', 'true');
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
    const [id, update] = onUpdateProject.mock.calls[0];
    expect(id).toBe('p1');
    expect(update({ ...project, publishedAt: undefined })).toMatchObject({ isPublic: true });
    // A setting, not a status: no status tone on it.
    expect(toggle.closest('label')?.className).not.toMatch(/healthy|success|--ds-success/);
  });
});
