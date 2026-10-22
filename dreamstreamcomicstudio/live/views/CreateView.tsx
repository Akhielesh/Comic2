// Start now — one tap to an Instant meeting or Go live now (QuickStart), with every
// other option under Advanced: host name, when (now / scheduled), description + cover
// for the invite page, quality, access, viewer cap and auto-record.
import React, { useEffect, useMemo, useState } from 'react';
import { openAuth, useAccount } from '../account';
import { SignInRequiredError, createEvent, probeLiveWorker, type LiveWorkerProbeResult } from '../api';
import { LIMITS, QUALITY_PRESETS, SEGMENT_MS, presetById } from '../config';
import { addMyEvent } from '../events';
import { pushEventToCloud } from '../sync';
import type { Nav } from '../nav';
import { studioUrl, viewerUrl } from '../nav';
import { loadPrefs, savePrefs } from '../prefs';
import { autoTitle, loadAdvancedOpen, quickDefaultsLine, saveAdvancedOpen, takeScheduleRequest, type QuickKind } from '../quickStart';
import { downloadIcs } from '../schedule';
import { COVER_THEMES } from '../theme';
import { Icon } from '../ui/icons';
import { Btn, Field, LinkBox, Segmented, Toggle, cx, redactUrlSearchParams, type PushToast } from '../ui/primitives';
import { QuickStart } from './create/QuickStart';
import { useQuickStart } from './create/useQuickStart';

