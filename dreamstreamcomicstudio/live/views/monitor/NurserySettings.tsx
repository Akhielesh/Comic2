// Nursery-wide settings (parents) and history export (parents & caregivers).
import React, { useState } from 'react';
import { accessToken } from '../../account';
import { WORKER_BASE } from '../../config';
import type { MonRole, MonSettings } from '../../monitor/protocol';
import { Icon } from '../../ui/icons';
import { Btn, Segmented, Toggle, type PushToast } from '../../ui/primitives';

type Send = (msg: Record<string, unknown>) => void;

export function NurserySettings({
  nid,
  nurseryName,
  role,
  settings,
  send,
  push,
}: {
  nid: string;
  nurseryName: string;
  role: MonRole | null;
  settings: MonSettings;
  send: Send;
  push: PushToast;
}) {
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState<string | null>(null);
  const parent = role === 'parent';
  const canExport = role === 'parent' || role === 'caregiver';
  if (!canExport) return null;
  const set = (patch: Record<string, unknown>) => send({ t: 'settings', ...patch });

  const download = async (what: 'events' | 'sleep' | 'minutes') => {
    setBusy(what);
    try {
      const token = await accessToken();
      if (!token) throw new Error('Sign in again to download.');
      const from = Date.now() - Number(days) * 24 * 60 * 60_000;
      const res = await fetch(`${WORKER_BASE}/api/monitor/${nid}/export?what=${what}&from=${from}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(res.status === 403 ? 'Only parents and caregivers can download history.' : 'Could not download — try again.');
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
