// @vitest-environment jsdom
// The account menu's trigger (navtheme NT-1): the person's initial (or photo once read), 44 px, named "Account and
// settings"; Appearance alone while signed out. The panel is its own chunk, loaded on the first open, pointer-enter or
// focus, and nothing reaches the network while the menu sits closed.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const panel = vi.hoisted(() => ({ loads: 0, props: [] as Array<Record<string, unknown>> }));
vi.mock('./AccountPanel', () => {
  panel.loads += 1;
  const AccountPanel = (props: Record<string, unknown>) => {
    panel.props.push(props);
    return <div role="dialog" aria-label="Account and settings" data-testid="panel" />;
  };
  return { AccountPanel, default: AccountPanel };
});
const db = vi.hoisted(() => ({ getProfileFace: vi.fn() }));
vi.mock('../../services/db', () => ({ getProfileFace: db.getProfileFace }));

import { AccountMenu } from './AccountMenu';
import { AccountProvider, forgetRememberedProfiles, rememberProfile, type AccountContextValue } from './AccountContext';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const value = (over: Partial<AccountContextValue> = {}): AccountContextValue => ({
  person: { id: 'person-1', name: 'Ada Example', initial: 'A' },
  staff: false,
  onSignedOut: () => undefined,
  ...over
});

const fetchSpy = vi.fn(async () => new Response('{}'));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  db.getProfileFace.mockReset();
  panel.props.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetRememberedProfiles();
  localStorage.clear();
});

describe('AccountMenu', () => {
  it('signed out it is the Appearance button alone', () => {
    render(
      <AccountProvider value={value({ person: null })}>
        <AccountMenu paper />
      </AccountProvider>
    );
    expect(screen.getByRole('button', { name: 'Appearance: Light' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account and settings' })).toBeNull();
    // Outside any provider (an embed) it is signed out too.
    cleanup();
    render(<AccountMenu />);
    expect(screen.getByRole('button', { name: 'Appearance: Light' })).toBeInTheDocument();
  });

  it('signed in it is a 44 px round trigger with the initial, named for what it opens', () => {
    render(
      <AccountProvider value={value()}>
        <AccountMenu paper />
      </AccountProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Account and settings' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger.textContent).toBe('A');
    expect(trigger.className.split(/\s+/)).toEqual(expect.arrayContaining(['size-11']));
    expect(screen.queryByRole('button', { name: /^Appearance/ })).toBeNull();
  });

  it('shows the photo once the panel has read it (no read of its own)', () => {
    rememberProfile('person-1', { username: 'ada', avatarUrl: 'https://cdn.test/ada.webp' });
    const { container } = render(
      <AccountProvider value={value()}>
        <AccountMenu />
      </AccountProvider>
    );
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', 'https://cdn.test/ada.webp');
    expect(img).toHaveAttribute('alt', '');
  });

  it('loads the panel only on the first open, pointer-enter or focus', async () => {
    render(
      <AccountProvider value={value()}>
        <AccountMenu paper resume="new-comic" />
      </AccountProvider>
    );
    expect(panel.loads).toBe(0);
    const trigger = screen.getByRole('button', { name: 'Account and settings' });
    await act(async () => {
      fireEvent.pointerEnter(trigger);
      await Promise.resolve();
    });
    expect(panel.loads).toBe(1);
    expect(screen.queryByTestId('panel')).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByTestId('panel')).toBeInTheDocument();
    expect(panel.props.at(-1)).toMatchObject({ paper: true, resume: 'new-comic', presentation: 'anchored' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // The trigger names the panel it controls.
    expect(trigger).toHaveAttribute('aria-controls', panel.props.at(-1)?.id as string);
  });

  it('makes no request while it sits closed (no fetch, no profile read), hovered and focused included', async () => {
    render(
      <AccountProvider value={value()}>
        <AccountMenu paper />
      </AccountProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Account and settings' });
    await act(async () => {
      fireEvent.pointerEnter(trigger);
      fireEvent.focus(trigger);
      await Promise.resolve();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getProfileFace).not.toHaveBeenCalled();
  });

  it('tells its host when it opens and closes (one overlay at a time)', async () => {
    const onOpenChange = vi.fn();
    render(
      <AccountProvider value={value()}>
        <AccountMenu onOpenChange={onOpenChange} />
      </AccountProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Account and settings' });
    fireEvent.click(trigger);
    await screen.findByTestId('panel');
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    act(() => (panel.props.at(-1)?.onClose as () => void)());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the panel out of its own module: only a dynamic import reaches it', () => {
    const src = readFileSync(path.join(HERE, 'AccountMenu.tsx'), 'utf8');
    expect(src).not.toMatch(/^import[^;]*from '\.\/AccountPanel'/m);
    expect(src).toMatch(/import\('\.\/AccountPanel'\)/);
    // Nor anything the panel alone needs (the sheet, the profile read).
    expect(src).not.toMatch(/from '\.\.\/\.\.\/services\/db'|comicstudio\/mobile/);
  });

  it('the panel and the trigger share the face through its own module, never through each other (no import cycle)', () => {
    const panelSrc = readFileSync(path.join(HERE, 'AccountPanel.tsx'), 'utf8');
    expect(panelSrc).not.toMatch(/from '\.\/AccountMenu'/);
    expect(panelSrc).toMatch(/import \{ AccountFace \} from '\.\/AccountFace'/);
    expect(readFileSync(path.join(HERE, 'AccountMenu.tsx'), 'utf8')).toMatch(/import \{ AccountFace \} from '\.\/AccountFace'/);
  });
});
