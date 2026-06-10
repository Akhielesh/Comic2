// Create / schedule an event — title, host name, when (now / scheduled),
// description + cover for the invite page, quality, access, auto-record.
import React, { useMemo, useState } from 'react';
import { createEvent } from '../api';
import { LIMITS, QUALITY_PRESETS, SEGMENT_MS, presetById } from '../config';
import { addMyEvent } from '../events';
import { pushEventToCloud } from '../sync';
import type { Nav } from '../nav';
import { studioUrl, viewerUrl } from '../nav';
import { loadPrefs, savePrefs } from '../prefs';
import { downloadIcs } from '../schedule';
import { COVER_THEMES } from '../theme';
import { Icon } from '../ui/icons';
import { Btn, Field, LinkBox, Segmented, Toggle, cx, type PushToast } from '../ui/primitives';

export function CreateView({ nav, push }: { nav: Nav; push: PushToast }) {
  const prefs = useMemo(loadPrefs, []);
  const [title, setTitle] = useState('');
  const [host, setHost] = useState(prefs.hostName);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('18:00');
  const [desc, setDesc] = useState('');
  const [cover, setCover] = useState(0);
  const [quality, setQuality] = useState(prefs.qualityId);
  const [access, setAccess] = useState<'open' | 'approval'>('open');
  const [cap, setCap] = useState(100);
  const [rec, setRec] = useState(prefs.autoRecord);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; hostKey: string } | null>(null);

  const preset = presetById(quality);
  const scheduled = when === 'later';
  const scheduledMs = scheduled && date ? new Date(`${date}T${time || '18:00'}`).getTime() : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const cleanTitle = title.trim() || 'Untitled stream';
    const cleanHost = host.trim() || 'Host';
    try {
      const res = await createEvent({
        title: cleanTitle,
        host: cleanHost,
        desc: desc.trim(),
        cover,
        access,
        quality,
        segMs: SEGMENT_MS,
        scheduledAt: scheduledMs && scheduledMs > Date.now() ? scheduledMs : null,
        maxViewers: cap,
      });
      const mine = {
        id: res.id,
        hostKey: res.hostKey,
        title: cleanTitle,
        createdAt: Date.now(),
        scheduledAt: scheduledMs,
        status: 'idle' as const,
        quality,
        access,
        cover,
      };
      addMyEvent(mine);
      void pushEventToCloud(mine); // cross-device history when signed in
      // Remember host name + defaults for next time.
      savePrefs({ ...prefs, hostName: cleanHost, qualityId: quality, autoRecord: rec });
      setCreated(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the live worker — is it running?');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const share = viewerUrl(created.id);
    return (
      <div className="page page-narrow fade-in">
        <button className="back-link" onClick={() => nav.dashboard()}><Icon name="arrowLeft" size={15} />Dashboard</button>
        <div className="created-hero">
          <div className="ch-check"><Icon name={scheduled ? 'calendar' : 'check'} size={24} /></div>
          <h1 className="page-title">{scheduled ? 'Your event is scheduled' : 'Your event is ready'}</h1>
          <p className="page-sub">
            {scheduled
              ? 'Share the invite — viewers just enter a name to join, no account needed.'
              : 'Share the viewer link anywhere. Keep the studio link to yourself.'}
          </p>
        </div>
        <div className="card card-pad" style={{ maxWidth: 560, margin: '0 auto', display: 'grid', gap: 18 }}>
          <Field label={scheduled ? 'Invite link (event page)' : 'Share with viewers'}>
            <LinkBox url={share} onCopy={() => push(scheduled ? 'Invite link copied' : 'Viewer link copied', { icon: 'check' })} />
          </Field>
          <Field label="Your private studio link" hint="keep secret — it IS the key">
            <LinkBox url={studioUrl(created.id, created.hostKey)} onCopy={() => push('Studio link copied', { icon: 'check' })} />
          </Field>
          <hr className="divider" />
          <div className="wrap-row">
            <Btn variant="solid" icon="broadcast" onClick={() => nav.studio(created.id, created.hostKey)}>Open Studio</Btn>
            {scheduled && <Btn variant="ghost" icon="calendar" onClick={() => nav.event(created.id)}>Preview invite page</Btn>}
            {scheduledMs && scheduledMs > Date.now() && (
              <Btn variant="ghost" icon="download" onClick={() => downloadIcs({ title: title.trim() || 'Stream Studio', startMs: scheduledMs, url: share })}>
                Add to calendar
              </Btn>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-narrow fade-in">
      <button className="back-link" onClick={() => nav.dashboard()}><Icon name="arrowLeft" size={15} />Dashboard</button>
      <div className="page-head">
        <div>
          <h1 className="page-title">New event</h1>
          <p className="page-sub">Go live now, or schedule one and share an invite — like an event page for your stream.</p>
        </div>
      </div>

      <div className="create-grid">
        <div className="card card-pad" style={{ display: 'grid', gap: 20 }}>
          <Field label="Title">
            <input className="input" value={title} maxLength={120} placeholder="Inking the final issue — live draw-along" onChange={(e) => setTitle(e.target.value)} />
          </Field>

          <Field label="Your name" hint="shown to viewers and on the invite">
            <input className="input" value={host} maxLength={40} placeholder="e.g. Akhielesh" onChange={(e) => setHost(e.target.value)} />
          </Field>

          <Field label="When">
            <Segmented
              full
              label="When"
              options={[{ value: 'now', label: 'Go live now', icon: 'broadcast' }, { value: 'later', label: 'Schedule', icon: 'calendar' }]}
              value={when}
              onChange={(v) => setWhen(v as 'now' | 'later')}
            />
            {scheduled && (
              <div className="sched-row">
                <div className="sched-field"><Icon name="calendar" size={15} className="faint" /><input className="input" type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                <div className="sched-field"><Icon name="clock" size={15} className="faint" /><input className="input" type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
              </div>
            )}
          </Field>

          <Field label="About this event" hint="optional — shown on the invite">
            <textarea className="textarea" rows={3} value={desc} maxLength={400} placeholder="What you'll be doing, what to bring, why people should tune in…" onChange={(e) => setDesc(e.target.value)} />
          </Field>

          <Field label="Cover theme" hint="for the invite page">
            <div className="cover-row" role="radiogroup" aria-label="Cover theme">
              {COVER_THEMES.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={cover === i}
                  aria-label={`Cover theme ${i + 1}`}
                  className={cx('cover-sw', cover === i && 'sel')}
                  style={{ background: `linear-gradient(135deg, ${c[0]}, ${c[1]})`, border: cover === i ? undefined : '2px solid transparent' }}
                  onClick={() => setCover(i)}
                />
              ))}
            </div>
          </Field>

          <hr className="divider" />

          <Field label="Quality" hint="what each needs">
            <Segmented full label="Quality" options={QUALITY_PRESETS.map((p) => ({ value: p.id, label: p.id }))} value={quality} onChange={setQuality} />
            <div className="quality-note">
              <span><b>{preset.label}</b></span>
              <span className="dotsep">·</span>
              <span>video {(preset.videoBps / 1e6).toFixed(1)} Mbps</span>
              <span className="dotsep">·</span>
              <span>needs ≥ {preset.minUplinkMbps} Mbps uplink</span>
            </div>
          </Field>

          <Field label="Who can watch">
            <Segmented
              full
              label="Who can watch"
              options={[{ value: 'open', label: 'Anyone with the link', icon: 'globe' }, { value: 'approval', label: 'Approve each viewer', icon: 'lock' }]}
              value={access}
              onChange={(v) => setAccess(v as 'open' | 'approval')}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 7 }}>
              Viewers never sign up — they just enter a name to join{access === 'approval' ? ', then you let them in.' : '.'}
            </div>
          </Field>

          <Field label="Viewer cap" hint="a hard limit — the room never exceeds it">
            <Segmented
              full
              label="Viewer cap"
              options={['25', '50', '100', '150', '200'].map((v) => ({ value: v, label: v }))}
              value={String(cap)}
              onChange={(v) => setCap(Number(v))}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 7 }}>
              Joins beyond the cap are refused with a clear "stream is full" message. Platform ceiling: 200.
            </div>
          </Field>

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Auto-record the program feed</div>
              <div className="muted" style={{ fontSize: 12.5 }}>A high-bitrate master copy, saved to your device. Chat never burned in.</div>
            </div>
            <Toggle on={rec} onChange={setRec} label="Auto-record" />
          </div>

          {error && <div className="banner err"><Icon name="alert" size={15} />{error}</div>}

          <hr className="divider" />
          <div className="row">
            <Btn variant="solid" size="lg" icon={scheduled ? 'calendar' : 'check'} onClick={() => void submit()} disabled={busy}>
              {busy ? 'Creating…' : scheduled ? 'Schedule event' : 'Create event'}
            </Btn>
            <Btn variant="subtle" onClick={() => nav.dashboard()}>Cancel</Btn>
          </div>
        </div>

        <div className="card card-pad limits-card">
          <h3 style={{ margin: '0 0 4px', fontSize: 14.5 }}>Clear-cut limits</h3>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 16px' }}>No surprises — what you see is what you get.</p>
          <div className="limits">
            {LIMITS.map((l) => (
              <div className="limit-row" key={l.label}>
                <span className="limit-label">{l.label}</span>
                <span className="limit-value">{l.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
