// Right-rail panels shared by the Studio and Viewer: chat, people, activity
// log and stream health. All fed by the real EventRoom socket.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/icons';
import { AreaChart, Avatar, Btn, IconBtn, Meter, cx } from '../ui/primitives';
import { fmtBps } from '../metrics';
import type { ChatMsg, LobbyEntry, LogEntry, LogKind, PersonEntry, Role } from '../protocol';
import { EMOJI_LIBRARY, QUICK_EMOJI } from '../emoji';

/* --------------------------------------------------------------- helpers */

export const fmtAgo = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};

const fmtLogTime = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export const LOG_STYLE: Record<LogKind, [string, string]> = {
  live: ['var(--green)', 'var(--green-wash)'],
  join: ['var(--accent-ink)', 'var(--chip)'],
  scene: ['var(--blue)', 'var(--blue-wash)'],
  warn: ['var(--amber)', 'var(--amber-wash)'],
  err: ['var(--live)', 'var(--live-wash)'],
  rec: ['var(--live)', 'var(--live-wash)'],
  mod: ['var(--accent)', 'var(--accent-wash)'],
  sys: ['var(--faint)', 'var(--panel-3)'],
};

const roleClass = (role: Role): string | null =>
  role === 'host' ? 'host' : role === 'mod' ? 'mod' : null;

/* ----------------------------------------------------------- reactions ---- */

