// @vitest-environment jsdom
// The legal line under every non-studio page on both hosts: Privacy, Terms, FAQs (only where there is a FAQ to open)
// and Contact, which writes to the routed support mailbox (components/legal/contacts.ts), never contact@.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORT_EMAIL } from '../legal/contacts';
import { CONTACT_HREF, LegalMicroLinks } from './LegalMicroLinks';

afterEach(cleanup);

describe('LegalMicroLinks', () => {
  it('Contact writes to support@dreamstreamstudio.ai (the address spelled out, so a wrong constant cannot pass)', () => {
    const { container } = render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', 'mailto:support@dreamstreamstudio.ai');
    expect(CONTACT_HREF).toBe('mailto:support@dreamstreamstudio.ai');
    expect(SUPPORT_EMAIL).toBe('support@dreamstreamstudio.ai');
    expect(container.innerHTML).not.toMatch(/contact@/);
  });

  it('runs Privacy, Terms and FAQs in-app', () => {
    const h = { onOpenPrivacy: vi.fn(), onOpenTerms: vi.fn(), onOpenFaq: vi.fn() };
    render(<LegalMicroLinks {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Privacy Policy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terms & Conditions' }));
    fireEvent.click(screen.getByRole('button', { name: 'FAQs' }));
    expect(h.onOpenPrivacy).toHaveBeenCalledTimes(1);
    expect(h.onOpenTerms).toHaveBeenCalledTimes(1);
    expect(h.onOpenFaq).toHaveBeenCalledTimes(1);
  });

  it('offers no FAQs where there is none to open (the comics host passes no handler)', () => {
    render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'FAQs' })).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Privacy Policy', 'Terms & Conditions']);
  });

  it('every link carries the 44 × 44 coarse-pointer floor and the focus ring, on the page tokens', () => {
    render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    for (const el of [...screen.getAllByRole('button'), screen.getByRole('link', { name: 'Contact' })]) {
      const cls = el.className.split(/\s+/);
      expect(cls, el.textContent!).toEqual(expect.arrayContaining(['coarse:min-h-[var(--ds-density-touch)]', 'coarse:min-w-[var(--ds-density-touch)]', 'rounded-[var(--ds-radius-sm)]']));
      expect(el.className, el.textContent!).toMatch(/focus-visible:outline-\[color:var\(--ds-focus\)\]/);
    }
  });
});
