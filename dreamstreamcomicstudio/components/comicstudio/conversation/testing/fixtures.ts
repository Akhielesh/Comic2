// Test fixtures for the Comic Studio client: a realistic sample doc and a fake controller.
// (Test-only; not imported by app code.)

import { vi } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Page } from '../../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities';
import type { ComicStudioController } from '../../useStudio';

const NOW = 1_760_000_000_000;

const page = (id: string, n: number, castIds: string[], status: Page['render']['status'] = 'none'): Page => ({
  id,
  n,
  summary: `Page ${n}: Maya chases the thief across the rooftops`,
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [
    { id: `${id}_p1`, n: 1, size: 'wide', shot: 'establishing', action: 'Rain over the rooftops', castIds, lines: [] },
    {
      id: `${id}_p2`,
      n: 2,
      size: 'medium',
      shot: 'medium',
      action: 'Maya leaps',
      castIds,
      lines: [{ id: `${id}_l1`, kind: 'speech', speakerId: castIds[0], text: 'Stop right there!' }]
    }
  ],
  render: status === 'ready' ? { status, history: [], asset: { path: `u/x/p/${id}.webp`, source: 'generated', at: NOW } } : { ...emptyRender(), status },
  balloons: []
});

export const makeSampleDoc = (overrides: Partial<ComicDoc> = {}): ComicDoc => {
  const doc = createEmptyDoc('proj_1', 'Rooftop Heist', NOW);
  return {
    ...doc,
    rev: 5,
    brief: { ...doc.brief, logline: 'A cat burglar meets her match.', notes: [] },
    style: {
      status: 'drafted',
      name: 'Noir ink',
      presetId: 'noir-ink',
      spec: 'High contrast black and white',
      refs: [],
      options: [
        {
          id: 'opt_a',
          name: 'Inky noir',
          spec: 'Heavy blacks',
          render: { status: 'ready', history: [], asset: { path: 'u/x/p/opt_a.webp', source: 'generated', at: NOW }, updatedAt: NOW }
        },
        { id: 'opt_b', name: 'Pastel', spec: 'Soft pastel', render: { status: 'rendering', history: [], updatedAt: NOW } },
        { id: 'opt_c', name: 'Retro', spec: 'Halftone', render: { status: 'failed', history: [], error: 'The model refused this one.', updatedAt: NOW } }
      ]
    },
    cast: [
      {
        id: 'c_maya',
        name: 'Maya',
        role: 'cat burglar',
        tier: 'lead',
        look: { summary: 'Lean woman in a red scarf' },
        refs: [],
        sheet: { status: 'ready', history: [], asset: { path: 'u/x/p/maya.webp', source: 'generated', at: NOW } }
      },
      { id: 'c_arjun', name: 'Arjun', role: 'detective', tier: 'support', look: { summary: 'Bearded man in a trench coat' }, refs: [], sheet: emptyRender() },
      { id: 'c_vendor', name: 'Vendor', tier: 'extra', look: { summary: 'Old fruit seller' }, refs: [], sheet: emptyRender() }
    ],
    pages: [page('pg_1', 1, ['c_maya', 'c_arjun'], 'ready'), page('pg_2', 2, ['c_maya', 'c_arjun']), page('pg_3', 3, ['c_maya'], 'failed')],
    planStatus: 'draft',
    conversation: [],
    ...overrides
  };
};

export type FakeStudio = ComicStudioController & {
  send: ReturnType<typeof vi.fn>;
  act: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  setTab: ReturnType<typeof vi.fn>;
  openPage: ReturnType<typeof vi.fn>;
};

export const makeFakeStudio = (overrides: Partial<ComicStudioController> = {}): FakeStudio => {
  const doc = overrides.doc === undefined ? makeSampleDoc() : overrides.doc;
  return {
    doc,
    loading: false,
    loadError: null,
    busy: false,
    drafts: {},
    activity: [],
    error: null,
    clearError: vi.fn(),
    urlFor: (asset) => {
      const path = typeof asset === 'string' ? asset : asset?.path;
      return path ? `https://cdn.test/${path}` : undefined;
    },
    send: vi.fn(async () => undefined),
    act: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    tab: 'story',
    setTab: vi.fn(),
    focusedPageId: null,
    openPage: vi.fn(),
    isRendering: () => false,
    messageBusy: false,
    pendingMessage: null,
    retryPendingMessage: vi.fn(),
    dismissPendingMessage: vi.fn(),
    cancelling: false,
    refreshing: false,
    lastSpentUsd: null,
    byok: false,
    renderingTotal: 0,
    caps: DEFAULT_CAPS,
    mode: 'easy',
    setMode: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    selection: null,
    setSelection: vi.fn(),
    runNextStep: vi.fn(async () => undefined),
    runClientAction: vi.fn(),
    uploadRef: vi.fn(async () => ({})),
    publication: null,
    refreshPublication: vi.fn(async () => undefined),
    ...overrides
  } as FakeStudio;
};