/** One-tap quick reactions + a "+" picker over the full emoji library. */
export function ReactBar({ onReact, vertical, compact }: { onReact: (e: string) => void; vertical?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const quick = compact ? QUICK_EMOJI.slice(0, 4) : QUICK_EMOJI;
  return (
    <div className={cx('react-bar', vertical && 'vertical')}>
      {quick.map((e) => (
        <button key={e} className="vc-react" onClick={() => onReact(e)} aria-label={`React ${e}`}>{e}</button>
      ))}
      <button className={cx('vc-react', 'more', open && 'active')} onClick={() => setOpen((o) => !o)} aria-label="More reactions" aria-expanded={open}>
        <Icon name="plus" size={15} />
      </button>
      {open && (
        <div className="emoji-pop" role="menu" aria-label="All reactions">
          {EMOJI_LIBRARY.map((e) => (
            <button key={e} className="emoji-pop-btn" role="menuitem" onClick={() => { onReact(e); setOpen(false); }} aria-label={`React ${e}`}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Chat ---- */

export function ChatRail({ chat, pinned, slowSec, reactionsOn, canModerate, onSend, onReact, onDelete, onUnpin, composerRef }: {
  chat: ChatMsg[];
  pinned: string | null;
  slowSec?: number;
  reactionsOn?: boolean;
  canModerate?: boolean;
  onSend: (text: string) => void;
  onReact: (e: string) => void;
  onDelete?: (id: string) => void;
  onUnpin?: () => void;
  composerRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);
  const send = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft('');
  };
  return (
    <div className="rail-panel">
      {pinned && (
        <div className="chat-pin">
          <Icon name="pin" size={14} />
          <span>{pinned}</span>
          {onUnpin && (
            <button className="cp-x iconbtn" style={{ width: 22, height: 22 }} onClick={onUnpin} aria-label="Unpin message">
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
      )}
      <div className="chat-list" ref={listRef} aria-live="polite">
        {chat.length === 0 && <div className="chat-empty">No messages yet — say hi</div>}
        {chat.map((m) => (
          <div className="chat-msg" key={m.id}>
            <Avatar name={m.name} size={28} />
            <div className="cm-body">
              <div className="cm-head">
                <span className="cm-name">{m.name}</span>
                {roleClass(m.role) && <span className={`cm-role ${roleClass(m.role)}`}>{m.role}</span>}
                <span className="cm-time">{fmtAgo(m.at)}</span>
              </div>
              <div className="cm-text">{m.text}</div>
            </div>
            {canModerate && onDelete && (
              <button className="cm-del iconbtn" style={{ width: 24, height: 24 }} onClick={() => onDelete(m.id)} aria-label={`Delete message from ${m.name}`}>
                <Icon name="trash" size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="composer">
        {reactionsOn !== false && (
          <div className="reactions-row">
            <ReactBar onReact={onReact} />
          </div>
        )}
        <div className="input-row">
          <input
            ref={composerRef}
            className="input"
            value={draft}
            placeholder="Send a message…"
            maxLength={400}
            aria-label="Chat message"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          <Btn variant="solid" size="sm" className="send" icon="send" onClick={send} aria-label="Send" />
        </div>
        {!!slowSec && slowSec > 0 && <div className="slow-note">Slow mode — one message every {slowSec}s</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- People ---- */

export interface GuestSeat {
  sid: string;
  name: string;
  state: RTCPeerConnectionState;
}

export function PeopleRail({ hostName, people, lobby, guests = [], onCopyGuestInvite, onRotateGuestInvite, onAdmit, onDeny, onKick, onPromote }: {
  hostName: string;
  people: PersonEntry[];
  lobby: LobbyEntry[];
  /** Connected on-air guest seats (WebRTC links to the studio). */
  guests?: GuestSeat[];
  /** Present when the studio has a guest invite link to share. */
  onCopyGuestInvite?: () => void;
  /** Rotates the guest key — every previously shared guest link goes dead. */
  onRotateGuestInvite?: () => void;
  onAdmit: (sid: string) => void;
  onDeny: (sid: string) => void;
  onKick: (sid: string) => void;
  onPromote: (sid: string) => void;
}) {
  const mods = people.filter((p) => p.role === 'mod');
  const viewers = people.filter((p) => p.role === 'viewer');
  return (
    <div className="rail-panel">
      <div className="people-scroll">
        <div className="people-sect">On air · {1 + guests.length}</div>
        <div className="person">
          <Avatar name={hostName} size={34} ring />
          <div className="pz-meta">
            <div className="pz-name">
              You <span className="cm-role host">host</span>
            </div>
            <div className="pz-note">Running the studio</div>
          </div>
        </div>
        {guests.map((g) => (
          <div className="person" key={g.sid}>
            <Avatar name={g.name} size={34} ring={g.state === 'connected'} />
            <div className="pz-meta">
              <div className="pz-name">
                {g.name} <span className="cm-role mod">guest</span>
              </div>
              <div className="pz-note">
                {g.state === 'connected' ? 'On the program — cam & mic mixed in'
                  : g.state === 'failed' ? 'Link failed (restrictive network)'
                  : 'Linking…'}
              </div>
            </div>
            <div className="pz-ctl">
              <IconBtn name="x" size={15} label={`Remove guest ${g.name}`} className="person-mini" onClick={() => onKick(g.sid)} />
            </div>
          </div>
        ))}
        {onCopyGuestInvite && (
          <div className="row" style={{ padding: '2px 14px 10px', gap: 6, flexWrap: 'wrap' }}>
            <Btn variant="subtle" size="sm" icon="users" onClick={onCopyGuestInvite}>
              {guests.length === 0 ? 'Invite guests on air' : 'Copy guest invite link'}
            </Btn>
            {onRotateGuestInvite && (
              <Btn variant="ghost" size="sm" icon="refresh" onClick={onRotateGuestInvite} title="Old guest links stop working">
                New link
              </Btn>
            )}
          </div>
        )}

        {lobby.length > 0 && <div className="people-sect">Lobby · {lobby.length}</div>}
        {lobby.map((p) => (
          <div className="person" key={p.sid}>
            <Avatar name={p.name} size={34} />
            <div className="pz-meta">
              <div className="pz-name">{p.name}</div>
              <div className="pz-note">Waiting to join</div>
            </div>
            <div className="lobby-actions">
              <Btn variant="solid" size="sm" onClick={() => onAdmit(p.sid)}>Admit</Btn>
              <Btn variant="subtle" size="sm" onClick={() => onDeny(p.sid)}>Deny</Btn>
            </div>
          </div>
        ))}

        {mods.length > 0 && <div className="people-sect">Moderators · {mods.length}</div>}
        {mods.map((p) => (
          <div className="person" key={p.sid}>
            <Avatar name={p.name} size={34} />
            <div className="pz-meta">
              <div className="pz-name">
                {p.name} <span className="cm-role mod">mod</span>
              </div>
              <div className="pz-note">Can moderate chat &amp; lobby</div>
            </div>
            <div className="pz-ctl">
              <IconBtn name="x" size={15} label={`Remove ${p.name}`} className="person-mini" onClick={() => onKick(p.sid)} />
            </div>
          </div>
        ))}

        <div className="people-sect">Watching · {viewers.length}</div>
        {viewers.length === 0 && <div className="pz-note" style={{ padding: '4px 14px 14px' }}>Nobody here yet — share the viewer link.</div>}
        {viewers.map((p) => (
          <div className="person" key={p.sid}>
            <Avatar name={p.name} size={34} />
            <div className="pz-meta">
              <div className="pz-name">{p.name}</div>
              <div className="pz-note">Watching</div>
            </div>
            <div className="pz-ctl">
              <IconBtn name="star" size={15} label={`Make ${p.name} a moderator`} className="person-mini" onClick={() => onPromote(p.sid)} />
              <IconBtn name="x" size={15} label={`Remove ${p.name}`} className="person-mini" onClick={() => onKick(p.sid)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Activity ---- */

const LOG_FILTERS: { id: string; label: string; kinds: LogKind[] | null }[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'live', label: 'Stream', kinds: ['live', 'rec'] },
  { id: 'join', label: 'People', kinds: ['join', 'mod'] },
  { id: 'scene', label: 'Scenes', kinds: ['scene'] },
  { id: 'warn', label: 'Warnings', kinds: ['warn', 'err'] },
  { id: 'sys', label: 'System', kinds: ['sys'] },
];

export function LogRows({ log }: { log: LogEntry[] }) {
  return (
    <>
      {log.map((r, i) => {
        const [color, bg] = LOG_STYLE[r.kind] || LOG_STYLE.sys;
        return (
          <div className="log-row" key={`${r.at}-${i}`}>
            <span className="log-time">{fmtLogTime(r.at)}</span>
            <span className="log-tag" style={{ color, background: bg }}>{r.tag}</span>
            <span className="log-msg">{r.msg}</span>
          </div>
        );
      })}
    </>
  );
}

export function LogFilterBar({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="log-toolbar" role="toolbar" aria-label="Filter log">
      {LOG_FILTERS.map((f) => (
        <button key={f.id} className={cx('log-filter', value === f.id && 'active')} onClick={() => onChange(f.id)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

export const filterLog = (log: LogEntry[], filter: string): LogEntry[] => {
  const def = LOG_FILTERS.find((f) => f.id === filter);
  return def?.kinds ? log.filter((r) => def.kinds!.includes(r.kind)) : log;
};

export function ActivityRail({ log }: { log: LogEntry[] }) {
  const [filter, setFilter] = useState('all');
  const rows = filterLog(log, filter);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  return (
    <div className="rail-panel">
      <LogFilterBar value={filter} onChange={setFilter} />
      <div className="log-list" ref={listRef}>
        {rows.length === 0 && <div className="chat-empty">Nothing yet.</div>}
        <LogRows log={rows} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Health ---- */

export function HealthRail({ upBps, encBps, targetBps, minUplinkMbps, failures, lastSeq, behindSec, fps, viewers, viewerCurve, mime }: {
  upBps: number | null;
  encBps: number | null;
  targetBps: number;
  minUplinkMbps: number;
  failures: number;
  lastSeq: number;
  behindSec: number | null;
  fps: number;
  viewers: number;
  viewerCurve: number[];
  mime: string | null;
}) {
  const upMbps = (upBps ?? 0) / 1e6;
  const healthy = upBps == null || upMbps >= (targetBps / 1e6) * 1.1;
  return (
    <div className="health-panel">
      <div>
        <div className="hs-head">
          <span className="hs-label">Uplink</span>
          <span className="hs-value" style={{ color: healthy ? 'var(--green)' : 'var(--amber)' }}>
            {fmtBps(upBps)} / need ≥ {minUplinkMbps} Mbps
          </span>
        </div>
        <Meter value={Math.min(upMbps, minUplinkMbps * 1.5)} max={minUplinkMbps * 1.5} tone={healthy ? 'green' : 'amber'} height={7} />
        <div className="pz-note" style={{ marginTop: 6 }}>
          {healthy ? 'Headroom healthy' : 'Uplink tight — consider a lower preset'} · target {fmtBps(targetBps)}
        </div>
      </div>
      <div className="health-grid">
        <div className="health-tile">
          <div className="ht-label">Encoded</div>
          <div className="ht-value">{fmtBps(encBps)}</div>
          <div className="ht-sub">target {fmtBps(targetBps)}</div>
        </div>
        <div className="health-tile">
          <div className="ht-label">Failures</div>
          <div className="ht-value" style={{ color: failures > 0 ? 'var(--amber)' : 'var(--green)' }}>{failures}</div>
          <div className="ht-sub">segment uploads</div>
        </div>
        <div className="health-tile">
          <div className="ht-label">Latency</div>
          <div className="ht-value">{behindSec != null ? `${behindSec.toFixed(1)}` : '—'}<span style={{ fontSize: 12, color: 'var(--faint)' }}> s</span></div>
          <div className="ht-sub">segmented delivery</div>
        </div>
        <div className="health-tile">
          <div className="ht-label">Program</div>
          <div className="ht-value">{fps}<span style={{ fontSize: 12, color: 'var(--faint)' }}> fps</span></div>
          <div className="ht-sub">seg #{lastSeq || '—'}</div>
        </div>
      </div>
      <div>
        <div className="hs-head">
          <span className="hs-label">Viewers · this session</span>
          <span className="hs-value">{viewers}</span>
        </div>
        <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: '12px 8px 4px' }}>
          <AreaChart data={viewerCurve.length > 1 ? viewerCurve : [0, viewers]} h={90} color="var(--accent)" id="health" />
        </div>
      </div>
      <div>
        <div className="hs-head">
          <span className="hs-label">Delivery rail</span>
          <span className="hs-value mono" style={{ fontSize: 11.5 }}>{mime ? mime.split(';')[0].replace('video/', '').toUpperCase() : '—'} · R2</span>
        </div>
        <div className="pz-note">Self-contained segments → R2 → CDN cache. 100 viewers ≈ 1 read.</div>
      </div>
    </div>
  );
}
