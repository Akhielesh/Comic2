// @vitest-environment jsdom
// Register interest (the sign-in card's "Register interest" step and the comics landing's Register section): the email
// plus a few optional questions that make sense to a visitor (first name, what they would like to make with quick picks
// and "Anything else?", how they heard about us) and one unticked box to be kept updated, then one line that sign-up is
// not open yet. Nothing about other studios. The email alone submits; the answers travel to submitWaitlistEmail once;
// the thank-you promises no email.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.hoisted(() => vi.fn());
vi.mock('../services/waitlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/waitlist')>()),
  submitWaitlistEmail: submit
}));
vi.mock('../services/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => false, buildApiUrl: (p: string) => p, API_BASE_URL: '' }));

import { WaitlistForm } from './WaitlistForm';
import { NEUTRAL_SUCCESS } from '../services/waitlist';
import { INTEREST_THANKS } from '../shared/interest';

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const emailField = () => screen.getByRole('textbox', { name: /Email address/ });
const submitForm = () => fireEvent.submit(emailField().closest('form')!);

beforeEach(() => submit.mockReset());
afterEach(cleanup);

describe('WaitlistForm: register interest', () => {
  const UPDATES_LABEL = 'Keep me updated about Comic Studio news and new DreamStream studios.';

  it('renders exactly the sensible questions: email, first name, what to make, anything else, how they heard, the box', () => {
    const { container } = render(<WaitlistForm kind="access" source="auth-request-access" />);
    expect(emailField()).toBeRequired();
    expect(screen.getByRole('textbox', { name: /First name/ })).not.toBeRequired();
    const makes = screen.getByRole('group', { name: /What would you like to make\?/ });
    const picks = within(makes).getAllByRole('checkbox') as HTMLInputElement[];
    expect(picks.map((b) => b.value)).toEqual(['short_story', 'kids', 'webcomic', 'pitch', 'work']);
    for (const name of ['A short story', 'A comic for kids', 'A webcomic series', 'A pitch or storyboard', 'Something for work']) {
      expect(within(makes).getByRole('checkbox', { name })).not.toBeChecked();
    }
    const other = screen.getByRole('textbox', { name: /Anything else\?/ });
    expect(other).toHaveAttribute('maxLength', '1000');
    expect(other).toHaveAccessibleDescription('Up to 1,000 characters.');
    const heard = screen.getByRole('combobox', { name: /How did you hear about us\?/ }) as HTMLSelectElement;
    expect(heard).toHaveValue('');
    expect([...heard.options].filter((o) => !o.disabled).map((o) => o.text)).toEqual(['LinkedIn', 'A friend', 'Search', 'Social media', 'Other']);
    const updates = screen.getByRole('checkbox', { name: UPDATES_LABEL });
    expect(updates).not.toBeChecked();
    expect(updates).toHaveAccessibleDescription(/Nothing is sent yet/);
    // Exactly these controls, every one optional but the email.
    const controls = [...container.querySelectorAll('input, select, textarea')];
    expect(controls).toHaveLength(10);
    for (const c of controls) if (c !== emailField()) expect(c).not.toBeRequired();
    // Nothing about other studios, and no vague "something else".
    expect(container.textContent).not.toMatch(/Other studios|Chat Studio|Stream Studio|Dashboards|Something else|What would you use/);
    expect(screen.getByText('Sign-up is not open yet. Your answers shape what we build next.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register interest' })).toHaveAttribute('type', 'submit');
  });

  it('the quick picks say their state in shape as well as fill (a mark, aria-checked by the native box)', () => {
    render(<WaitlistForm kind="access" />);
    const pick = screen.getByRole('checkbox', { name: 'A comic for kids' });
    const chip = pick.closest('label')!;
    expect(chip.querySelector('[data-mark="add"]')).not.toBeNull();
    fireEvent.click(pick);
    expect(pick).toBeChecked();
    expect(chip).toHaveAttribute('data-state', 'on');
    expect(chip.querySelector('[data-mark="on"]')).not.toBeNull();
  });

  it('the "Anything else?" counter shows the count near the limit', () => {
    render(<WaitlistForm kind="access" />);
    const comment = screen.getByRole('textbox', { name: /Anything else\?/ });
    fireEvent.change(comment, { target: { value: 'x'.repeat(850) } });
    expect(comment).toHaveAccessibleDescription('850 of 1,000 characters');
  });

  it('the email alone submits, with the box recorded as not ticked', async () => {
    submit.mockResolvedValue({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.access });
    render(<WaitlistForm kind="access" source="auth-request-access" />);
    fireEvent.change(emailField(), { target: { value: 'reader@example.com' } });
    submitForm();
    await settle();
    expect(submit).toHaveBeenCalledWith('reader@example.com', 'access', { source: 'auth-request-access' }, undefined, { keepUpdated: false });
  });

  it('sends the chosen answers once, trimmed, then thanks them without promising an email', async () => {
    submit.mockResolvedValue({ ok: true, status: 'registered', message: INTEREST_THANKS.accessWithAnswers });
    const onJoined = vi.fn();
    render(<WaitlistForm kind="access" source="auth-request-access" onJoined={onJoined} />);
    fireEvent.change(emailField(), { target: { value: 'Reader@Example.com' } });
    fireEvent.change(screen.getByRole('textbox', { name: /First name/ }), { target: { value: ' Asha ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'A pitch or storyboard' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'A comic for kids' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'A short story' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'A short story' }));
    fireEvent.change(screen.getByRole('combobox', { name: /How did you hear about us\?/ }), { target: { value: 'linkedin' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Anything else\?/ }), { target: { value: '  Manga for my class  ' } });
    submitForm();
    await settle();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('Reader@Example.com', 'access', { source: 'auth-request-access' }, undefined, {
      firstName: 'Asha',
      makes: ['pitch', 'kids'],
      heardFrom: 'linkedin',
      comment: 'Manga for my class',
      keepUpdated: false
    });
    const done = screen.getByRole('status');
    expect(done).toHaveTextContent(INTEREST_THANKS.accessWithAnswers);
    expect(done.textContent).not.toMatch(/email|inbox|account|invite/i);
    expect(document.activeElement).toBe(done);
    expect(onJoined).toHaveBeenCalledWith('reader@example.com');
  });

  it('ticking the box sends it as true, and the thank-you says nothing is sent yet', async () => {
    submit.mockResolvedValue({ ok: true, status: 'registered', message: `${INTEREST_THANKS.access} ${INTEREST_THANKS.keptUpdated}` });
    render(<WaitlistForm kind="access" source="landing" />);
    fireEvent.change(emailField(), { target: { value: 'reader@example.com' } });
    fireEvent.click(screen.getByRole('checkbox', { name: UPDATES_LABEL }));
    submitForm();
    await settle();
    expect(submit).toHaveBeenCalledWith('reader@example.com', 'access', { source: 'landing' }, undefined, { keepUpdated: true });
    const done = screen.getByRole('status');
    expect(done).toHaveTextContent(/Nothing is sent yet/);
    expect(done).toHaveTextContent(/when updates start/);
    expect(done.textContent).not.toMatch(/email|inbox|account|invite/i);
  });

  it('a bad email is shown at the field: marked invalid, described, focused; nothing is sent and no other alert shows', async () => {
    for (const kind of ['access', 'updates'] as const) {
      const view = render(<WaitlistForm kind={kind} />);
      const form = emailField().closest('form')!;
      // The form checks the address itself, so the browser's own bubbles never compete with it.
      expect(form).toHaveAttribute('novalidate');
      for (const bad of ['', 'reader', 'reader@example']) {
        fireEvent.change(emailField(), { target: { value: bad } });
        submitForm();
        await settle();
        expect(submit).not.toHaveBeenCalled();
        expect(emailField()).toHaveAttribute('aria-invalid', 'true');
        expect(emailField()).toHaveAccessibleDescription(bad ? 'That email does not look right. Please check it.' : 'Please enter your email address.');
        expect(document.activeElement).toBe(emailField());
        expect(screen.queryByRole('alert')).toBeNull();
      }
      // Editing the address clears the mark.
      fireEvent.change(emailField(), { target: { value: 'reader@example.com' } });
      expect(emailField()).not.toHaveAttribute('aria-invalid');
      view.unmount();
    }
  });

  it('a failure is an honest alert and keeps everything typed', async () => {
    submit.mockResolvedValueOnce({ ok: false, status: 'unavailable', message: 'We could not save that just now. Please try again in a moment.' });
    render(<WaitlistForm kind="access" />);
    fireEvent.change(emailField(), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Anything else\?/ }), { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'A webcomic series' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep me updated/ }));
    submitForm();
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('We could not save that just now.');
    expect(alert.querySelector('svg')).not.toBeNull();
    expect(emailField()).toHaveValue('a@b.co');
    expect(screen.getByRole('textbox', { name: /Anything else\?/ })).toHaveValue('Keep me');
    expect(screen.getByRole('checkbox', { name: 'A webcomic series' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Keep me updated/ })).toBeChecked();
    // Trying again works from the same form.
    submit.mockResolvedValueOnce({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.access });
    submitForm();
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent('Thank you');
  });

  it('kind "updates" is the email alone, with no questions', async () => {
    submit.mockResolvedValue({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.updates });
    render(<WaitlistForm kind="updates" source="home-stay-updated" buttonLabel="Add me to the list" />);
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByText(/Sign-up is not open yet/)).toBeNull();
    fireEvent.change(emailField(), { target: { value: 'a@b.co' } });
    submitForm();
    await settle();
    expect(submit).toHaveBeenCalledWith('a@b.co', 'updates', { source: 'home-stay-updated' }, undefined, {});
    expect(screen.getByRole('status')).toHaveTextContent('Thank you, you are on the list.');
  });
});
