// P2-PLATFORM-FOLLOWUP: the chat view's header shows the user's usage left too. ChatConversation
// takes a `headerAccessory` slot rendered first in the right-hand cluster (before the chat-ID menu);
// AIChatPlatform passes the compact usage meter on phones/tablets. Governed users see percent only,
// admins / exempt accounts see nothing, and the phone header keeps one line (the chat-ID button
// folds into its caret menu below `sm`).
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllowanceStatus } from '../../services/usageAllowance';

const allowance = vi.hoisted(() => ({ status: null as AllowanceStatus | null }));
vi.mock('../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));
// The empty-state model suggester and follow-up chips fetch nothing in these tests.
vi.mock('./ChatModelSuggester', () => ({ ChatModelSuggester: () => null }));
vi.mock('./FollowUpChips', () => ({ FollowUpChips: () => null }));

import { ChatConversation } from './ChatConversation';
import { UsageMeter } from '../usage/UsageMeter';
import { createEmptySession } from '../../services/chatStorage';
import { deriveModelFeatures } from '../../services/chatFeatures';

const status = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  enabled: true,
  governed: true,
  pctUsed: 38,
  pctLeft: 62,
  exhausted: false,
  crossed: [30],
  resetsAt: null,
  friendlyUnits: { standardPages: 40, draftPages: 80, pctPerStandardPage: 1.46, label: 'about 40 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false,
  ...over
});

const noop = () => {};
const renderConversation = (headerAccessory?: React.ReactNode) =>
  render(
    <ChatConversation
      session={createEmptySession({ id: 'sess-123', title: 'Lisbon Trip Planning' })}
      features={deriveModelFeatures(null)}
      busy={false}
      sidebarOpen={false}
      onToggleSidebar={noop}
      onOpenModelPicker={noop}
      onSend={noop}
      onStop={noop}
      onBranch={noop}
      onRegenerate={noop}
      onEditUserMessage={noop}
      onSelectVariant={noop}
      onReasoningChange={noop}
      onWebToggle={noop}
      onDreamstreamToggle={noop}
      onToggleConnector={noop}
      mcpServers={[]}
      onToggleMcpServer={noop}
      onRenameTitle={noop}
      suggestModels={[]}
      onStartWithModel={noop}
      headerAccessory={headerAccessory}
    />
  );

describe('ChatConversation header accessory', () => {
  beforeEach(() => {
    allowance.status = null;
    // jsdom has no scrolling; the thread restores its reading position on mount.
    Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
  });

  it('renders the accessory first in the right-hand cluster, before the chat-ID menu', () => {
    renderConversation(<span data-testid="accessory">meter</span>);
    const accessory = screen.getByTestId('accessory');
    const cluster = accessory.parentElement!;
    expect(cluster.className).toContain('ml-auto');
    expect(cluster.className).toContain('shrink-0');
    expect(cluster.firstElementChild).toBe(accessory);
    // The chat-ID menu follows it in the same cluster.
    expect(within(cluster).getByRole('button', { name: 'Chat ID and debug options' })).toBeTruthy();
  });

  it('governed user: the compact usage meter shows percent left — never dollars', () => {
    allowance.status = status();
    renderConversation(<UsageMeter compact />);
    const meter = screen.getByRole('button', { name: /usage left: 62%/i });
    expect(meter.className).toContain('h-11');
    expect(meter.className).toContain('w-11');
    expect(document.body.textContent).not.toMatch(/\$\d/);
    fireEvent.click(meter);
    expect(screen.getByRole('dialog', { name: 'Usage left' })).toBeTruthy();
  });

  it('exhausted governed user: the meter says so (0%), still no dollars', () => {
    allowance.status = status({ pctUsed: 100, pctLeft: 0, exhausted: true, crossed: [30, 70, 90, 100] });
    renderConversation(<UsageMeter compact={false} />);
    expect(screen.getByRole('button', { name: /usage left/i }).textContent).toContain('Usage used up');
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('admins / exempt accounts and an unavailable backend: no meter at all', () => {
    allowance.status = status({ governed: false });
    const { unmount } = renderConversation(<UsageMeter compact />);
    expect(screen.queryByRole('button', { name: /usage left/i })).toBeNull();
    unmount();
    allowance.status = null;
    renderConversation(<UsageMeter compact />);
    expect(screen.queryByRole('button', { name: /usage left/i })).toBeNull();
  });

  it('without an accessory the header is unchanged (prop is optional)', () => {
    renderConversation();
    expect(screen.getByRole('button', { name: 'Chat ID and debug options' })).toBeTruthy();
  });

  it('phones: the chat-ID button folds into the caret menu, which still copies the ID', () => {
    renderConversation(<UsageMeter compact />);
    const idButton = screen.getByRole('button', { name: 'Copy chat ID' });
    expect(idButton.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(idButton.className).toContain('sm:flex');
    const caret = screen.getByRole('button', { name: 'Chat ID and debug options' });
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    // The menu's first item is "Copy chat ID" (plus the desktop-only button, hidden by CSS on phones).
    expect(screen.getAllByRole('button', { name: /Copy chat ID$/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Copy full debug bundle/ })).toBeTruthy();
  });
});

describe('AIChatPlatform wiring', () => {
  it('passes the compact usage meter to the chat view header (refreshed after each turn)', () => {
    const source = readFileSync(join(__dirname, 'AIChatPlatform.tsx'), 'utf8');
    expect(source).toContain('headerAccessory={<UsageMeter compact={!isDesktop} refreshKey={usageRefreshKey} />}');
    // The refresh key only moves when a generation ends — no timer.
    expect(source).toMatch(/if \(!on\) setUsageRefreshKey\(\(k\) => k \+ 1\)/);
  });
});
