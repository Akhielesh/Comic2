// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SignupUsername } from './SignupUsername';
import { checkUsername } from '../services/usernames';
vi.mock('../services/usernames', () => ({ checkUsername: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const signIn = vi.fn();
function Form() {
  const [name, setName] = useState('');
  return <SignupUsername value={name} onChange={setName} onSignIn={signIn} />;
}
it('offers a checked alternative while preserving choice and allows an existing owner to sign in', async () => {
  vi.mocked(checkUsername).mockResolvedValueOnce({ available: false, suggestions: ['Artist_42'] })
    .mockResolvedValueOnce({ available: true, suggestions: [] });
  render(<Form />);
  const field = screen.getByRole('textbox', { name: /Username/ });
  fireEvent.change(field, { target: { value: 'Artist' } });
  const suggestion = await screen.findByRole('button', { name: 'Use Artist_42' });
  expect(field).toHaveValue('Artist');
  await waitFor(() => expect((field as HTMLInputElement).checkValidity()).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in to my account' }));
  expect(signIn).toHaveBeenCalledOnce();
  fireEvent.click(suggestion);
  expect(field).toHaveValue('Artist_42');
  expect(field).toHaveFocus();
  expect(await screen.findByText('That username is available.')).toBeVisible();
  expect((field as HTMLInputElement).checkValidity()).toBe(true);
});
it('ignores a slow response for an abandoned handle', async () => {
  let finish!: (result: { available: boolean; suggestions: string[] }) => void;
  vi.mocked(checkUsername).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ available: true, suggestions: [] });
  render(<Form />);
  const field = screen.getByRole('textbox', { name: /Username/ });
  fireEvent.change(field, { target: { value: 'Before' } });
  await waitFor(() => expect(checkUsername).toHaveBeenCalledOnce());
  fireEvent.change(field, { target: { value: 'After' } });
  await act(async () => finish({ available: false, suggestions: ['Before_2'] }));
  expect(await screen.findByText('That username is available.')).toBeVisible();
  expect(screen.queryByRole('button', { name: /Use Before/ })).toBeNull();
});
