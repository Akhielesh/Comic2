// The "Alerts" card (notify SPEC §6 NF-5): each control writes the prefs; Volume (and Play) wait while the chime is
// off; Play plays Ready, then Needs you, from one press; a change is counted with its new values only; the card is
// ink only (no hue, no spark, no price words).
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ playChimeNow: vi.fn(async () => true) }));
vi.mock('../../services/alerts/bus', () => bus);
const telemetry = vi.hoisted(() => ({ captureEvent: vi.fn(), captureError: vi.fn() }));
vi.mock('../../services/telemetry', () => telemetry);

import { AlertSettingsCard } from './AlertSettingsCard';
import { ALERT_PREFS_KEY, createMemoryPrefsStore, loadAlertPrefs, __resetAlertPrefsForTests } from '../../services/alerts/prefs';

beforeEach(() => {
  window.localStorage.clear();
  __resetAlertPrefsForTests();
  bus.playChimeNow.mockClear();
  telemetry.captureEvent.mockClear();
});
afterEach(() => cleanup());

const card = () => document.querySelector<HTMLElement>('[data-alert-settings]')!;

describe('AlertSettingsCard', () => {
  it('shows the four controls and says where it is saved', () => {
    render(<AlertSettingsCard />);
    expect(within(card()).getByRole('heading', { name: 'Alerts' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Play a chime' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radiogroup', { name: 'Volume' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Alert me for' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(card()).toHaveTextContent('Saved in this browser.');
  });

  it('each control writes the prefs in this browser and counts the new values', async () => {
    render(<AlertSettingsCard />);
    fireEvent.click(screen.getByRole('radio', { name: 'Soft' }));
    expect(loadAlertPrefs().volume).toBe('soft');
    fireEvent.click(screen.getByRole('radio', { name: "Only when I'm needed" }));
    expect(loadAlertPrefs().level).toBe('needs');
    fireEvent.click(screen.getByRole('switch', { name: 'Play a chime' }));
    expect(loadAlertPrefs().sound).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(ALERT_PREFS_KEY)!)).toEqual({ sound: false, volume: 'soft', level: 'needs' });
    await waitFor(() =>
      expect(telemetry.captureEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ eventType: 'alert_settings', metadata: { sound: false, volume: 'soft', level: 'needs' } })
      )
    );
    expect(telemetry.captureEvent).toHaveBeenCalledTimes(3);
  });

  it('Volume and Play wait while the chime is off', () => {
    render(<AlertSettingsCard />);
    fireEvent.click(screen.getByRole('switch', { name: 'Play a chime' }));
    for (const radio of within(screen.getByRole('radiogroup', { name: 'Volume' })).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    // "Alert me for" still works: the toast and the tab count do not need the sound.
    for (const radio of within(screen.getByRole('radiogroup', { name: 'Alert me for' })).getAllByRole('radio')) expect(radio).not.toBeDisabled();
  });

  it('Play plays Ready, then Needs you, from the press', () => {
    render(<AlertSettingsCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(bus.playChimeNow).toHaveBeenCalledTimes(2);
    expect(bus.playChimeNow).toHaveBeenNthCalledWith(1, 'ready', { gesture: true, prefs: { sound: true, volume: 'normal' } });
    expect(bus.playChimeNow).toHaveBeenNthCalledWith(2, 'needsYou', { gesture: true, after: 0.75, prefs: { sound: true, volume: 'normal' } });
  });

  it('Play uses the card’s own store: Soft in a memory store plays Soft, whatever this browser saved', () => {
    window.localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify({ sound: false, volume: 'normal', level: 'all' }));
    __resetAlertPrefsForTests();
    const store = createMemoryPrefsStore();
    render(<AlertSettingsCard store={store} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Soft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(bus.playChimeNow).toHaveBeenCalledTimes(2);
    for (const call of bus.playChimeNow.mock.calls as unknown as [string, { prefs?: unknown }][]) expect(call[1].prefs).toEqual({ sound: true, volume: 'soft' });
  });

  it('a memory store keeps the browser untouched (the QA scene)', () => {
    const store = createMemoryPrefsStore();
    const counted = vi.fn();
    render(<AlertSettingsCard store={store} onChanged={counted} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Soft' }));
    expect(store.get().volume).toBe('soft');
    expect(window.localStorage.getItem(ALERT_PREFS_KEY)).toBeNull();
    expect(counted).toHaveBeenCalledWith({ sound: true, volume: 'soft', level: 'all' });
    expect(telemetry.captureEvent).not.toHaveBeenCalled();
  });

  it('each segment is as wide as its own label, so "Normal" and "Only when I\'m needed" are never cut beside a shorter one', () => {
    render(<AlertSettingsCard />);
    for (const name of ['Volume', 'Alert me for']) {
      // flex-1 split the track equally (the longer label was cut while the row had room); flex-auto sizes by content.
      expect(screen.getByRole('radiogroup', { name }).className).toContain('[&>button]:flex-auto');
    }
  });

  it('is ink only: no hue, spark, accent wash or status colour, and no price words', () => {
    render(<AlertSettingsCard />);
    // The primitives' own invalid-field edge (aria-[invalid=true]:…danger-mark) is a form state, not colour on the card.
    const html = card().outerHTML.replace(/aria-\[invalid=true\]:[^\s"]+/g, '');
    expect(html).not.toMatch(/--ds-hue-|hue-\d|--ds-spark|SPARK|--ds-art|--ds-success|--ds-warning|--ds-danger|--ds-info|wash/i);
    expect(html).not.toMatch(/\b(?:red|amber|orange|yellow|green|blue|indigo|violet|pink|rose|emerald|teal|sky)-\d{2,3}\b/);
    // tests/config/priceDetect.ts PRICE_TEXT (a node-only module): dollars, cents, a governed share of the allowance.
    expect(card().textContent).not.toMatch(/\$\s?\d|¢|\bof\s+your\s+(?:usage|month|allowance)\b/i);
    expect(card().textContent).not.toMatch(/\$|usage|credit|cost|price/i);
  });
});
