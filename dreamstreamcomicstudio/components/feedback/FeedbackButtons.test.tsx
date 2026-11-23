import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('../../services/feedback', () => ({ submitFeedback: vi.fn() }));
import { submitFeedback } from '../../services/feedback';
import { FeedbackButtons } from './FeedbackButtons';

it('shows thanks only after a contextual vote is confirmed persisted', async () => {
  vi.mocked(submitFeedback)
    .mockResolvedValueOnce({ ok: true, persisted: false })
    .mockResolvedValueOnce({ ok: true, persisted: true });
  render(<FeedbackButtons targetType="chat_response" targetId="sample" source="client" />);
  await act(async () => fireEvent.click(screen.getByTitle('This was helpful')));
  expect(screen.queryByText('Thanks!')).toBeNull();
  expect(screen.getByText('Could not save.')).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
  expect(screen.getByText('Thanks!')).toBeInTheDocument();
  expect(vi.mocked(submitFeedback).mock.calls[0]).toEqual(vi.mocked(submitFeedback).mock.calls[1]);
});
