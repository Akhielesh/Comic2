// @vitest-environment jsdom
// Register interest (the sign-in card's "Register interest" step): the email plus a few optional
// questions (first name, the Comic Studio feature checklist, something else, the other studios the
// form already offered, a comment with a visible limit) and one line that sign-up is not open yet. The email alone submits; the answers
// travel to submitWaitlistEmail once; the thank-you promises no email.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const emailField = () => screen.getByRole('textbox', { name: /Email address/ });
const submitForm = () => fireEvent.submit(emailField().closest('form')!);

beforeEach(() => submit.mockReset());
afterEach(cleanup);

describe('WaitlistForm: register interest', () => {
  it('asks the optional questions with real Comic Studio abilities and says sign-up is not open yet', () => {
    render(<WaitlistForm kind="access" source="auth-request-access" />);
    expect(emailField()).toBeRequired();
    expect(screen.getByRole('textbox', { name: /First name/ })).not.toBeRequired();
    const group = screen.getByRole('group', { name: /What would you use\?/ });
    const boxes = Array.from(group.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.map((b) => b.value)).toEqual(['chat', 'translations', 'series', 'library', 'print']);
    for (const name of [
      'Making a comic by chatting',
      'Translations into other languages',
      'Series and collections',
      'Publishing to the public Library',
      'Printing and export'
    ]) {
      expect(screen.getByRole('checkbox', { name })).not.toBeChecked();
    }
    expect(screen.getByRole('textbox', { name: /Something else/ })).toHaveAttribute('maxLength', '120');
    const others = screen.getByRole('group', { name: /Other studios you would try/ });
    expect(Array.from(others.querySelectorAll('input[type="checkbox"]')).map((b) => (b as HTMLInputElement).value)).toEqual([
      'chat_studio',
      'code_studio',
      'stream_studio',
      'dashboards'
    ]);
    // Every question is optional: only the email is required.
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeRequired();
    expect(screen.getByRole('textbox', { name: /Something else/ })).not.toBeRequired();
    const comment = screen.getByRole('textbox', { name: /Anything you would like to tell us/ });
    expect(comment).toHaveAttribute('maxLength', '1000');
    expect(comment).toHaveAccessibleDescription('Up to 1,000 characters.');
    expect(screen.getByText('Sign-up is not open yet. Your answers shape what we build next.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register interest' })).toHaveAttribute('type', 'submit');
  });

  it('the comment counter shows the count near the limit', () => {
    render(<WaitlistForm kind="access" />);
    const comment = screen.getByRole('textbox', { name: /Anything you would like to tell us/ });
    fireEvent.change(comment, { target: { value: 'x'.repeat(850) } });
    expect(comment).toHaveAccessibleDescription('850 of 1,000 characters');
  });

  it('the email alone submits, with no answers', async () => {
    submit.mockResolvedValue({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.access });
    render(<WaitlistForm kind="access" source="auth-request-access" />);
    fireEvent.change(emailField(), { target: { value: 'reader@example.com' } });
    submitForm();
    await settle();
    expect(submit).toHaveBeenCalledWith('reader@example.com', 'access', { source: 'auth-request-access' }, undefined, {});
  });

  it('sends the chosen answers once, trimmed, then thanks them without promising an email', async () => {
    submit.mockResolvedValue({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.access });
    const onJoined = vi.fn();
    render(<WaitlistForm kind="access" source="auth-request-access" onJoined={onJoined} />);
    fireEvent.change(emailField(), { target: { value: 'Reader@Example.com' } });
    fireEvent.change(screen.getByRole('textbox', { name: /First name/ }), { target: { value: ' Asha ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Translations into other languages' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Printing and export' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Making a comic by chatting' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Making a comic by chatting' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Something else/ }), { target: { value: ' Voice acting ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dashboards' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Anything you would like/ }), { target: { value: '  Manga for my class  ' } });
    submitForm();
    await settle();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('Reader@Example.com', 'access', { source: 'auth-request-access' }, undefined, {
      firstName: 'Asha',
      features: ['translations', 'print'],
      featureOther: 'Voice acting',
      studios: ['dashboards'],
      comment: 'Manga for my class'
    });
    const done = screen.getByRole('status');
    expect(done).toHaveTextContent('Thank you, you are on the list.');
    expect(done.textContent).not.toMatch(/email|inbox|account|invite/i);
    expect(document.activeElement).toBe(done);
    expect(onJoined).toHaveBeenCalledWith('reader@example.com');
  });

  it('a failure is an honest alert and keeps everything typed', async () => {
    submit.mockResolvedValueOnce({ ok: false, status: 'unavailable', message: 'We could not save that just now. Please try again in a moment.' });
    render(<WaitlistForm kind="access" />);
    fireEvent.change(emailField(), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Anything you would like/ }), { target: { value: 'Keep me' } });
    submitForm();
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('We could not save that just now.');
    expect(alert.querySelector('svg')).not.toBeNull();
    expect(emailField()).toHaveValue('a@b.co');
    expect(screen.getByRole('textbox', { name: /Anything you would like/ })).toHaveValue('Keep me');
    // Trying again works from the same form.
    submit.mockResolvedValueOnce({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.access });
    submitForm();
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent('Thank you');
  });

  it('kind "updates" is the email alone, with no questions', async () => {
    submit.mockResolvedValue({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.updates });
    render(<WaitlistForm kind="updates" source="home-stay-updated" buttonLabel="Keep me posted" />);
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByText(/Sign-up is not open yet/)).toBeNull();
    fireEvent.change(emailField(), { target: { value: 'a@b.co' } });
    submitForm();
    await settle();
    expect(submit).toHaveBeenCalledWith('a@b.co', 'updates', { source: 'home-stay-updated' }, undefined, {});
    expect(screen.getByRole('status')).toHaveTextContent('Thank you, you are on the list.');
  });
});
