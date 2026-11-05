// Test-only helpers for the History UI tests (package H5). Never imported by app code.

import React from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { VersionRow } from '../../../shared/comic/history/types';
import { makeFakeStudio, type FakeStudio } from '../conversation/testing/fixtures';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { HistoryApiProvider } from './historyApi';
import { createFakeHistoryApi, type FakeHistoryApi, type FakeHistoryOptions } from './historyApi.fake';
import { HISTORY_NOW, HISTORY_TZ, historyFixture, type HistoryFixtureName } from './__scenes__/historyFixtures';

export const HISTORY_ON: StudioCaps = { ...DEFAULT_CAPS, history: true };

export interface MountOptions {
  fixture?: HistoryFixtureName;
  width?: number;
  height?: number;
  coarse?: boolean;
  reducedMotion?: boolean;
  caps?: StudioCaps;
  api?: Partial<FakeHistoryOptions>;
  studio?: Partial<FakeStudio>;
  lastHistoryVersion?: VersionRow;
}

export interface Mounted {
  studio: FakeStudio;
  api: FakeHistoryApi;
  fixture: ReturnType<typeof historyFixture>;
  wrap(node: React.ReactNode): React.ReactElement;
}

/** A fake studio on a fixture's live book + the fake HistoryApi + a form factor (phone 360×740 by default). */
export const historySetup = (opts: MountOptions = {}): Mounted => {
  const fixture = historyFixture(opts.fixture ?? 'v5');
  const api = createFakeHistoryApi({ live: () => fixture.live, versions: fixture.versions, classic: fixture.classic, ...(opts.api || {}) });
  const studio = makeFakeStudio({ doc: fixture.live, caps: opts.caps ?? HISTORY_ON, ...(opts.studio || {}) }) as FakeStudio;
  if (opts.lastHistoryVersion) (studio as FakeStudio & { lastHistoryVersion?: VersionRow }).lastHistoryVersion = opts.lastHistoryVersion;
  const w = opts.width ?? 360;
  const h = opts.height ?? 740;
  const ff = formFactorFor({ w, h, coarse: opts.coarse ?? w < 840, reducedMotion: !!opts.reducedMotion });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  const wrap = (node: React.ReactNode) => (
    <FormFactorProvider value={ff}>
      <HistoryApiProvider api={api}>{node}</HistoryApiProvider>
    </FormFactorProvider>
  );
  return { studio, api, fixture, wrap };
};

export const mountWith = (m: Mounted, node: React.ReactNode) => render(m.wrap(node));

export { HISTORY_NOW, HISTORY_TZ };

/** Let the fake API's promises and the effects they trigger settle. */
export const settle = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** Every interactive element in a root. */
export const interactive = (root: ParentNode): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), select, textarea, a[href], summary, [role="radio"], [role="menuitem"], [role="tab"]'));

/** A 44 px target: min-h-11/h-11 (or taller), on touch at least, or a documented exemption. */
export const TARGET_RE = /(^|\s)(coarse:)?(min-)?h-(11|12|14|16)(\s|$)/;

/** Fixed widths a 320/360 px phone can't hold (arbitrary px, the Tailwind width scale, inline widths). */
export const overflowProblems = (root: ParentNode, viewport: number): string[] => {
  const limit = viewport - 32; // the 16 px gutters
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    // The shared reader sizes its own page box to the viewport (its own tests own its layout).
    if (el.closest('[data-reader-host]')) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) if (Number(m[1]) > limit) out.push(`${m[0].trim()} in "${cls}"`);
    for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-(\d+)(?=\s|$)/g)) if (Number(m[1]) * 4 > limit) out.push(`${m[0].trim()} in "${cls}"`);
    const w = parseFloat(el.style?.width || '');
    if (Number.isFinite(w) && el.style.width.endsWith('px') && w > limit) out.push(`inline width ${el.style.width}`);
    const mw = parseFloat(el.style?.minWidth || '');
    if (Number.isFinite(mw) && el.style.minWidth.endsWith('px') && mw > limit) out.push(`inline min-width ${el.style.minWidth}`);
    if (/(^|\s)whitespace-nowrap(\s|$)/.test(cls) && !/truncate|min-w-0/.test(cls)) out.push(`nowrap without truncate: "${cls}"`);
  }
  return out;
};

export const fakeAct = () => vi.fn(async () => ({ ok: true, aborted: false, retryable: false, gated: false }));
