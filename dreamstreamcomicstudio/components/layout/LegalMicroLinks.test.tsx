// The one legal and contact block (LegalMicroLinks) and the public footer built around it (SiteFooter): one
// company name ("DreamStream Studio", never "DreamStream Inc."), the legal pages named as they title themselves,
// one contact address on our own domain, and real links that a plain click opens inside the app.
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({ allowed: null as Set<string> | null }));
vi.mock('../../services/productAccess', () => ({ useProductAccess: () => access.allowed }));
vi.mock('../../services/liveLink', () => ({ liveAppUrl: (legacy: string) => legacy, openLiveApp: vi.fn(async () => undefined) }));

const { LegalMicroLinks } = await import('./LegalMicroLinks');
const { SiteFooter } = await import('./SiteFooter');
const { COMPANY_NAME, CONTACT_EMAIL, copyrightLine } = await import('./siteLinks');

afterEach(() => {
  cleanup();
  access.allowed = null;
});

const handlers = () => ({ onOpenPrivacy: vi.fn(), onOpenTerms: vi.fn(), onOpenFaq: vi.fn() });

describe('LegalMicroLinks', () => {
  it('names the company once, the same way everywhere', () => {
    render(<LegalMicroLinks {...handlers()} />);
    const footer = screen.getByRole('contentinfo');
    expect(COMPANY_NAME).toBe('DreamStream Studio');
    expect(footer).toHaveTextContent(copyrightLine());
    expect(copyrightLine(2026)).toBe('© 2026 DreamStream Studio');
    expect(footer.textContent).not.toMatch(/Inc\./);
  });

  it('links the legal pages, the FAQ and contact as real addresses', () => {
    render(<LegalMicroLinks {...handlers()} />);
    const nav = screen.getByRole('navigation', { name: 'Legal and contact' });
    expect(within(nav).getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/?view=privacy');
    expect(within(nav).getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/?view=terms');
    expect(within(nav).getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '/#home-faq');
    expect(within(nav).getByRole('link', { name: 'Contact' })).toHaveAttribute('href', `mailto:${CONTACT_EMAIL}`);
    expect(CONTACT_EMAIL).toMatch(/@dreamstreamstudio\.ai$/);
  });

  it('a plain click opens the page in the app; a new-tab click is left to the browser', () => {
    const h = handlers();
    render(<LegalMicroLinks {...h} />);
    const privacy = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(fireEvent.click(privacy, { ctrlKey: true })).toBe(true);
    expect(h.onOpenPrivacy).not.toHaveBeenCalled();
    expect(fireEvent.click(privacy)).toBe(false);
    expect(h.onOpenPrivacy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'Terms of Service' }));
    expect(h.onOpenTerms).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'FAQ' }));
    expect(h.onOpenFaq).toHaveBeenCalledTimes(1);
  });

  it('links grow to a 44 px hit area under a coarse pointer; no comic chrome', () => {
    render(<LegalMicroLinks {...handlers()} />);
    for (const link of screen.getAllByRole('link')) expect(link.className).toContain('coarse:py-3');
    expect(screen.getByRole('contentinfo').outerHTML).not.toMatch(/border-black|shadow-comic|brand-|font-display|slate-/);
  });

  it('bare: no landmark of its own (inside another footer)', () => {
    render(<LegalMicroLinks bare {...handlers()} />);
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Legal and contact' })).toBeInTheDocument();
  });
});

describe('SiteFooter', () => {
  const renderFooter = () => {
    const props = { ...handlers(), onNavigate: vi.fn(), onEnterStudio: vi.fn() };
    render(<SiteFooter {...props} />);
    return props;
  };

  it('lists the studios (with Atlas Studio) and the public pages, then the shared legal row; one landmark', () => {
    renderFooter();
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1);
    for (const name of ['Comic Studio', 'Chat Studio', 'Stream Studio', 'Atlas Studio', 'How it works', 'Library', 'Models', 'Privacy Policy', 'Terms of Service']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: /^Atlas Studio/ })).toHaveAttribute('href', 'https://atlas.dreamstreamstudio.ai');
    expect(screen.getByRole('contentinfo')).toHaveTextContent(copyrightLine());
  });

  it('opens studios and pages in the app', () => {
    const props = renderFooter();
    fireEvent.click(screen.getByRole('link', { name: /^Comic Studio/ }));
    expect(props.onEnterStudio).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'Library' }));
    expect(props.onNavigate).toHaveBeenCalledWith('gallery');
  });

  it('keeps the studio confinement of the header', () => {
    access.allowed = new Set(['stream_studio']);
    renderFooter();
    expect(screen.queryByRole('link', { name: /^Comic Studio/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Chat Studio/ })).toBeNull();
    expect(screen.getByRole('link', { name: /^Stream Studio/ })).toBeInTheDocument();
  });
});
