// Nursery-wide settings (parents) and history export (parents & caregivers).
// Parents also see the nursery's security (ADR 0006 Phase 0, rooms that list
// it): the devices that hold the family's key, each with Revoke, and a log of
// security events — new devices, people added or removed, sign-outs.
import React, { useCallback, useEffect, useState } from 'react';
import { accessToken } from '../../account';
import { WORKER_BASE } from '../../config';
import { ensureStepUp, nurseryCaps, stepUp } from '../../monitor/client';
import { ago } from '../../monitor/invite';
import { deviceKeys } from '../../monitor/keys';
import { hasCap, type DevicesReply, type DevRevokeReply, type MonLog, type MonRole, type MonSettings, type NurseryDevice } from '../../monitor/protocol';
import { Icon } from '../../ui/icons';
import { Btn, Segmented, Toggle, type PushToast } from '../../ui/primitives';
import type { QueryLike } from '../../usage/usageClient';
import { NurseryUsage } from '../settings/UsageCard';

type Send = (msg: Record<string, unknown>) => void;

export function NurserySettings({
  nid,
  nurseryName,
  role,
  settings,
  send,
  push,
  people,
  query,
}: {
  nid: string;
  nurseryName: string;
  role: MonRole | null;
  settings: MonSettings;
  send: Send;
  push: PushToast;
  /** Parents: "People & sharing" at a glance, with Invite. */
  people?: { summary: string; onInvite: () => void };
  /** The monitor socket's query channel: parents read the nursery's usage over it. */
  query?: QueryLike | null;
}) {
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState<string | null>(null);
  const parent = role === 'parent';
  const canExport = role === 'parent' || role === 'caregiver';
  if (!canExport) return null;
  const set = (patch: Record<string, unknown>) => send({ t: 'settings', ...patch });

  const download = async (what: 'events' | 'sleep' | 'minutes') => {
    // Export needs the second sign-in step once it's on (ADR 0006): ask first rather than fail.
    if (!(await ensureStepUp('Downloading the nursery’s history'))) return;
    setBusy(what);
    try {
      const from = Date.now() - Number(days) * 24 * 60 * 60_000;
      const get = async () => {
        const token = await accessToken();
        if (!token) throw new Error('Sign in again to download.');
        return fetch(`${WORKER_BASE}/api/monitor/${nid}/export?what=${what}&from=${from}`, { headers: { authorization: `Bearer ${token}` } });
      };
      let res = await get();
      if (res.status === 403 && (await mfaRefusal(res)) && (await stepUp('Downloading the nursery’s history'))) res = await get();
      if (!res.ok) throw new Error(res.status === 403 ? 'Only parents and caregivers can download history — with the code from your authenticator app, once two-step sign-in is on.' : 'Could not download — try again.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const slug = nurseryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'nursery';
      a.download = `${slug}-${what}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      push('Downloaded — opens in Excel, Numbers or Google Sheets', { icon: 'check' });
    } catch (e) {
      push(e instanceof Error ? e.message : 'Could not download', { icon: 'alert' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card card-pad nursery-settings" data-tour="mv-settings">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="sliders" size={17} />
        <b style={{ flex: 1 }}>Nursery settings</b>
        {!parent && <span className="faint" style={{ fontSize: 12 }}>Parents can change these</span>}
      </div>

      {parent && people && (
        <div className="ns-people">
          <Icon name="users" size={16} />
          <span><b>People &amp; sharing</b><small className="faint">{people.summary}</small></span>
          <Btn variant="soft" size="sm" icon="userPlus" onClick={people.onInvite}>Invite</Btn>
        </div>
      )}

      <div className="ns-row">
        <div><b>Sound detection sensitivity</b><small>High catches soft whimpers and distant sounds; Low only clear, close cries.</small></div>
        <Segmented label="Sensitivity" options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} value={settings.sensitivity} onChange={(v) => parent && set({ sensitivity: v })} />
      </div>
      <div className="ns-row">
        <div><b>If a cry goes unanswered, alert everyone after</b><small>Whoever is on duty hears it first; then the whole family does.</small></div>
        <Segmented label="Escalate after" options={[{ value: '2', label: '2m' }, { value: '5', label: '5m' }, { value: '10', label: '10m' }, { value: '15', label: '15m' }]} value={String(settings.cryEscalateMin ?? 5)} onChange={(v) => parent && set({ cryEscalateMin: Number(v) })} />
      </div>
      <div className="ns-row">
        <div><b>Repeat cry notifications every</b><small>While a cry continues after it has escalated.</small></div>
        <Segmented label="Repeat" options={[{ value: '2', label: '2m' }, { value: '3', label: '3m' }, { value: '5', label: '5m' }, { value: '10', label: '10m' }]} value={String(settings.cryRepeatMin)} onChange={(v) => parent && set({ cryRepeatMin: Number(v) })} />
      </div>
      <div className="ns-row">
        <div><b>Noise alert</b><small>When the room stays louder than this for 3 seconds. Very loud noise (85 dB+) always alerts.</small></div>
        <Segmented
          label="Noise alert"
          options={[{ value: 'off', label: 'Off' }, { value: '60', label: '60' }, { value: '65', label: '65' }, { value: '70', label: '70' }, { value: '75', label: '75 dB' }]}
          value={settings.noiseDb === null ? 'off' : String(settings.noiseDb ?? 70)}
          onChange={(v) => parent && set({ noiseDb: v === 'off' ? null : Number(v) })}
        />
      </div>
      <label className="ns-toggle">
        <Toggle size="sm" on={settings.machineCheck !== false} onChange={(v) => parent && set({ machineCheck: v })} label="Sound machine check" />
        <span><b>Sound machine check</b><small>Warns when a steady sound averages over 50 dB for an hour — the guideline for infant sleep.</small></span>
      </label>
      <label className="ns-toggle">
        <Toggle size="sm" on={settings.sleepTracking !== false} onChange={(v) => parent && set({ sleepTracking: v })} label="Sleep tracking" />
        <span><b>Sleep tracking &amp; morning report</b><small>Naps and nights from the camera’s movement and sound, with a summary when the night ends.</small></span>
      </label>

      {parent && (
        <>
          <div className="mv-sect-title" style={{ marginTop: 16 }}>Usage</div>
          <NurseryUsage query={query ?? null} nid={nid} />
        </>
      )}

      {parent && <NurserySecurity nid={nid} query={query ?? null} push={push} />}

      <div className="mv-sect-title" style={{ marginTop: 16 }}>Download history</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Segmented label="Period" options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} value={days} onChange={setDays} />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Btn variant="soft" size="sm" icon="download" disabled={!!busy} onClick={() => void download('events')}>{busy === 'events' ? 'Preparing…' : 'Activity log'}</Btn>
        <Btn variant="soft" size="sm" icon="download" disabled={!!busy} onClick={() => void download('sleep')}>{busy === 'sleep' ? 'Preparing…' : 'Sleep'}</Btn>
        <Btn variant="soft" size="sm" icon="download" disabled={!!busy} onClick={() => void download('minutes')}>{busy === 'minutes' ? 'Preparing…' : 'Minute-by-minute (sound, motion)'}</Btn>
      </div>
      <p className="faint" style={{ fontSize: 11.5, margin: '8px 0 0' }}>History is kept for 90 days (minute-by-minute for 31). It never includes audio or video — nothing is recorded.</p>
    </div>
  );
}

/** The Worker refused for want of the second sign-in step (`{error:'mfa_required'}`), not the role. */
async function mfaRefusal(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: string; code?: string };
    return body?.error === 'mfa_required' || body?.code === 'mfa_required';
  } catch {
    return false;
  }
}

const PLATFORM: Record<string, string> = { web: 'Browser', ios: 'iPhone or iPad app', android: 'Android app', watchos: 'Apple Watch', wearos: 'Wear OS watch' };

/**
 * Parents: who holds the family's key, and what happened (rooms that list `e2e1` / `reauth`).
 * Revoking a device cuts it off and changes the key, so it can't open anything sent after.
 */
export function NurserySecurity({ nid, query, push, now = Date.now() }: { nid: string; query: { ask<T>(q: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T | null> } | null; push: PushToast; now?: number }) {
  const caps = nurseryCaps(nid);
  const hasDevices = hasCap(caps, 'e2e1');
  const hasLog = hasCap(caps, 'reauth') || hasDevices;
  const [tab, setTab] = useState<'devices' | 'log'>(hasDevices ? 'devices' : 'log');
  const [devices, setDevices] = useState<NurseryDevice[] | null | 'err'>(null);
  const [events, setEvents] = useState<MonLog[] | null | 'err'>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    if (!query || !hasDevices) return;
    const r = await query.ask<DevicesReply>('devices');
    setDevices(r && Array.isArray(r.devices) ? r.devices : 'err');
  }, [query, hasDevices]);
  const loadEvents = useCallback(async () => {
    if (!query || !hasLog) return;
    const r = await query.ask<{ rows: MonLog[] }>('events', { kinds: ['security'], limit: 50 });
    setEvents(r && Array.isArray(r.rows) ? r.rows : 'err');
  }, [query, hasLog]);

  useEffect(() => {
    void deviceKeys().then((d) => setMine(d?.devId ?? null));
  }, []);
  useEffect(() => {
    if (tab === 'devices') void loadDevices();
    else void loadEvents();
  }, [tab, loadDevices, loadEvents]);

  if (!hasLog) return null;

  const revoke = async (d: NurseryDevice) => {
    setConfirm(null);
    if (!query || !(await ensureStepUp(`Removing ${d.name} from the nursery`))) return;
    setRevoking(d.devId);
    let r = await query.ask<DevRevokeReply>('dev_revoke', { devId: d.devId });
    if (r?.error === 'mfa_required' && (await stepUp(`Removing ${d.name} from the nursery`))) r = await query.ask<DevRevokeReply>('dev_revoke', { devId: d.devId });
    setRevoking(null);
    if (r?.ok) {
      push(`${d.name} removed — it’s disconnected, and the family’s key is being changed so it can’t open anything new`, { icon: 'check' });
      void loadDevices();
    } else push(r?.error === 'mfa_required' ? 'Enter the code from your authenticator app first, then try again' : 'Couldn’t remove it — try again', { icon: 'alert' });
  };

  const list = tab === 'devices' ? devices : events;
  return (
    <>
      <div className="mv-sect-title" style={{ marginTop: 16 }}>Security</div>
      {hasDevices && (
        <Segmented label="Security" options={[{ value: 'devices', label: 'Devices' }, { value: 'log', label: 'Security log' }]} value={tab} onChange={(v) => setTab(v === 'log' ? 'log' : 'devices')} />
      )}
      {list === null && <p className="faint" style={{ fontSize: 12.5 }}>Loading…</p>}
      {list === 'err' && (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <span className="faint" style={{ fontSize: 12.5, flex: 1 }}>Couldn’t load it.</span>
          <Btn variant="ghost" size="sm" icon="refresh" onClick={() => void (tab === 'devices' ? loadDevices() : loadEvents())}>Try again</Btn>
        </div>
      )}
      {tab === 'devices' && Array.isArray(devices) && (
        <>
          <p className="faint" style={{ fontSize: 12, margin: '8px 0 4px' }}>Devices that hold your family’s key: only they can open the picture and sound when it goes through our server. A device you don’t recognise? Remove it.</p>
          {devices.length === 0 && <p className="faint" style={{ fontSize: 12.5 }}>No devices yet — they appear here as the camera and your family open the monitor.</p>}
          <div className="ns-devices" role="list">
            {devices.map((d) => {
              const me = d.me || d.devId === mine;
              return (
                <div key={d.devId} className="ns-row" role="listitem">
                  <div>
                    <b>
                      {d.name}
                      {me ? ' (this device)' : ''}
                    </b>
                    <small>
                      {d.who} · {PLATFORM[d.platform] ?? d.platform} · added {ago(d.added, now)}
                      {d.last_seen ? ` · last seen ${ago(d.last_seen, now)}` : ''}
                      {d.keyed === false ? ' · waiting for the key' : ''}
                    </small>
                  </div>
                  {!me &&
                    (confirm === d.devId ? (
                      <div className="row" style={{ gap: 8 }} role="group" aria-label={`Remove ${d.name}`}>
                        <Btn variant="danger" size="sm" disabled={revoking === d.devId} onClick={() => void revoke(d)}>{revoking === d.devId ? 'Removing…' : 'Remove'}</Btn>
                        <Btn variant="ghost" size="sm" onClick={() => setConfirm(null)} autoFocus>Cancel</Btn>
                      </div>
                    ) : (
                      <Btn variant="soft" size="sm" icon="x" onClick={() => setConfirm(d.devId)}>Revoke</Btn>
                    ))}
                </div>
              );
            })}
          </div>
        </>
      )}
      {tab === 'log' && Array.isArray(events) && (
        <>
          {events.length === 0 && <p className="faint" style={{ fontSize: 12.5 }}>Nothing yet. New devices, people added or removed, and “Sign out everywhere” show up here.</p>}
          <div className="ns-security-log" role="list">
            {events.map((e) => (
              <div key={e.id} className="ns-row" role="listitem">
                <div>
                  <b>{e.msg}</b>
                  <small>
                    {ago(e.at, now)}
                    {e.by ? ` · ${e.by}` : ''}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
