import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReadReplyAloud } from './ReadReplyAloud';

const synth = { getVoices: vi.fn(), speak: vi.fn(), cancel: vi.fn() };
beforeEach(() => {
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it('reads only on an explicit action using a local voice, then stops on leaving the reply', () => {
  const voice = { name: 'Local', localService: true, lang: 'en-US' };
  synth.getVoices.mockReturnValue([{ name: 'Online', localService: false }, voice]);
  const view = render(<ReadReplyAloud text="A private answer." />);
  expect(synth.speak).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read reply aloud' }));
  expect(synth.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'A private answer.', voice }));
  expect(screen.getByRole('button', { name: 'Stop reading reply' })).toHaveAttribute('aria-pressed', 'true');
  view.unmount();
  expect(synth.cancel).toHaveBeenCalledOnce();
});

it('gives local-voice setup guidance without sending the reply to an online voice', () => {
  synth.getVoices.mockReturnValue([{ name: 'Online', lang: 'en-US', localService: false }]);
  render(<ReadReplyAloud text="Another answer." />);
  fireEvent.click(screen.getByRole('button', { name: 'Read reply aloud' }));
  expect(screen.getByRole('status')).toHaveTextContent('Install a voice on this device');
  expect(synth.speak).not.toHaveBeenCalled();
});
