import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const studioApi = vi.hoisted(() => ({ createStudioProject: vi.fn() }));
vi.mock('./comicstudio/studioApi', () => ({ createStudioProject: studioApi.createStudioProject }));

import { OpenInNewStudioBanner } from './ComicEditor';

const PROJECT_ID = '9b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8';

beforeEach(() => {
  studioApi.createStudioProject.mockReset();
  window.localStorage.clear();
});

describe('Classic editor → "new Comic Studio" banner', () => {
  it('imports the story into a new studio comic and opens it', async () => {
    studioApi.createStudioProject.mockResolvedValue({ projectId: 'new-studio-id', doc: { id: 'new-studio-id' }, urls: {} });
    const onOpened = vi.fn();
    render(<OpenInNewStudioBanner projectId={PROJECT_ID} onOpened={onOpened} />);

    expect(screen.getByText("There's a new conversational Comic Studio.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open this story in it' }));
    });

    expect(studioApi.createStudioProject).toHaveBeenCalledWith({ importFromProjectId: PROJECT_ID });
    expect(onOpened).toHaveBeenCalledWith('new-studio-id');
  });

  it('shows the failure and lets the user try again', async () => {
    studioApi.createStudioProject
      .mockRejectedValueOnce(new Error('Your session expired — sign in again to keep working on this comic.'))
      .mockResolvedValueOnce({ projectId: 'second-try', doc: { id: 'second-try' }, urls: {} });
    const onOpened = vi.fn();
    render(<OpenInNewStudioBanner projectId={PROJECT_ID} onOpened={onOpened} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open this story in it' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Your session expired');
    expect(onOpened).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(onOpened).toHaveBeenCalledWith('second-try');
  });

  it('shows progress and ignores double clicks while importing', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    studioApi.createStudioProject.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const onOpened = vi.fn();
    render(<OpenInNewStudioBanner projectId={PROJECT_ID} onOpened={onOpened} />);

    const openButton = screen.getByRole('button', { name: 'Open this story in it' });
    fireEvent.click(openButton);
    fireEvent.click(openButton);
    const busy = await screen.findByRole('button', { name: 'Bringing your story over…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(studioApi.createStudioProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ projectId: 'done', doc: { id: 'done' }, urls: {} });
    });
    expect(onOpened).toHaveBeenCalledWith('done');
  });

  it('remembers a dismissal for that project only', () => {
    const { unmount } = render(<OpenInNewStudioBanner projectId={PROJECT_ID} onOpened={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'New Comic Studio' })).toBeNull();
    unmount();

    render(<OpenInNewStudioBanner projectId={PROJECT_ID} onOpened={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'New Comic Studio' })).toBeNull();

    render(<OpenInNewStudioBanner projectId="another-project" onOpened={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'New Comic Studio' })).toBeInTheDocument();
  });
});
