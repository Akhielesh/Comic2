// @vitest-environment jsdom
// The one side panel (SH-C1) in the frame around My comics, New comic and Images, and as the studio renders it: open and
// collapse to the slim rail, the remembered choice (and storage that fails), keyboard and focus order, the phone drawer,
// and the one fill per view.
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types';
import { ComicWorkspaceFrame, type ComicProjectNavigationProps } from '../ComicCreationWorkspace';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { ComicSidePanel } from './ComicSidePanel';
import { ComicSection } from './ComicSection';
import { PANEL_PREFERENCE_KEY, readPanelOpen, resetPanelPreferenceForTests, usePanelOpen, writePanelOpen } from './panelPreference';
import { PANEL_ROW_CURRENT, PANEL_ROW_INK } from './panelStyles';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { stageFacts } from '../../../shared/comic/stage';

vi.mock('../../account/AccountMenu', () => ({ AccountMenu: () => <button type="button">Account</button> }));

const NOW = Date.now();
const project = (id: string, name: string, at: number): Project => ({ id, name, createdAt: at, updatedAt: at, state: { studioVersion: 4 } }) as unknown as Project;
const links = (extra: Partial<ComicProjectNavigationProps> = {}): ComicProjectNavigationProps => ({
  projects: [project('a', 'Salt Road', NOW - 1000), project('b', 'Glass Harbour', NOW - 5000)],
  activeView: 'all',
  onNewComic: vi.fn(),
  onImages: vi.fn(),
  onChat: vi.fn(),
  onAllComics: vi.fn(),
  onLibrary: vi.fn(),
  onOpenProject: vi.fn(),
  onOpenStudioWork: vi.fn(),
  ...extra
});
const WIDE = formFactorFor({ w: 1440, h: 900 });
const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });
const framed = (ff: ReturnType<typeof formFactorFor>, navigation: ComicProjectNavigationProps) => (
  <FormFactorProvider value={ff}>
    <ComicWorkspaceFrame title="All comics" navigation={navigation} onHome={vi.fn()}>
      <p>Content</p>
    </ComicWorkspaceFrame>
  </FormFactorProvider>
);
const frame = (ff = WIDE, navigation = links()) => render(framed(ff, navigation));
const panel = () => screen.getByRole('navigation', { name: 'Project navigation' });

