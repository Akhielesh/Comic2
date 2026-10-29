import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SecuritySection } from '../../../shared/types/costCentre';
import { SecurityCard } from './SecurityCard';

const section = (over: Partial<SecuritySection> = {}): SecuritySection => ({
  range: { from: '2026-10-22T00:00:00.000Z', to: '2026-10-28T12:00:00.000Z', days: 7 },
  csp: {
    measured: true,
    total: 14,
    firstPartyLive48h: 2,
    firstPartyLiveEnforced: 0,
    firstPartyLiveReportOnly: 5,
    extension: 9,
    top: [
      { page: 'live', directive: 'connect-src', blocked: 'https://cdn.example', disposition: 'report', firstParty: true, count: 5 },
      { page: 'main', directive: 'script-src', blocked: 'extension', disposition: 'report', firstParty: false, count: 9 }
    ],
    note: 'Counts of browser reports, by app, directive and blocked origin — never a URL.'
  },
  signIns: { measured: true, newSessions: 12, alertsEmailed: 4, secured: 1, devicesAdded: 2, devicesRevoked: 0, note: 'From the access-token hook.' },
  signals: {
    measured: true,
    counted: true,
    rows: [
      { id: 'mfa_refused', label: 'Refused: two-step sign-in not completed (aal1 with a factor, 4003)', count: 3, prevCount: 1, tone: 'bad', bySurface: [{ surface: 'monitor', count: 3 }] },
      { id: 'kick', label: '“Sign out everywhere” / “Not you?” requests', count: 2, prevCount: null, tone: 'neutral', bySurface: [] }
    ],
    note: 'Counts from the live Worker.'
  },
  alerts: [
    { id: 'csp_live_violations', severity: 'warning', title: 'Stream Studio’s CSP isn’t clean yet', cause: '2 first-party violations in the last 48 h.' },
    { id: 'not_you_used', severity: 'warning', title: '“Not you?” was used', cause: '1 person used it.' }
  ],
  notes: ['Everything on this tab is a count.'],
  ...over
});

describe('SecurityCard', () => {
  it('leads with the alerts, then the four headline counts', () => {
    render(<SecurityCard security={section()} days={7} />);
    const alerts = within(screen.getByTestId('security-alerts')).getAllByRole('listitem');
    expect(alerts.map((a) => a.textContent)).toEqual([expect.stringContaining('CSP isn’t clean yet · warning'), expect.stringContaining('“Not you?” was used · warning')]);
    expect(within(screen.getByTestId('security-kpi-csp')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByTestId('security-kpi-signins')).getByText('12')).toBeInTheDocument();
    expect(within(screen.getByTestId('security-kpi-signins')).getByText('4 emailed an alert')).toBeInTheDocument();
    expect(within(screen.getByTestId('security-kpi-secured')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('security-kpi-mfa')).getByText('3')).toBeInTheDocument();
  });

  it('shows CSP buckets by app, directive and origin, and says whose code it was', () => {
    render(<SecurityCard security={section()} days={7} />);
    const table = screen.getByRole('table', { name: 'Content-Security-Policy violation reports' });
    expect(within(table).getByText('Stream Studio')).toBeInTheDocument();
    expect(within(table).getByText('https://cdn.example')).toBeInTheDocument();
    expect(within(table).getByText('Browser extension')).toBeInTheDocument();
    expect(within(table).getAllByText('Report only')).toHaveLength(2);
  });

  it('lists the Worker’s signals with the period before and where they happened', () => {
    render(<SecurityCard security={section()} days={7} />);
    const table = screen.getByRole('table', { name: 'Security signals from the live Worker' });
    expect(within(table).getByText('monitor 3')).toBeInTheDocument();
    expect(within(table).getByLabelText('worth a look')).toBeInTheDocument(); // only the refusal, not the kick
  });

  it('is honest when nothing is measured yet — dashes and the reason, never zeros', () => {
    render(
      <SecurityCard
        days={7}
        security={section({
          csp: { measured: false, total: null, firstPartyLive48h: null, firstPartyLiveEnforced: null, firstPartyLiveReportOnly: null, extension: null, top: [], note: 'Bind CSP_REPORTS on the Pages project.' },
          signIns: { measured: false, newSessions: null, alertsEmailed: null, secured: null, devicesAdded: null, devicesRevoked: null, note: 'live_security_v2.sql isn’t applied yet.' },
          signals: { measured: true, counted: false, rows: [], note: 'Nothing counted yet: zero here means “not wired”.' },
          alerts: []
        })}
      />
    );
    expect(screen.getByTestId('security-clear')).toHaveTextContent('for what was measured');
    expect(within(screen.getByTestId('security-kpi-csp')).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByTestId('security-kpi-mfa')).getByText('Not counted yet.')).toBeInTheDocument();
    expect(screen.getByTestId('security-csp-note')).toHaveTextContent('CSP_REPORTS');
    expect(screen.getByTestId('security-signins')).toHaveTextContent('live_security_v2.sql');
    expect(screen.queryByRole('table', { name: 'Content-Security-Policy violation reports' })).toBeNull();
  });

  it('says so when the server predates the section', () => {
    render(<SecurityCard days={7} />);
    expect(screen.getByText(/doesn’t report security signals yet/)).toBeInTheDocument();
  });
});
