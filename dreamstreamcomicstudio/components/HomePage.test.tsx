// @vitest-environment jsdom
// The home page: honest copy (no placeholders, no stale dates or retired studio, no stage counts, one company
// name), one band per studio with a named motion moment, Chat Studio's access said the way the app enforces it,
// the in-page jumps (no #hash in the address: the app owns the URL), the Atlas look (display face on public
// titles, no comic chrome) and the links each studio really lives at.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));

import { HomePage } from './HomePage';
import { FONT_DISPLAY } from './chat/studioDesign';
import { CHAT_ACCESS_NOTE, FAQ, STUDIO_BANDS } from './landing/content';

const props = () => ({
  onEnterStudio: vi.fn(),
  onViewComics: vi.fn(),
  onOpenPrivacy: vi.fn(),
  onOpenTerms: vi.fn(),
  onNavigate: vi.fn()
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

beforeEach(() => {
  auth.user = null;
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HomePage — copy', () => {
  it('carries no placeholder, stale date, mock model chip, retired studio or stage count', () => {
    const { container } = render(<HomePage {...props()} />);
    const text = container.textContent ?? '';
    for (const stale of [
      /goes here/i,
      /Simulated interface/i,
      /June/i,
      /claude-3/i,
      /sonnet/i,
      /Code Studio/i,
      /Dashboards/i,
      /DreamStream Inc/i,
      /\b(?:four|4|eight|8|nine|9)[- ](?:stage|step)s?\b/i,
      /Try it free/i
    ]) {
      expect(text, String(stale)).not.toMatch(stale);
    }
    expect(text).toMatch(/DreamStream Studio/);
  });

  it('has one band per studio, in order, each with a numbered label and a named motion moment', () => {
    render(<HomePage {...props()} />);
    const ids = STUDIO_BANDS.map((b) => b.id);
    expect(ids).toEqual(['comic-studio', 'stream-studio', 'chat-studio', 'atlas-studio']);
    STUDIO_BANDS.forEach((b, i) => {
      const section = document.getElementById(b.id)!;
      expect(section, b.id).toBeTruthy();
      expect(within(section).getByRole('heading', { level: 2, name: b.title })).toBeInTheDocument();
      expect(section.textContent).toContain(String(i + 1).padStart(2, '0'));
      expect(within(section).getByRole('img', { name: b.momentLabel })).toBeInTheDocument();
    });
  });

  it('names Stream Studio’s baby monitor and family calls, with the monitor’s real privacy sentence', () => {
    const { container } = render(<HomePage {...props()} />);
    const stream = document.getElementById('stream-studio')!;
    expect(stream.textContent).toMatch(/baby monitor/i);
    expect(stream.textContent).toMatch(/Family calls/);
    expect(stream.textContent).toMatch(/never records/i);
    expect(container.textContent).toMatch(/end-to-end encrypted, wherever the network allows/);
    expect(container.textContent).toMatch(/in memory only, never stored, not end-to-end encrypted/);
  });

  it('says Chat Studio is members-only to a signed-out visitor, and the button goes through the app (its sign-in gate)', () => {
    const p = props();
    render(<HomePage {...p} />);
    const chat = document.getElementById('chat-studio')!;
    expect(chat.textContent).toContain(CHAT_ACCESS_NOTE);
    fireEvent.click(within(chat).getByRole('link', { name: 'Sign in to Chat Studio' }));
    expect(p.onNavigate).toHaveBeenCalledWith('chat');
    expect(within(chat).queryByText(/Try/)).toBeNull();
  });

  it('opens Chat Studio for a member, without the access note', () => {
    auth.user = { id: 'u1', email: 'ada@example.com' };
    const p = props();
    render(<HomePage {...p} />);
    const chat = document.getElementById('chat-studio')!;
    expect(chat.textContent).not.toContain(CHAT_ACCESS_NOTE);
    fireEvent.click(within(chat).getByRole('link', { name: /Open Chat Studio/ }));
    expect(p.onNavigate).toHaveBeenCalledWith('chat');
  });

  it('asks four questions, as native disclosures', () => {
    render(<HomePage {...props()} />);
    const faq = document.getElementById('home-faq')!;
    expect(faq.querySelectorAll('details.ds-disclosure')).toHaveLength(FAQ.length);
    expect(FAQ).toHaveLength(4);
  });
});

describe('HomePage — links', () => {
  it('points each studio at where it lives', () => {
    render(<HomePage {...props()} />);
    const stream = document.getElementById('stream-studio')!;
    expect(within(stream).getByRole('link', { name: /Open Stream Studio/ })).toHaveAttribute('href', '/live');
    expect(within(stream).getByRole('link', { name: 'Baby monitor' })).toHaveAttribute('href', '/live#/monitor');
    expect(within(stream).getByRole('link', { name: 'Calls' })).toHaveAttribute('href', '/live#/calls');
    const atlas = document.getElementById('atlas-studio')!;
    expect(within(atlas).getByRole('link', { name: /Visit Atlas Studio/ })).toHaveAttribute('href', 'https://atlas.dreamstreamstudio.ai');
  });

  it('opens Comic Studio through the app off the production host (sign-in when signed out)', () => {
    const p = props();
    render(<HomePage {...p} />);
    fireEvent.click(within(document.getElementById('comic-studio')!).getByRole('button', { name: /Open Comic Studio/ }));
    expect(p.onEnterStudio).toHaveBeenCalledTimes(1);
  });

  it('opens the legal pages through the app on a plain click, with real addresses for a new tab', () => {
    const p = props();
    render(<HomePage {...p} />);
    const footer = screen.getByRole('contentinfo');
    const privacy = within(footer).getByRole('link', { name: 'Privacy Policy' });
    expect(privacy).toHaveAttribute('href', '/?view=privacy');
    fireEvent.click(privacy);
    expect(p.onOpenPrivacy).toHaveBeenCalledTimes(1);
    const terms = within(footer).getByRole('link', { name: 'Terms of Service' });
    expect(terms).toHaveAttribute('href', '/?view=terms');
    fireEvent.click(terms);
    expect(p.onOpenTerms).toHaveBeenCalledTimes(1);
  });

  it('jumps to "Register interest" in place: scrolls, moves focus to the heading, adds no #hash', () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    render(<HomePage {...props()} />);
    const hero = screen.getByRole('heading', { level: 1 }).closest('section')!;
    fireEvent.click(within(hero).getAllByRole('link', { name: /Register interest/ })[0]);
    const heading = screen.getByRole('heading', { level: 2, name: /Hear first about the studios you want/ });
    expect(scrolled).toContain(heading);
    expect(document.activeElement).toBe(heading);
    expect(window.location.hash).toBe('');
  });

  it('keeps the header’s "get updates" anchor (#stay-updated) on the form', () => {
    render(<HomePage {...props()} />);
    const target = document.getElementById('stay-updated');
    expect(target).toBeTruthy();
    expect(document.getElementById('register-interest')!.contains(target)).toBe(true);
  });

  it('offers "Request access" only when the shell wires it, and only to a signed-out visitor', () => {
    const onRequestAccess = vi.fn();
    const { unmount } = render(<HomePage {...props()} onRequestAccess={onRequestAccess} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(onRequestAccess).toHaveBeenCalledTimes(1);
    unmount();
    auth.user = { id: 'u1', email: 'ada@example.com' };
    render(<HomePage {...props()} onRequestAccess={onRequestAccess} />);
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });
});

describe('HomePage — the Atlas look', () => {
  it('sets the hero and every section title in the display face (bridge D2), never Tailwind font-display', () => {
    render(<HomePage {...props()} />);
    const titles = [screen.getByRole('heading', { level: 1 }), ...screen.getAllByRole('heading', { level: 2 })];
    expect(titles.length).toBeGreaterThanOrEqual(7);
    for (const h of titles) expect(h.className.split(/\s+/), h.textContent ?? '').toContain(FONT_DISPLAY);
  });

  it('renders no comic chrome and no hue classes for decoration', async () => {
    const { container } = render(<HomePage {...props()} />);
    await flush();
    const classes = Array.from(container.querySelectorAll('[class]'))
      .flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/))
      .filter(Boolean);
    const legacy = classes.filter((c) => /^(?:.*:)?(?:border-(?:[xytrbl]-)?black|shadow-comic.*|font-comic|font-display|.*brand-(?:yellow|blue|red|black).*)$/.test(c));
    expect(legacy).toEqual([]);
    const hues = classes.filter((c) => /(?:^|:)(?:text|bg|border)-(?:red|amber|yellow|green|emerald|blue|indigo|purple|fuchsia|cyan|orange|slate|zinc)-\d/.test(c));
    expect(hues).toEqual([]);
  });

  it('has one h1 and no image above the fold (the h1 is the largest paint)', () => {
    const { container } = render(<HomePage {...props()} />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});
