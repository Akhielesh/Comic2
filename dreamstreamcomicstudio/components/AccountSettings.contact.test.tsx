import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORT_EMAIL } from './legal/legalFacts';

// Settings → Contact. Production has no contact_messages table yet, so every save fails today: the
// form must say so and point to the support mailbox, never thank someone for a message nobody got,
// and a double click must not send twice.

const save = vi.hoisted(() => ({ fn: vi.fn(async (_email: string, _message: string): Promise<boolean> => true) }));
vi.mock('../services/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/db')>()),
  savePublicContactMessage: (email: string, message: string) => save.fn(email, message)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'ada@example.com' } }) }));

const { ContactSection } = await import('./AccountSettings');

const THANKS = "Thanks — we'll reply by email.";
const message = () => document.querySelector('textarea') as HTMLTextAreaElement;
const submit = () => screen.getByRole('button', { name: /send message|sending/i });

afterEach(() => {
  save.fn.mockReset();
  save.fn.mockImplementation(async () => true);
});

describe('Settings → Contact', () => {
  it('asks for bugs and feature requests, not billing (DreamStream takes no payments)', () => {
    render(<ContactSection />);
    expect(screen.getByText('Share bugs or feature requests.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/billing/i);
  });

  it('a save that fails shows the error with a mailto link to the support mailbox, and never the thanks line', async () => {
    save.fn.mockResolvedValue(false);
    render(<ContactSection />);
    fireEvent.change(message(), { target: { value: 'The reader skips a page.' } });
    await act(async () => {
      fireEvent.click(submit());
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`We couldn't send that. Please email ${SUPPORT_EMAIL} instead.`);
    expect(screen.getByRole('link', { name: SUPPORT_EMAIL })).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`);
    expect(document.body.textContent).not.toContain(THANKS);
    expect(document.body.textContent).not.toContain('Message Sent!');
    expect(document.body.textContent).not.toContain('Please try again');
    expect(save.fn).toHaveBeenCalledWith('ada@example.com', 'The reader skips a page.');
  });

  it('a save that throws shows the same error (no unhandled rejection, no thanks line)', async () => {
    save.fn.mockRejectedValue(new Error('relation "contact_messages" does not exist'));
    render(<ContactSection />);
    fireEvent.change(message(), { target: { value: 'Hello' } });
    await act(async () => {
      fireEvent.click(submit());
    });
    expect((await screen.findByRole('alert')).textContent).toContain(`Please email ${SUPPORT_EMAIL} instead.`);
    expect(document.body.textContent).not.toContain(THANKS);
    expect(submit()).not.toBeDisabled();
    expect(submit()).not.toHaveAttribute('aria-disabled');
  });

  it('while it sends, Send says so (aria-disabled, aria-busy) but keeps keyboard focus, and a second click or Enter sends nothing more', async () => {
    let finish!: (ok: boolean) => void;
    save.fn.mockImplementation(() => new Promise<boolean>((r) => (finish = r)));
    render(<ContactSection />);
    fireEvent.change(message(), { target: { value: 'Hello' } });
    submit().focus();
    fireEvent.click(submit());
    expect(submit()).toHaveAttribute('aria-disabled', 'true');
    expect(submit()).toHaveAttribute('aria-busy', 'true');
    expect(submit()).not.toBeDisabled();
    expect(document.activeElement).toBe(submit());
    expect(submit().textContent).toContain('Sending');
    fireEvent.click(submit());
    fireEvent.submit(submit().closest('form')!);
    expect(save.fn).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    expect(await screen.findByText(THANKS)).toBeInTheDocument();
    expect(save.fn).toHaveBeenCalledTimes(1);
  });

  it('two submits before the form re-renders (a double Enter) send once', async () => {
    let finish!: (ok: boolean) => void;
    save.fn.mockImplementation(() => new Promise<boolean>((r) => (finish = r)));
    render(<ContactSection />);
    fireEvent.change(message(), { target: { value: 'Hello' } });
    const form = submit().closest('form')!;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(save.fn).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
  });

  it('each label names its field, the failure line uses the readable danger ink, and a sent message clears the form for the next one', async () => {
    save.fn.mockResolvedValueOnce(false);
    render(<ContactSection />);
    expect(screen.getByLabelText('Your Email')).toHaveValue('ada@example.com');
    fireEvent.change(screen.getByLabelText('Phone Number (Optional)'), { target: { value: '555 0100' } });
    fireEvent.change(screen.getByLabelText('Message (300 words max)'), { target: { value: 'Hello' } });
    await act(async () => {
      fireEvent.click(submit());
    });
    const alert = await screen.findByRole('alert');
    expect(alert.className).toContain('text-[var(--ds-danger-text)]');
    expect(alert.className).not.toMatch(/text-red-/);
    await act(async () => {
      fireEvent.click(submit());
    });
    expect(save.fn).toHaveBeenLastCalledWith('ada@example.com', '[Phone: 555 0100]\n\nHello');
    fireEvent.click(await screen.findByRole('button', { name: 'Send another' }));
    expect(screen.getByLabelText('Message (300 words max)')).toHaveValue('');
    expect(screen.getByLabelText('Phone Number (Optional)')).toHaveValue('');
    expect(screen.getByLabelText('Your Email')).toHaveValue('ada@example.com');
  });
});
