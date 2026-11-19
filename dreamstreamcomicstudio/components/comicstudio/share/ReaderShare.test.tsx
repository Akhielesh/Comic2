// The reader's Share (share title page SP-2): Web Share first; else a small ds Menu with Copy link, the existing
// channel intents and LinkedIn; the edition link only after a switch to a non-default edition; one onShared per
// share; 44 px rows; and none of the studio's Share sheet in its code.
import React from 'react';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMICS_ORIGIN } from '../../../services/productHost';
import { DENSITY } from '../../chat/studioDesign';
import { ReaderShare } from './ReaderShare';
import { ShareButton } from './ShareButton';
import { editionLinkFor, linkedinShareUrl, shareLinkFor } from './shareTargets';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
const BARE = `${COMICS_ORIGIN}/c/${SLUG}`;
const TITLE = 'Brick Bridge';

let shareSpy: ReturnType<typeof vi.fn> | undefined;
let writeText: ReturnType<typeof vi.fn>;
const stubNavigator = (share?: (d: ShareData) => Promise<void>) => {
  shareSpy = share ? vi.fn(share) : undefined;
  writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, userAgent: 'test', share: shareSpy, clipboard: { writeText } });
};

// A tapped channel row is a link that opens a new tab: keep jsdom from trying to navigate (after React has run).
const stopNavigation = (e: MouseEvent) => {
  if ((e.target as HTMLElement | null)?.closest?.('a[href]')) e.preventDefault();
};
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  document.addEventListener('click', stopNavigation);
});
afterEach(() => {
  document.removeEventListener('click', stopNavigation);
  cleanup();
  vi.unstubAllGlobals();
});

const trigger = () => screen.getByRole('button', { name: /^Share/ });
const rows = () => screen.getAllByRole('menuitem').map((el) => el.textContent?.trim());
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe('ReaderShare: Web Share first', () => {
  it('hands the link to the system share sheet once, opens no menu, and reports one native share', async () => {
    stubNavigator(async () => undefined);
    const onShared = vi.fn();
    render(<ReaderShare url={`${BARE}?lang=en`} title={TITLE} text="A short logline" onShared={onShared} />);
    fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger());
    await waitFor(() => expect(onShared).toHaveBeenCalledTimes(1));
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(shareSpy).toHaveBeenCalledWith({ title: TITLE, text: 'A short logline', url: `${BARE}?lang=en` });
    expect(onShared).toHaveBeenCalledWith('native');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Enter on the trigger shares too (the keyboard never skips Web Share)', async () => {
    stubNavigator(async () => undefined);
    render(<ReaderShare url={BARE} title={TITLE} />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await flush();
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a closed share sheet is not a share and opens nothing', async () => {
    stubNavigator(async () => {
      throw Object.assign(new Error('closed'), { name: 'AbortError' });
    });
    const onShared = vi.fn();
    render(<ReaderShare url={BARE} title={TITLE} onShared={onShared} />);
    fireEvent.click(trigger());
    await flush();
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(onShared).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a second tap while the share sheet is still open does not share twice', async () => {
    let resolve!: () => void;
    stubNavigator(() => new Promise<void>((r) => (resolve = r)));
    const onShared = vi.fn();
    render(<ReaderShare url={BARE} title={TITLE} onShared={onShared} />);
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(shareSpy).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(onShared).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a Web Share that fails (an in-app browser) falls back to the menu', async () => {
    stubNavigator(async () => {
      throw Object.assign(new Error('nope'), { name: 'NotAllowedError' });
    });
    render(<ReaderShare url={BARE} title={TITLE} />);
    fireEvent.click(trigger());
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });
});