beforeEach(() => {
  localStorage.clear();
  resetPanelPreferenceForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the frame’s side panel: open, rail, remembered', () => {
  it('opens beside the page, collapses to a slim rail under the header, and remembers the choice', () => {
    const first = frame();
    expect(panel()).toHaveAttribute('data-comic-panel', 'open');
    // From the top: where you are, your comics, then Go to.
    const sections = [within(panel()).getByRole('list', { name: 'Where you are' }), within(panel()).getByRole('group', { name: 'Your comics' }), within(panel()).getByRole('list', { name: 'Go to' })];
    for (let i = 1; i < sections.length; i += 1) expect(sections[i - 1].compareDocumentPosition(sections[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sections[2]).getAllByRole('button').map((b) => b.textContent)).toEqual(['New comic', 'Images', 'Chat', 'Library', 'Report a problem']);
    expect(within(sections[2]).getByRole('link', { name: 'Studio guide' })).toHaveAttribute('href', '/?tour=1');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse project navigation' }));
    const rail = panel();
    expect(rail).toHaveAttribute('data-comic-panel', 'rail');
    expect(rail.closest('aside')?.className).toContain('comic-workspace-rail');
    for (const name of ['My comics', 'New comic', 'Images', 'Chat', 'Library']) expect(within(rail).getByRole('button', { name })).toHaveAttribute('title', name);
    expect(within(rail).queryByRole('group', { name: 'Your comics' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand project navigation' })).toHaveAttribute('aria-controls', rail.id);
    expect(localStorage.getItem(PANEL_PREFERENCE_KEY)).toBe('closed');
    first.unmount();
    frame();
    expect(panel()).toHaveAttribute('data-comic-panel', 'rail');
  });

  it('remembers the choice per viewer', () => {
    writePanelOpen('viewer-a', false);
    expect(readPanelOpen('viewer-a', 1440)).toBe(false);
    expect(readPanelOpen('viewer-b', 1440)).toBe(true);
    expect(localStorage.getItem(`${PANEL_PREFERENCE_KEY}.viewer-a`)).toBe('closed');
    // The studio's wide-desktop default; the frame passes its own docking width.
    expect(readPanelOpen('viewer-b', 1100)).toBe(false);
    expect(readPanelOpen('viewer-b', 1100, 900)).toBe(true);
  });

  it('with no choice yet the default follows the window: an iPad turned to landscape docks the panel open', () => {
    const navigation = links();
    const view = render(framed(formFactorFor({ w: 820, h: 1180, coarse: true }), navigation));
    expect(screen.queryByRole('navigation', { name: 'Project navigation' })).toBeNull();
    view.rerender(framed(formFactorFor({ w: 1180, h: 820, coarse: true }), navigation));
    expect(panel()).toHaveAttribute('data-comic-panel', 'open');
    // The studio's default: the rail at 1024 px, open once the window is a wide desktop; a choice then holds.
    const studio = renderHook(({ width }) => usePanelOpen('viewer', width), { initialProps: { width: 1024 } });
    expect(studio.result.current[0]).toBe(false);
    studio.rerender({ width: 1440 });
    expect(studio.result.current[0]).toBe(true);
    act(() => studio.result.current[1](false));
    studio.rerender({ width: 1600 });
    expect(studio.result.current[0]).toBe(false);
    expect(localStorage.getItem(`${PANEL_PREFERENCE_KEY}.viewer`)).toBe('closed');
  });

  it('when storage throws on read and on write, it opens by default, still toggles, and keeps the choice for the session', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const first = frame();
    expect(panel()).toHaveAttribute('data-comic-panel', 'open');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse project navigation' }));
    expect(panel()).toHaveAttribute('data-comic-panel', 'rail');
    first.unmount();
    frame();
    expect(panel()).toHaveAttribute('data-comic-panel', 'rail');
    fireEvent.click(screen.getByRole('button', { name: 'Expand project navigation' }));
    expect(panel()).toHaveAttribute('data-comic-panel', 'open');
  });

  it('marks where you are once, and New comic is the one fill on All comics only', () => {
    const all = frame();
    const here = within(panel()).getByRole('list', { name: 'Where you are' });
    expect(within(here).getByRole('button', { name: 'My comics' })).toHaveAttribute('aria-current', 'page');
    expect(panel().querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(panel().querySelectorAll('[data-panel-fill]')).toHaveLength(1);
    expect(within(panel()).getByRole('button', { name: 'New comic' })).toHaveAttribute('data-panel-fill', 'true');
    all.unmount();
    frame(WIDE, links({ activeView: 'images' }));
    const images = within(panel()).getByRole('list', { name: 'Where you are' });
    expect(within(images).getByRole('button', { name: 'Back to My comics' })).not.toHaveAttribute('aria-current');
    expect(within(images).getByText('Images').closest('li')).toHaveAttribute('aria-current', 'page');
    // Go to's Images looks current, but "Where you are" is the one current-page mark a screen reader hears.
    const goImages = within(within(panel()).getByRole('list', { name: 'Go to' })).getByRole('button', { name: 'Images' });
    expect(goImages).not.toHaveAttribute('aria-current');
    expect(goImages).toHaveAttribute('data-panel-current', 'true');
    expect(goImages.className).toContain(PANEL_ROW_CURRENT.split(' ')[0]);
    expect(panel().querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(panel().querySelectorAll('[data-panel-fill]')).toHaveLength(0);
    // The rail has no "Where you are": there its Images is the current page.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse project navigation' }));
    expect(within(panel()).getByRole('button', { name: 'Images' })).toHaveAttribute('aria-current', 'page');
    expect(panel().querySelectorAll('[aria-current]')).toHaveLength(1);
  });
});

describe('keyboard, focus order and the phone drawer', () => {
  const doc = makeSampleDoc();
  const comicPanel = (onSelect = vi.fn()) =>
    render(
      <ComicSidePanel
        place="comic"
        links={links({ activeView: undefined })}
        onMyComics={vi.fn()}
        comic={{ id: doc.id, title: doc.brief.title, facts: stageFacts(doc) }}
        comicSection={<ComicSection doc={doc} caps={DEFAULT_CAPS} tab="pages" facts={stageFacts(doc)} onSelect={onSelect} onConversation={vi.fn()} onGo={vi.fn()} />}
      />
    );
  const tabbable = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]')).filter((el) => el.tabIndex >= 0 && !el.hidden);

  it('reads top to bottom: where you are, this comic (next step, Ask, the open tab), your comics, Go to', () => {
    comicPanel();
    // One current-page mark (the comic's title in Where you are); Ask the Director tints under the pointer as every row.
    expect(panel().querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(within(panel()).getByRole('button', { name: 'Ask the Director' }).className).toContain(PANEL_ROW_INK.split(' ').find((c) => c.startsWith('hover:'))!);
    const names = tabbable(panel()).map((el) => el.getAttribute('aria-label') || el.textContent);
    const at = (name: string | RegExp) => names.findIndex((n) => (typeof name === 'string' ? n === name : name.test(n ?? '')));
    const order = [at('Back to My comics'), at(/Next: /), at('Ask the Director'), at('Pages'), at(/^Salt Road/), at('New comic'), at('Report a problem')];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // One tab stop for the board (roving focus): only the open tab is in the tab order.
    expect(names.filter((n) => ['Story', 'Cast', 'Style', 'Read'].includes(n ?? ''))).toEqual([]);
  });

  it('arrow keys, Home and End move along the board tabs without opening them', () => {
    const onSelect = vi.fn();
    comicPanel(onSelect);
    const tabs = within(panel()).getAllByRole('tab');
    const pages = within(panel()).getByRole('tab', { name: 'Pages' });
    pages.focus();
    fireEvent.keyDown(pages, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tabs[tabs.indexOf(pages) + 1]);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(tabs[0]);
    expect(onSelect).toHaveBeenCalledWith(tabs[0].id.replace('board-tab-', ''));
  });

  it('on a phone the panel is a drawer: it takes focus, Escape returns it to the toggle, and a choice closes it', () => {
    const navigation = links();
    frame(PHONE, navigation);
    expect(screen.queryByRole('navigation', { name: 'Project navigation' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Open project navigation' });
    expect(toggle).toHaveAttribute('aria-haspopup', 'dialog');
    toggle.focus();
    fireEvent.click(toggle);
    const drawer = screen.getByRole('dialog', { name: 'Project navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(drawer.className).toContain('comic-workspace-drawer');
    expect(within(drawer).getByRole('navigation', { name: 'Project navigation' })).toHaveAttribute('data-comic-panel', 'open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Project navigation' })).getByRole('link', { name: /^Glass Harbour/ }));
    expect(navigation.onOpenStudioWork).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Project navigation' })).getByRole('button', { name: 'Chat' }));
    expect(navigation.onChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('every row is a 44 px target and long titles clip to the panel’s width (no sideways scroll at 360 px)', () => {
    const long = 'A very long comic title that would never fit beside the stage marks of a phone drawer';
    frame(PHONE, links({ projects: [project('a', long, NOW)] }));
    fireEvent.click(screen.getByRole('button', { name: 'Open project navigation' }));
    const row = within(screen.getByRole('dialog', { name: 'Project navigation' })).getByRole('link', { name: new RegExp(`^${long}`) });
    expect(row).toHaveAttribute('title', long);
    expect(row.className).toMatch(/(?:^|\s)min-h-11(?:\s|$)/);
    expect(row.className).toMatch(/(?:^|\s)min-w-0(?:\s|$)/);
    expect(row.querySelector('.truncate')?.textContent).toBe(long);
  });
});
