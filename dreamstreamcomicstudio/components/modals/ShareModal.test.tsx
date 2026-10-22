// P0-SEC: Comic Studio (v4) comics are shared from the studio Share sheet — the classic
// share modal shows "Publish from the studio" instead of creating a classic share.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));

vi.mock('../../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/apiClient')>()),
  post: api.post,
  get: api.get
}));
vi.mock('./ModalPortal', () => ({ ModalPortal: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import { ApiError } from '../../services/apiClient';
import { ShareModal } from './ShareModal';

beforeEach(() => {
  api.post.mockReset();
  api.get.mockReset();
  api.get.mockResolvedValue({ shares: [] });
});

describe('ShareModal', () => {
  it('shows "Publish from the studio" and no classic share form for a studio comic', async () => {
    render(<ShareModal projectId="p-1" onClose={() => undefined} isStudioV4 />);
    expect(screen.getByTestId('share-use-studio')).toHaveTextContent('Publish from the studio');
    expect(screen.queryByText('Create Share Link')).toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('switches to the studio notice when the server answers 409 USE_STUDIO_SHARE', async () => {
    api.post.mockRejectedValue(new ApiError('Share Comic Studio comics from the studio Share sheet.', 409, { code: 'USE_STUDIO_SHARE' }));
    render(<ShareModal projectId="p-1" onClose={() => undefined} />);
    fireEvent.click(screen.getByText('Create Share Link'));
    await waitFor(() => expect(screen.getByTestId('share-use-studio')).toBeTruthy());
    expect(screen.queryByText('Create Share Link')).toBeNull();
  });

  it('keeps the classic form for classic comics', () => {
    render(<ShareModal projectId="p-1" onClose={() => undefined} />);
    expect(screen.getByText('Create Share Link')).toBeTruthy();
    expect(screen.queryByTestId('share-use-studio')).toBeNull();
  });
});
