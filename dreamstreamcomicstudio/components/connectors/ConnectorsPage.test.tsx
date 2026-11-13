import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorsPage } from './ConnectorsPage';
import type { CatalogEntry, ConnectionSummary } from '../../services/connectorsApi';

const api = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
  fetchConnections: vi.fn(),
  connectConnector: vi.fn(),
  connectGoogleServices: vi.fn(),
  syncConnection: vi.fn(),
  disconnectConnection: vi.fn()
}));
vi.mock('../../services/connectorsApi', () => api);

const gmail: CatalogEntry = {
  id: 'gmail',
  displayName: 'Gmail',
  description: 'Search email',
  icon: 'Mail',
  category: 'google_workspace',
  authType: 'user_oauth',
  providerGroup: 'google',
  requiredScopes: [],
  capabilities: { searchable: true, syncable: true, realtime: false, apiKeyBased: false },
  userProvidesKey: false,
  configured: true
};
const maps: CatalogEntry = {
  ...gmail,
  id: 'google_maps',
  displayName: 'Google Maps',
  description: 'Find places',
  authType: 'api_key',
  providerGroup: undefined,
  userProvidesKey: true
};

beforeEach(() => {
  vi.resetAllMocks();
  api.fetchCatalog.mockResolvedValue([gmail, maps]);
  api.fetchConnections.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Connector settings', () => {
  it('opens the consent popup during the click and only handles results from that window', async () => {
    const popup = { document: { title: '', body: { textContent: '' } }, location: { href: '' }, close: vi.fn(), closed: false };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    let finish!: (value: { authorizationUrl: string }) => void;
    api.connectGoogleServices.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    render(<ConnectorsPage embedded />);
    await screen.findByText('Add a connection');
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Connect 1' }));
    expect(open).toHaveBeenCalledOnce();
    expect(popup.document.body.textContent).toBe('Opening Google…');
    expect(popup.location.href).toBe('');
    expect(api.connectGoogleServices).toHaveBeenCalledWith(['gmail']);

    await act(async () => { finish({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }); });
    expect(popup.location.href).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const data = { type: 'connector-oauth-result', connected: 'gmail' };
    act(() => window.dispatchEvent(new MessageEvent('message', { data, source: window })));
    expect(popup.close).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new MessageEvent('message', { data, source: popup as unknown as Window })));
    expect(popup.close).toHaveBeenCalledOnce();
    expect(api.fetchConnections).toHaveBeenCalledTimes(2);
  });

  it('lets a user replace an expired Maps key from its Reconnect button', async () => {
    const expired: ConnectionSummary = {
      id: 'maps-connection',
      connectorId: maps.id,
      status: 'expired',
      authType: 'api_key',
      accountIdentifier: 'maps',
      accountLabel: 'Maps for work',
      grantedScopes: [],
      lastError: null,
      lastSyncAt: null,
      sync: null
    };
    api.fetchConnections.mockResolvedValue([expired]);
    api.connectConnector.mockResolvedValue({ mode: 'completed', connection: { ...expired, status: 'connected' } });
    render(<ConnectorsPage embedded />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Google Maps' });
    expect(api.connectConnector).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'sample-map-key' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save & connect' }));
    await waitFor(() => expect(api.connectConnector).toHaveBeenCalledWith('google_maps', { apiKey: 'sample-map-key' }));
  });
});
