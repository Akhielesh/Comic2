import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: 'admin-one', bearer: vi.fn(async (owner: string) => 'Bearer ' + owner) }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: auth.owner ? { id: auth.owner } : null })
}));
vi.mock('../../services/accountProviderUsage', () => ({ ownerBearer: auth.bearer }));
vi.mock('../../services/clientConfig', () => ({ buildApiUrl: (path: string) => path }));
import { ReportScreenshots } from './ReportScreenshots';

afterEach(() => {
  vi.unstubAllGlobals();
  auth.owner = 'admin-one';
});

it('retrieves only the selected attachment on demand and removes its preview on sign-out', async () => {
  const read = vi.fn(
    async () => new Response(new Blob(['fixture']), { headers: { 'Content-Type': 'image/webp' } })
  );
  const release = vi.fn();
  vi.stubGlobal('fetch', read);
  const RealUrl = URL;
  vi.stubGlobal(
    'URL',
    class extends RealUrl {
      static createObjectURL = () => 'blob:fixture';
      static revokeObjectURL = release;
    }
  );
  const element = <ReportScreenshots id="fake-receipt" count={10} />;
  const { rerender } = render(element);
  expect(read).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /View screenshots/ })));
  expect(screen.getByRole('img')).toHaveAttribute('alt', 'Report screenshot 1');
  expect(read).toHaveBeenCalledWith(
    '/api/admin/analytics/feedback/fake-receipt/screenshots/1',
    expect.objectContaining({
      headers: { Authorization: 'Bearer admin-one' },
      cache: 'no-store',
      redirect: 'error'
    })
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Next' })));
  expect(screen.getByRole('img')).toHaveAttribute('alt', 'Report screenshot 2');
  expect(release).toHaveBeenCalledTimes(1);
  auth.owner = '';
  rerender(<ReportScreenshots id="fake-receipt" count={10} />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(release).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(2);
});