describe('ReaderShare: the fallback menu', () => {
  it('lists Copy link, WhatsApp, X, Telegram, Facebook, Email and LinkedIn, in that order', async () => {
    stubNavigator();
    render(<ReaderShare url={BARE} title={TITLE} />);
    const button = trigger();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(rows()).toEqual(['Copy link', 'WhatsApp', 'X', 'Telegram', 'Facebook', 'Email', 'LinkedIn']);
  });

  it('each channel opens in a new tab with the link tagged by its channel; LinkedIn uses its share page', async () => {
    stubNavigator();
    render(<ReaderShare url={`${BARE}?lang=en`} title={TITLE} />);
    fireEvent.click(trigger());
    await screen.findByRole('menu');
    const href = (name: string) => screen.getByRole('menuitem', { name }).getAttribute('href')!;
    expect(href('Telegram')).toContain('t.me/share/url');
    expect(decodeURIComponent(href('WhatsApp'))).toContain(`${BARE}?lang=en&via=whatsapp`);
    expect(decodeURIComponent(href('X'))).toContain(`${BARE}?lang=en&via=x`);
    expect(href('LinkedIn')).toBe(linkedinShareUrl(`${BARE}?lang=en`));
    for (const name of ['WhatsApp', 'X', 'Telegram', 'Facebook', 'Email', 'LinkedIn']) {
      const el = screen.getByRole('menuitem', { name });
      expect(el.tagName, name).toBe('A');
      if (name !== 'Email') expect(el.getAttribute('target'), name).toBe('_blank');
      expect(el.getAttribute('rel') || '', name).toContain('noopener');
    }
  });

  it('Copy link copies the link, says so, keeps the menu open, and counts one share however often it is tapped', async () => {
    stubNavigator();
    const onShared = vi.fn();
    render(<ReaderShare url={BARE} title={TITLE} onShared={onShared} />);
    fireEvent.click(trigger());
    await screen.findByRole('menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(await screen.findByRole('menuitem', { name: 'Link copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(BARE);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Link copied', { selector: '[aria-live]' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link copied' }));
    await flush();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(onShared).toHaveBeenCalledTimes(1);
    expect(onShared).toHaveBeenCalledWith('copy');
  });

  it('onShared fires once per share: a channel row reports its channel and closes the menu', async () => {
    stubNavigator();
    const onShared = vi.fn();
    render(<ReaderShare url={BARE} title={TITLE} onShared={onShared} />);
    const button = trigger();
    fireEvent.click(button);
    await screen.findByRole('menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'WhatsApp' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(onShared.mock.calls).toEqual([['whatsapp']]);
    fireEvent.click(button);
    await screen.findByRole('menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'LinkedIn' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(onShared.mock.calls).toEqual([['whatsapp'], ['linkedin']]);
  });

  it('opening the menu is not a share; a tap on the trigger while it is open closes it', async () => {
    stubNavigator();
    const onShared = vi.fn();
    render(<ReaderShare url={BARE} title={TITLE} onShared={onShared} />);
    const button = trigger();
    fireEvent.click(button);
    await screen.findByRole('menu');
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(onShared).not.toHaveBeenCalled();
  });

  it('says so when the link cannot be copied', async () => {
    stubNavigator();
    writeText.mockRejectedValue(new Error('denied'));
    const exec = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const onShared = vi.fn();
    render(<ReaderShare url={BARE} title={TITLE} onShared={onShared} />);
    fireEvent.click(trigger());
    await screen.findByRole('menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(await screen.findByRole('menuitem', { name: /Couldn.t copy/ })).toBeInTheDocument();
    expect(onShared).not.toHaveBeenCalled();
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it('every row is 44 px tall and the trigger is a 44 px target', async () => {
    stubNavigator();
    const { unmount } = render(<ReaderShare url={BARE} title={TITLE} compact />);
    const button = trigger();
    expect(button.className).toContain('size-11');
    expect(button).toHaveAttribute('aria-label', 'Share');
    fireEvent.click(button);
    await screen.findByRole('menu');
    for (const row of screen.getAllByRole('menuitem')) expect(row.className, row.textContent || '').toContain(DENSITY.touch);
    unmount();
    render(<ReaderShare url={BARE} title={TITLE} />);
    expect(trigger().className).toContain('h-11');
    expect(trigger()).toHaveTextContent('Share');
  });

  it('opens at once when the page asks (a Share tap recorded before the app was ready)', async () => {
    stubNavigator(async () => undefined);
    render(<ReaderShare url={BARE} title={TITLE} defaultOpen />);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(shareSpy).not.toHaveBeenCalled();
  });

  it('takes its words from the edition on screen', async () => {
    stubNavigator();
    render(<ReaderShare url={BARE} title={TITLE} compact labels={{ share: 'शेयर करें', copyLink: 'लिंक कॉपी करें', copied: 'लिंक कॉपी हो गया' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'शेयर करें' }));
    await screen.findByRole('menu');
    expect(rows()[0]).toBe('लिंक कॉपी करें');
    fireEvent.click(screen.getByRole('menuitem', { name: 'लिंक कॉपी करें' }));
    expect(await screen.findByRole('menuitem', { name: 'लिंक कॉपी हो गया' })).toBeInTheDocument();
  });
});

describe('ReaderShare: the edition link', () => {
  const input = { slug: SLUG, linkLang: 'en', defaultLang: 'te' };
  const mount = (currentLang: string, switched: boolean) => {
    const url = shareLinkFor({ ...input, currentLang, switched })!;
    const edition = editionLinkFor({ ...input, currentLang, switched });
    return render(
      <ReaderShare url={url} title={TITLE} editionLink={edition ? { label: 'Copy link to the हिन्दी edition', url: edition } : undefined} />
    );
  };

  it('shows only after a switch to a non-default edition', async () => {
    stubNavigator();
    for (const [lang, switched] of [
      ['en', false],
      ['te', true]
    ] as const) {
      const { unmount } = mount(lang, switched);
      fireEvent.click(trigger());
      await screen.findByRole('menu');
      expect(rows(), `${lang} ${switched}`).toEqual(['Copy link', 'WhatsApp', 'X', 'Telegram', 'Facebook', 'Email', 'LinkedIn']);
      unmount();
    }
    mount('hi', true);
    fireEvent.click(trigger());
    await screen.findByRole('menu');
    expect(rows()).toEqual(['Copy link', 'Copy link to the हिन्दी edition', 'WhatsApp', 'X', 'Telegram', 'Facebook', 'Email', 'LinkedIn']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(BARE));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link to the हिन्दी edition' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${BARE}?lang=hi`));
  });

  it('with Web Share, the menu opens so the edition stays reachable; its Share… row shares the bare link', async () => {
    stubNavigator(async () => undefined);
    const onShared = vi.fn();
    render(<ReaderShare url={BARE} title={TITLE} editionLink={{ label: 'Copy link to the हिन्दी edition', url: `${BARE}?lang=hi` }} onShared={onShared} />);
    fireEvent.click(trigger());
    await screen.findByRole('menu');
    expect(shareSpy).not.toHaveBeenCalled();
    expect(rows().slice(0, 3)).toEqual(['Share…', 'Copy link', 'Copy link to the हिन्दी edition']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share…' }));
    await waitFor(() => expect(onShared).toHaveBeenCalledWith('native'));
    expect(shareSpy).toHaveBeenCalledWith({ title: TITLE, url: BARE });
  });
});

describe('ShareButton keeps the reader on ReaderShare', () => {
  it('a ShareButton with a target renders ReaderShare (LinkedIn included), never the studio Share sheet', async () => {
    stubNavigator();
    render(<ShareButton target={{ url: BARE, title: TITLE }} compact />);
    fireEvent.click(trigger());
    await screen.findByRole('menu');
    expect(rows()).toEqual(['Copy link', 'WhatsApp', 'X', 'Telegram', 'Facebook', 'Email', 'LinkedIn']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ReaderShare’s own code never reaches the studio Share sheet, the publish panel or the studio API', () => {
    const seen = staticClosure(path.resolve(__dirname, 'ReaderShare.tsx'));
    const rel = [...seen].map((f) => path.relative(path.resolve(__dirname, '../../..'), f));
    expect(rel).toContain('components/comicstudio/share/shareTargets.ts');
    expect(rel).toContain('components/ds/Menu.tsx');
    for (const banned of [
      'components/comicstudio/share/ShareSheet.tsx',
      'components/comicstudio/share/ShareButton.tsx',
      'components/comicstudio/share/PublishPanel.tsx',
      'components/comicstudio/studioApi.ts',
      'components/comicstudio/reader/ComicReaderView.tsx',
      'components/comicstudio/immersive/ImmersiveReader.tsx'
    ]) {
      expect(rel, banned).not.toContain(banned);
    }
  });
});

/** Every app file a module imports statically (type-only imports are erased; `import()` is lazy, so it is skipped). */
function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  const SPEC = /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  const resolveFrom = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (existsSync(cand) && /\.(ts|tsx)$/.test(cand)) return cand;
    }
    return null;
  };
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(SPEC)) {
      const next = resolveFrom(file, m[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}
