// Post-stream recap — headline stats, watch curve, the full durable event
// log and top chatters, all served by the worker's host-gated /stats.
import React, { useEffect, useMemo, useState } from 'react';
import { getStats, recordingDownloadUrl } from '../api';
import { listMyRecordings } from '../events';
import { fmtBps, fmtBytes, fmtDuration } from '../metrics';
import { RECORDING_RETENTION_MS } from '../protocol';
import type { Nav } from '../nav';
import { viewerUrl } from '../nav';
import type { StatsResponse } from '../protocol';
import { LogFilterBar, LogRows, filterLog } from '../components/rails';
import { Icon } from '../ui/icons';
import { AreaChart, Avatar, Btn, Pill, cx, type PushToast } from '../ui/primitives';

function BigStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bigstat">
      <div className="bs-value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      <div className="bs-label">{label}</div>
      {sub && <div className="bs-sub">{sub}</div>}
    </div>
  );
}

const fmtClockShort = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function SummaryView({ eventId, hostKey, nav, push }: { eventId: string; hostKey: string; nav: Nav; push: PushToast }) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState('all');
  const recordings = useMemo(() => listMyRecordings().filter((r) => r.eventId === eventId), [eventId]);

  useEffect(() => {
    let cancelled = false;
    getStats(eventId, hostKey)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : 'Stats unavailable.'));
    return () => {
      cancelled = true;
    };
  }, [eventId, hostKey]);

  if (err) {
    return (
      <div className="page fade-in">
        <button className="back-link" onClick={() => nav.dashboard()}><Icon name="arrowLeft" size={15} />Dashboard</button>
        <div className="banner err"><Icon name="alert" size={15} />{err}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page fade-in">
        <button className="back-link" onClick={() => nav.dashboard()}><Icon name="arrowLeft" size={15} />Dashboard</button>
        <div className="muted">Loading recap…</div>
      </div>
    );
  }

  const { meta, stats, log, topChatters, recordings: serverRecs } = data;
  const rows = filterLog(log, logFilter);
  const healthUp = (stats.healthCurve ?? []).map((p) => p.up / 1e6);
  const healthFails = (stats.healthCurve ?? []).reduce((mx, p) => Math.max(mx, p.fail), 0);
  const durSec = meta.startedAt && meta.endedAt ? (meta.endedAt - meta.startedAt) / 1000 : 0;
  const viewerData = stats.curve.map((p) => p.n);
  const chatData = stats.chatCurve.map((p) => p.n);
  const axis = stats.curve.length > 1
    ? [stats.curve[0], stats.curve[Math.floor(stats.curve.length / 2)], stats.curve[stats.curve.length - 1]].map((p) => fmtClockShort(p.at))
    : [];
  const live = meta.status === 'live' || meta.status === 'paused';

  const exportReport = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `streamstudio-${meta.id}-recap.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    push('Report exported', { icon: 'download' });
  };

  return (
    <div className="page fade-in">
      <button className="back-link" onClick={() => nav.dashboard()}><Icon name="arrowLeft" size={15} />Dashboard</button>
      <div className="page-head">
        <div>
          <Pill tone={live ? 'live' : 'neutral'} className="recap-badge" dot={live} pulse={live}>
            {live ? 'Still live' : meta.endedAt ? `Ended · ${new Date(meta.endedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Not started'}
          </Pill>
          <h1 className="page-title" style={{ marginTop: 10 }}>{meta.title}</h1>
          <p className="page-sub mono">
            {durSec > 0 ? `${fmtDuration(durSec)} · ` : ''}{meta.quality}
            {meta.startedAt ? ` · ${new Date(meta.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
          </p>
        </div>
        <span className="spacer" />
        <Btn variant="ghost" icon="download" onClick={exportReport}>Export report</Btn>
        {live
          ? <Btn variant="solid" icon="broadcast" onClick={() => nav.studio(meta.id, hostKey)}>Back to Studio</Btn>
          : <Btn variant="solid" icon="play" onClick={() => window.open(viewerUrl(meta.id), '_blank')}>Watch replay</Btn>}
      </div>

      {/* headline stats */}
      <div className="bigstats">
        <BigStat label="Peak viewers" value={String(stats.peakViewers)} sub={stats.peakAt ? `at ${fmtClockShort(stats.peakAt)}` : undefined} tone="accent" />
        <BigStat label="Unique viewers" value={String(stats.uniqueViewers)} tone="green" />
        <BigStat label="Chat messages" value={String(stats.chatTotal)} sub={`${topChatters.length} chatters`} />
        <BigStat label="Reactions" value={String(stats.emojiTotal)} />
        <BigStat label="RSVPs" value={String(meta.rsvpCount)} sub="saved a spot" />
        <BigStat label="Recording" value={recordings.length ? fmtBytes(recordings.reduce((s, r) => s + r.bytes, 0)) : '—'} sub={recordings.length ? `${recordings.length} part${recordings.length > 1 ? 's' : ''}` : 'none on this device'} />
      </div>

      <div className="summary-cols">
        <div className="col-main">
          {/* watch curve */}
          <div className="card">
            <div className="card-head">
              <h3>Viewers over time</h3>
              <span className="spacer" />
              <div className="row" style={{ gap: 14 }}>
                <span className="legend"><span className="lg-dot" style={{ background: 'var(--accent)' }} />Viewers</span>
                <span className="legend"><span className="lg-dot" style={{ background: 'var(--blue)' }} />Chat / min</span>
              </div>
            </div>
            <div className="card-pad">
              {viewerData.length > 1 ? (
                <>
                  <div className="chart-wrap">
                    <AreaChart data={viewerData} h={210} color="var(--accent)" id="sum1" />
                    {chatData.length > 1 && (
                      <div className="chart-overlay">
                        <AreaChart data={chatData} h={210} color="var(--blue)" fill={false} stroke={1.6} id="sum2" />
                      </div>
                    )}
                  </div>
                  <div className="chart-axis mono">
                    {axis.map((t, i) => <span key={i}>{t}</span>)}
                  </div>
                </>
              ) : (
                <div className="muted" style={{ fontSize: 13 }}>
                  The curve fills in while you're live (one sample every 30 seconds).
                </div>
              )}
            </div>
          </div>

          {/* network health */}
          <div className="card">
            <div className="card-head">
              <h3>Network health</h3>
              <span className="spacer" />
              <span className="legend"><span className="lg-dot" style={{ background: 'var(--green)' }} />Uplink (Mbps)</span>
            </div>
            <div className="card-pad">
              {healthUp.length > 1 ? (
                <>
                  <AreaChart data={healthUp} h={120} color="var(--green)" id="health-up" />
                  <div className="row" style={{ gap: 14, marginTop: 10, fontSize: 12.5, color: 'var(--muted)' }}>
                    <span>avg {fmtBps((stats.healthCurve.reduce((s, p) => s + p.up, 0) / stats.healthCurve.length) || null)}</span>
                    <span className="dotsep">·</span>
                    <span style={{ color: healthFails > 0 ? 'var(--amber)' : 'var(--green)' }}>
                      {healthFails > 0 ? `${healthFails} upload failure${healthFails > 1 ? 's' : ''}` : 'no upload failures'}
                    </span>
                  </div>
                </>
              ) : (
                <div className="muted" style={{ fontSize: 13 }}>
                  Telemetry samples every 30 seconds while you're live — stream for a minute and this fills in.
                </div>
              )}
            </div>
          </div>

          {/* full event log */}
          <div className="card">
            <div className="card-head"><h3>Event log</h3><span className="spacer" /><span className="faint" style={{ fontSize: 12 }}>{log.length} entries</span></div>
            <LogFilterBar value={logFilter} onChange={setLogFilter} />
            <div className="summary-log">
              {rows.length === 0 && <div className="chat-empty">Nothing here.</div>}
              <LogRows log={rows} />
            </div>
          </div>
        </div>

        <div className="col-side">
          {/* cloud recordings — kept 7 days, downloadable from any device */}
          <div className="card">
            <div className="card-head">
              <h3>Cloud recordings</h3>
              <span className="spacer" />
              <span className="faint" style={{ fontSize: 11.5 }}>kept 7 days</span>
            </div>
            <div className="rec-list">
              {serverRecs.length === 0 && (
                <div className="card-pad muted" style={{ fontSize: 12.5 }}>
                  No cloud copy for this event. Turn on “Keep a cloud copy” in Customize → Quality &amp; encoding.
                </div>
              )}
              {serverRecs.map((r) => {
                const expires = r.at + RECORDING_RETENTION_MS;
                const daysLeft = Math.max(0, Math.ceil((expires - Date.now()) / 86_400_000));
                return (
                  <div className="rec-item" key={r.key}>
                    <div className="rec-icon"><Icon name="download" size={15} /></div>
                    <div className="rec-meta">
                      <div className="rec-title">{r.file}</div>
                      <div className="rec-sub mono">{fmtBytes(r.bytes)} · {daysLeft > 0 ? `${daysLeft}d left` : 'expiring'}</div>
                    </div>
                    <a
                      className="iconbtn"
                      href={recordingDownloadUrl(eventId, hostKey, r.key)}
                      download={r.file}
                      aria-label={`Download ${r.file}`}
                    >
                      <Icon name="download" size={16} />
                    </a>
                  </div>
                );
              })}
            </div>
          </div>

          {/* device recordings */}
          <div className="card">
            <div className="card-head"><h3>On this device</h3></div>
            <div className="rec-list">
              {recordings.length === 0 && (
                <div className="card-pad muted" style={{ fontSize: 12.5 }}>
                  No recording from this device. Recordings download as you stop them — check your downloads folder.
                </div>
              )}
              {recordings.map((r) => (
                <div className="rec-item" key={r.at}>
                  <div className="rec-icon"><Icon name="play" size={15} /></div>
                  <div className="rec-meta">
                    <div className="rec-title">{r.file}</div>
                    <div className="rec-sub mono">{fmtBytes(r.bytes)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* top chatters */}
          <div className="card">
            <div className="card-head"><h3>Top chatters</h3></div>
            <div className="chatters">
              {topChatters.length === 0 && <div className="card-pad muted" style={{ fontSize: 12.5 }}>Quiet one — no chat this time.</div>}
              {topChatters.map((c, i) => (
                <div className="chatter" key={c.name}>
                  <span className={cx('chatter-rank', 'mono')}>{i + 1}</span>
                  <Avatar name={c.name} size={28} />
                  <span className="chatter-name">{c.name}</span>
                  <span className="spacer" />
                  <span className="chatter-count mono">{c.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* share */}
          <div className="card card-pad" style={{ display: 'grid', gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14.5 }}>Replay link</h3>
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Viewers can watch the whole thing back from the same link.</p>
            <Btn
              variant="soft"
              size="sm"
              icon="link"
              onClick={() => {
                navigator.clipboard?.writeText(viewerUrl(meta.id)).catch(() => undefined);
                push('Replay link copied', { icon: 'check' });
              }}
            >
              Copy link
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
