// Settings → Tools lists the shared-platform tools (email_draft, deck_create; `rollout: 'platform-docs'`) only for
// a person the rollout admits: platformDocsVisible(useIsAdmin()), i.e. VITE_PLATFORM_DOCS exactly 'on' and the
// stage ('admins' in wave 1). Everyone else sees the catalogue as it was: no rows, and no change to any count.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const admin = vi.hoisted(() => ({ value: true }));
vi.mock('../../hooks/useIsAdmin', () => ({ useIsAdmin: () => admin.value }));

import { ToolsDashboard } from './ToolsDashboard';
import { CATEGORY_META, TOOL_CATALOG } from '../../toolCatalog';

const ROLLOUT = ['email_draft', 'deck_create'];
const everyone = TOOL_CATALOG.filter((t) => !t.rollout);
const productivity = CATEGORY_META.find((c) => c.id === 'productivity')!;

const renderDashboard = async () => {
  await act(async () => {
    render(<ToolsDashboard />);
  });
};
const toolNames = (): string[] => Array.from(document.querySelectorAll('code')).map((c) => c.textContent || '');
const chip = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label} \\(\\d+\\)$`) });

beforeEach(() => {
  admin.value = true;
  // The dashboard reads /api/usage/providers on mount and every 30 s.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ providers: [] }), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ToolsDashboard: rollout tools', () => {
  it('the catalogue has exactly these two rollout tools', () => {
    expect(TOOL_CATALOG.filter((t) => t.rollout === 'platform-docs').map((t) => t.name).sort()).toEqual([...ROLLOUT].sort());
  });

  it('with VITE_PLATFORM_DOCS unset, an admin sees neither row and no count includes them', async () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', '');
    await renderDashboard();
    const names = toolNames();
    for (const name of ROLLOUT) expect(names).not.toContain(name);
    expect(chip('All').textContent).toBe(`All (${everyone.length})`);
    const n = everyone.filter((t) => t.category === 'productivity').length;
    expect(chip(productivity.label).textContent).toContain(`${productivity.label} (${n})`);
    expect(screen.getByText('Live tools').previousElementSibling?.textContent).toBe(String(everyone.length));
  });

  it('with the switch on, a non-admin at stage admins sees neither row', async () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    admin.value = false;
    await renderDashboard();
    for (const name of ROLLOUT) expect(toolNames()).not.toContain(name);
    expect(chip('All').textContent).toBe(`All (${everyone.length})`);
  });

  it("with the switch 'on', an admin sees both rows and the counts include them", async () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    await renderDashboard();
    const names = toolNames();
    for (const name of ROLLOUT) expect(names).toContain(name);
    expect(chip('All').textContent).toBe(`All (${TOOL_CATALOG.length})`);
    const n = TOOL_CATALOG.filter((t) => t.category === 'productivity').length;
    expect(chip(productivity.label).textContent).toContain(`${productivity.label} (${n})`);
    expect(screen.getByText('Live tools').previousElementSibling?.textContent).toBe(String(TOOL_CATALOG.length));
  });
});
