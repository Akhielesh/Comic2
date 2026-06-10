import React, { useState } from 'react';
import { createEvent } from './api';
import { DEFAULT_PRESET_ID, LIMITS, QUALITY_PRESETS, SEGMENT_MS } from './config';
import { downloadIcs } from './schedule';

function LinkBox({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="lv-linkbox" title={label}>
      <span className="lv-link-text">{url}</span>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

export function CreateEventView() {
  const [title, setTitle] = useState('');
  const [access, setAccess] = useState<'open' | 'approval'>('open');
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [when, setWhen] = useState(''); // datetime-local value; empty = go live anytime
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; hostKey: string } | null>(null);

  const scheduledMs = when ? new Date(when).getTime() : null;

  const base = `${location.origin}${location.pathname}`;
  const hostUrl = created ? `${base}?e=${created.id}&k=${created.hostKey}` : '';
  const shareUrl = created ? `${base}?e=${created.id}` : '';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createEvent({
        title: title.trim() || 'Untitled stream',
        access,
        quality: presetId,
        segMs: SEGMENT_MS,
        scheduledAt: scheduledMs && scheduledMs > Date.now() ? scheduledMs : null,
      });
      setCreated(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reach the live worker — is it running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lv-view">
      <h1 className="lv-h1">Stream Studio</h1>
      <p className="lv-sub">Create an event, share one link, go live from your camera. Short session or marathon — both work.</p>
      <div className="lv-grid-2">
        <div className="lv-card">
          <h3>{created ? 'Your event is ready' : 'New event'}</h3>
          {!created ? (
            <>
              <div className="lv-field">
                <label>Title</label>
                <input value={title} placeholder="Inking the final issue — live draw-along" maxLength={120} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="lv-field">
                <label>Quality (you can see exactly what each needs)</label>
                <div className="lv-seg" role="radiogroup">
                  {QUALITY_PRESETS.map((p) => (
                    <button key={p.id} className={p.id === presetId ? 'active' : ''} onClick={() => setPresetId(p.id)}>
                      {p.id}
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)' }}>
                  {QUALITY_PRESETS.filter((p) => p.id === presetId).map((p) => (
                    <span key={p.id}>
                      {p.label} · video {(p.videoBps / 1e6).toFixed(1)} Mbps · needs ≥ {p.minUplinkMbps} Mbps uplink
                    </span>
                  ))}
                </div>
              </div>
              <div className="lv-field">
                <label>Access</label>
                <div className="lv-seg" role="radiogroup">
                  <button className={access === 'open' ? 'active' : ''} onClick={() => setAccess('open')}>
                    Anyone with link
                  </button>
                  <button className={access === 'approval' ? 'active' : ''} onClick={() => setAccess('approval')}>
                    Approval required
                  </button>
                </div>
              </div>
              <div className="lv-field">
                <label>Schedule (optional — viewers see a countdown until you go live)</label>
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              </div>
              {error && <div className="lv-banner err">{error}</div>}
              <button className="lv-btn lv-btn-primary" onClick={submit} disabled={busy}>
                {busy ? 'Creating…' : 'Create event'}
              </button>
            </>
          ) : (
            <>
              <div className="lv-field">
                <label>Share with viewers</label>
                <LinkBox url={shareUrl} label="viewer link" />
              </div>
              <div className="lv-field">
                <label>Your private studio link (keep this one to yourself)</label>
                <LinkBox url={hostUrl} label="host link" />
              </div>
              <div className="lv-row">
                <a className="lv-btn lv-btn-live" style={{ textDecoration: 'none' }} href={hostUrl}>
                  Open Studio
                </a>
                <a className="lv-btn lv-btn-ghost" style={{ textDecoration: 'none' }} href={shareUrl} target="_blank" rel="noreferrer">
                  Preview viewer page
                </a>
                {scheduledMs && scheduledMs > Date.now() && (
                  <button
                    className="lv-btn lv-btn-ghost"
                    onClick={() => downloadIcs({ title: title.trim() || 'DreamStream Live', startMs: scheduledMs, url: shareUrl })}
                  >
                    Add to calendar (.ics)
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <div className="lv-card">
          <h3>Clear-cut limits — no surprises</h3>
          <table className="lv-limits">
            <tbody>
              {LIMITS.map(({ label, value }) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