/** Local YYYY-MM-DD for the date picker's `min` (no scheduling in the past). */
const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function CreateView({ nav, push }: { nav: Nav; push: PushToast }) {
  const prefs = useMemo(loadPrefs, []);
  // "Schedule…" from the dashboard lands here with Advanced → Schedule ready.
  const scheduleRequested = useMemo(takeScheduleRequest, []);
  const [advOpen, setAdvOpen] = useState(() => scheduleRequested || loadAdvancedOpen());
  const [title, setTitle] = useState('');
  const [host, setHost] = useState(prefs.hostName);
  const [when, setWhen] = useState<'now' | 'later'>(scheduleRequested ? 'later' : 'now');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('18:00');
  const [desc, setDesc] = useState('');
  const [cover, setCover] = useState(0);
  const [quality, setQuality] = useState(prefs.qualityId);
  const [access, setAccess] = useState<'open' | 'approval'>('open');
  const [cap, setCap] = useState(100);
  const [rec, setRec] = useState(prefs.autoRecord);
  const [busy, setBusy] = useState(false);
  const [checkingBackend, setCheckingBackend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendProbe, setBackendProbe] = useState<LiveWorkerProbeResult | null>(null);
  const [created, setCreated] = useState<{ id: string; hostKey: string } | null>(null);
  const account = useAccount();
  const quick = useQuickStart(nav);
  // No on-stream name of its own (Settings → Scenes): start from the account name.
  useEffect(() => {
    if (account.status === 'member' && account.name) setHost((h) => h || account.name || '');
  }, [account.status, account.name]);
  const isMember = account.status === 'member';

  const preset = presetById(quality);
  const scheduled = when === 'later';
  const scheduledMs = scheduled && date ? new Date(`${date}T${time || '18:00'}`).getTime() : null;
  // "Schedule" needs a real future time — before, an empty or past date silently
  // created an unscheduled event while the success screen still said "scheduled".
  const scheduleInvalid = scheduled && !(scheduledMs != null && Number.isFinite(scheduledMs) && scheduledMs > Date.now());
  const backendBlocked = backendProbe != null && !backendProbe.ok;

  const toggleAdvanced = (open = !advOpen) => {
    setAdvOpen(open);
    saveAdvancedOpen(open);
  };

  /** One tap: create with the current settings (defaults unless changed under Advanced) and open the studio. */
  const startQuick = (kind: QuickKind) => {
    void quick.start(kind, {
      title,
      host: host.trim() || account.name || 'Host',
      titleName: host.trim() || account.name || '',
      rememberHost: true,
      quality,
      access,
      maxViewers: cap,
      cover,
      desc,
      autoRecord: rec,
      probe: backendProbe,
      onProbe: (r) => {
        setBackendProbe(r);
        if (r.ok) setError(null);
      },
    });
  };

  const refreshBackendProbe = async (): Promise<LiveWorkerProbeResult> => {
    setCheckingBackend(true);
    const result = await probeLiveWorker();
    setBackendProbe(result);
    if (result.ok) setError(null);
    setCheckingBackend(false);
    return result;
  };

  useEffect(() => {
    let cancelled = false;
    setCheckingBackend(true);
    void probeLiveWorker().then((result) => {
      if (!cancelled) {
        setBackendProbe(result);
        if (result.ok) setError(null);
      }
    }).finally(() => {
      if (!cancelled) setCheckingBackend(false);
    });
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    if (!isMember && account.status !== 'loading') {
      openAuth(account.status === 'needs_code' ? 'code' : 'signin', 'Sign in to host your stream — viewers never need an account.');
      return;
    }
    if (backendBlocked) {
      setError(`Streaming backend is not reachable: ${backendProbe?.detail ?? 'live-worker route unavailable'}`);
      return;
    }
    if (scheduleInvalid) {
      setError('Pick a date and time in the future to schedule.');
      return;
    }
    setBusy(true);
    setError(null);
    const cleanTitle = title.trim() || 'Untitled stream';
    const cleanHost = host.trim() || account.name || 'Host';
    try {
      const readiness = backendProbe?.ok ? backendProbe : await probeLiveWorker();
      setBackendProbe(readiness);
      if (!readiness.ok) {
        setError(`Streaming backend is not reachable: ${readiness.detail}`);
        return;
      }

      const res = await createEvent({
        title: cleanTitle,
        host: cleanHost,
        desc: desc.trim(),
        cover,
        access,
        quality,
        segMs: SEGMENT_MS,
        scheduledAt: scheduled ? scheduledMs : null,
        maxViewers: cap,
        kind: 'broadcast',
      });
      const mine = {
        id: res.id,
        hostKey: res.hostKey,
        title: cleanTitle,
        createdAt: Date.now(),
        scheduledAt: scheduled ? scheduledMs : null,
        status: 'idle' as const,
        quality,
        access,
        cover,
        kind: 'broadcast' as const,
        autoRecord: rec, // this event only — the default for new events lives in Customize
      };
      addMyEvent(mine);
      void pushEventToCloud(mine); // cross-device history when signed in
      // Remember defaults for next time. The host name is kept only when it differs from
      // the account name — otherwise it stays empty so a later rename flows through.
      savePrefs({ ...prefs, hostName: cleanHost === account.name || cleanHost === 'Host' ? '' : cleanHost, qualityId: quality });
      setCreated(res);
    } catch (e) {
      if (e instanceof SignInRequiredError) {
        openAuth('signin', e.message);
        setError(e.message);
      } else {
        setError(e instanceof Error ? e.message : 'Could not reach the live worker — is it running?');
      }
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
            <LinkBox
              url={studioUrl(created.id, created.hostKey)}
              displayUrl={redactUrlSearchParams(studioUrl(created.id, created.hostKey))}
              copyLabel="Copy private link"
              copyWarning="This link contains the host key and can start, end, record, and moderate the event. Share the viewer link instead."
              onCopy={() => push('Private studio link copied — only send it to trusted hosts', { icon: 'alert' })}
            />
          </Field>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            <Icon name="users" size={13} /> Want people on camera with you? In the studio, tap <b>Invite</b> —
            up to 4 guests join with cam, mic and screen share, no account needed.
          </p>
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
          <h1 className="page-title">Start now</h1>
          <p className="page-sub">Meet face-to-face or go live to an audience. One tap; fine-tune under Advanced.</p>
        </div>
      </div>

      {(account.status === 'signed_out' || account.status === 'needs_code') && (
        <div className="banner info" role="status" style={{ marginBottom: 18, alignItems: 'center' }} data-tour="host-signin">
          <Icon name="user" size={15} />
          <span style={{ flex: 1 }}>
            {account.status === 'needs_code'
              ? <><b>Unlock hosting.</b> Enter your welcome code once and you’re set.</>
              : <><b>Hosting needs a free account.</b> Viewers never do — they join with just a name.</>}
          </span>
          {account.status === 'needs_code'
            ? <Btn variant="solid" size="sm" icon="lock" onClick={() => openAuth('code')}>Enter code</Btn>
            : <>
                <Btn variant="soft" size="sm" onClick={() => openAuth('signin')}>Sign in</Btn>
                <Btn variant="solid" size="sm" onClick={() => openAuth('create')}>Create account</Btn>
              </>}
        </div>
      )}

      {backendProbe && !backendProbe.ok && (
        <div className="banner warn" role="status" style={{ marginBottom: 18, alignItems: 'center' }}>
          <Icon name="alert" size={15} />
          <span style={{ flex: 1 }}>
            <b>Streaming backend check failed.</b> {backendProbe.detail}. Event creation is blocked on this deployment until the live-worker route or <code>VITE_LIVE_WORKER_URL</code> points at reachable JSON.
          </span>
          <Btn variant="soft" size="sm" icon="refresh" onClick={() => void refreshBackendProbe()} disabled={checkingBackend}>
            {checkingBackend ? 'Checking…' : 'Retry check'}
          </Btn>
        </div>
      )}

      <QuickStart
        title={title}
        onTitle={setTitle}
        placeholder={autoTitle('meeting', host.trim() || account.name || '')}
        busy={quick.busy}
        disabled={backendBlocked}
        maxViewers={cap}
        defaultsLine={quickDefaultsLine({ quality, access, maxViewers: cap, autoRecord: rec })}
        onStart={startQuick}
        onOpenAdvanced={() => {
          toggleAdvanced(true);
          setTimeout(() => document.getElementById('create-advanced-panel')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 30);
        }}
        error={quick.error}
      />

      <button
        type="button"
        className={cx('adv-toggle', advOpen && 'is-open')}
        aria-expanded={advOpen}
        aria-controls="create-advanced-panel"
        data-tour="create-advanced"
        onClick={() => toggleAdvanced()}
      >
        <Icon name="sliders" size={15} />
        <span className="adv-label"><b>Advanced</b><span className="adv-sub"> — schedule, invite page, quality, who can watch, viewer cap, recording</span></span>
        <Icon name="chevronDown" size={16} className="adv-chev" />
      </button>

      <div id="create-advanced-panel" className="adv-panel" hidden={!advOpen}>
      {advOpen && (
      <div className="create-grid">
        <div className="card card-pad" style={{ display: 'grid', gap: 20 }}>
          <Field label="Your name" hint="shown to viewers and on the invite">
            <input className="input" value={host} maxLength={40} placeholder={account.name || 'Your name'} onChange={(e) => setHost(e.target.value)} />
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
              <>
                <div className="sched-row">
                  <div className="sched-field"><Icon name="calendar" size={15} className="faint" /><input className="input" type="date" aria-label="Date" min={todayIso()} value={date} aria-invalid={!!date && scheduleInvalid} onChange={(e) => setDate(e.target.value)} /></div>
                  <div className="sched-field"><Icon name="clock" size={15} className="faint" /><input className="input" type="time" aria-label="Time" value={time} aria-invalid={!!date && scheduleInvalid} onChange={(e) => setTime(e.target.value)} /></div>
                </div>
                {scheduleInvalid && (
                  <div className={cx('sched-hint', !!date && 'is-error')} role={date ? 'alert' : undefined}>
                    <Icon name={date ? 'alert' : 'info'} size={13} />
                    Pick a date and time in the future to schedule.
                  </div>
                )}
              </>
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
            <div data-tour="create-quality">
            <Segmented full label="Quality" options={QUALITY_PRESETS.map((p) => ({ value: p.id, label: p.id }))} value={quality} onChange={setQuality} />
            </div>
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
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Auto-record this event</div>
              <div className="muted" style={{ fontSize: 12.5 }}>A master copy written to this device as you stream; you choose where it’s saved when it stops. Uses extra CPU — leave off on weaker devices. The default for new events lives in Customize.</div>
            </div>
            <Toggle on={rec} onChange={setRec} label="Auto-record" />
          </div>

          {error && <div className="banner err"><Icon name="alert" size={15} />{error}</div>}

          <hr className="divider" />
          <div className="row">
            <Btn variant="solid" size="lg" icon={backendBlocked ? 'alert' : scheduled ? 'calendar' : 'check'} onClick={() => void submit()} disabled={busy || checkingBackend || backendBlocked || scheduleInvalid || quick.busy != null} data-tour="create-submit">
              {busy
                ? 'Creating…'
                : checkingBackend
                  ? 'Checking backend…'
                  : backendBlocked
                    ? 'Streaming backend unavailable'
                    : scheduled
                      ? 'Schedule event'
                      : 'Create event'}
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
      )}
      </div>
    </div>
  );
}
