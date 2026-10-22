// Invite — "let someone watch", in one sheet, from anywhere:
//   · Add by name: someone with a Stream Studio account. People you already
//     share another nursery with come first (two taps, no wrong "Sarah");
//     the role starts at Viewer, the least they need.
//   · Share a link: for anyone without an account. A passcode is already
//     filled in, so it's one tap to a link — then a QR code to scan, Send
//     (never with the passcode), and the passcode shown once.
//   · Who has access: members, guests, and guests with an account a parent
//     can make a member.
// A real dialog: Esc closes it, focus starts inside and returns to what opened
// it, the page behind is inert, the tabs work with the arrow keys.
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { openAuth, searchPeople, useAccount, type Person } from '../../account';
import { listNurseries, listPeople, removeMember, setMember, type Nursery, type NurseryPerson } from '../../monitor/client';
import { passcodeProblem, shareLink, suggestPasscode } from '../../monitor/guest';
import {
  addMemberError,
  addedMessage,
  adminChannel,
  ago,
  announcePeople,
  endsAt,
  endsIn,
  firstName,
  knownPeople,
  linkMessage,
  onPeopleChanged,
  onShareChannels,
  peopleChanged,
  shareChannelFor,
  shareOrCopy,
  type InviteTab,
  type KnownPerson,
  type ShareChannel,
  type ShareChannelState,
} from '../../monitor/invite';
import { LABEL_SUGGESTIONS, ROLE_INFO, ROLE_INVITE, type MonRole, type ShareInfo, type ShareRequest, type ViewerPresence } from '../../monitor/protocol';
import { markSetup } from '../../monitor/setupProgress';
import { Icon } from '../../ui/icons';
import { Avatar, Btn, Segmented, cx, type PushToast } from '../../ui/primitives';
import { PersonRow } from './PeopleRows';
import { QrCode } from './QrCode';

const MAX_PEOPLE = 20;
const INVITE_ROLES: MonRole[] = ['viewer', 'caregiver', 'parent'];
const DAYS = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '0', label: 'Until I turn it off' },
];
const NO_CHANNEL: ShareChannelState = { connected: false, share: null, err: null, me: null, nursery: null, viewers: null };
const noSub = () => () => undefined;
const noSnap = () => NO_CHANNEL;

/** A suggested passcode that also passes the room's rule for this nursery. */
function freshPasscode(avoid: (string | null | undefined)[]): string {
  let p = suggestPasscode();
  for (let i = 0; i < 6 && passcodeProblem(p, avoid); i++) p = suggestPasscode();
  return p;
}

/** Desktop: focus the first field. Phones: the dialog itself (no keyboard popping over the sheet). */
const finePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

export function InviteSheet({ nid, initialTab, tabRequest, onClose, push }: {
  nid: string;
  initialTab?: InviteTab;
  /** Bumped when Invite is opened again while showing (with `initialTab`). */
  tabRequest?: number;
  onClose: () => void;
  push: PushToast;
}) {
  const account = useAccount();
  const ids = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [host] = useState(() => document.createElement('div'));
  const [announce, setAnnounce] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);

  // The watch screen's socket when it's open for this nursery; else our own (parents).
  const [regTick, setRegTick] = useState(0);
  useEffect(() => onShareChannels(() => setRegTick((t) => t + 1)), []);
  const viewerCh = useMemo(() => shareChannelFor(nid), [nid, regTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewerSt = useSyncExternalStore(viewerCh?.subscribe ?? noSub, viewerCh?.snapshot ?? noSnap);
  const guest = !!viewerSt.me?.guest;

  const [nurseries, setNurseries] = useState<Nursery[] | null>(null);
  const [nursery, setNursery] = useState<Nursery | null | undefined>(undefined);
  const [people, setPeople] = useState<NurseryPerson[] | null>(null);
  const [offline, setOffline] = useState(false);
  const member = account.status === 'member';
  useEffect(() => {
    if (!member || guest) return;
    let alive = true;
    void listNurseries().then((r) => {
      if (!alive) return;
      // Not reachable is not "not a member": say which.
      if (!r.ok) return setOffline(true);
      const list = r.nurseries ?? [];
      setNurseries(list);
      setNursery(list.find((n) => n.id === nid) ?? null);
    });
    return () => {
      alive = false;
    };
  }, [member, guest, nid]);
  const loadPeople = () =>
    void listPeople(nid).then((r) => {
      if (r.ok) setPeople(r.people ?? []);
    });
  useEffect(() => {
    if (!nursery) return;
    loadPeople();
    return onPeopleChanged((n) => {
      if (n === nid) {
        loadPeople();
        void listNurseries().then((r) => r.ok && setNursery(r.nurseries?.find((x) => x.id === nid) ?? null));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nursery?.id, nid]);

  const role: MonRole | null = viewerSt.me?.role ?? nursery?.my_role ?? null;
  const isParent = role === 'parent' && !guest;

  const [adminCh, setAdminCh] = useState<ShareChannel | null>(null);
  useEffect(() => {
    if (viewerCh || !isParent) return;
    const ch = adminChannel(nid);
    setAdminCh(ch);
    return () => {
      ch.close();
      setAdminCh(null);
    };
  }, [viewerCh, isParent, nid]);
  const ch = viewerCh ?? adminCh;
  const st = useSyncExternalStore(ch?.subscribe ?? noSub, ch?.snapshot ?? noSnap);
  const share = isParent ? st.share : null;

  // Guests who joined with the link tick off the checklist's "Invite family" too.
  useEffect(() => {
    if (isParent && share?.guests.length) markSetup(nid, 'family');
  }, [isParent, share?.guests.length, nid]);

  /* ------------------------------------------------------------ tabs */
  const [tab, setTab] = useState<InviteTab>(initialTab ?? 'add');
  const touched = useRef(!!initialTab);
  useEffect(() => {
    if (tabRequest && initialTab) {
      setTab(initialTab);
      touched.current = true;
    }
  }, [tabRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  // A link that's on (or locked) is what parents come back for: open on it — until they pick.
  useEffect(() => {
    if (!touched.current && (share?.on || share?.locked_until)) setTab('link');
  }, [share?.on, share?.locked_until]);
  const pickTab = (t: InviteTab) => {
    touched.current = true;
    setTab(t);
  };

  /* -------------------------------------------------- dialog plumbing */
  // Our own layer on <body>; everything else becomes inert while it's open.
  useLayoutEffect(() => {
    document.body.appendChild(host);
    const others = Array.from(document.body.children).filter((el) => el !== host && !el.hasAttribute('inert')) as HTMLElement[];
    for (const el of others) el.setAttribute('inert', '');
    return () => {
      for (const el of others) el.removeAttribute('inert');
      host.remove();
    };
  }, [host]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const root = sheetRef.current;
      if (!root) return;
      const field = finePointer() ? root.querySelector<HTMLElement>('[data-autofocus]') : null;
      (field ?? root).focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (zoom) setZoom(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [zoom, onClose]);

  const say = (text: string) => {
    // Re-announce the same words too.
    setAnnounce('');
    window.setTimeout(() => setAnnounce(text), 30);
  };

  const name = nursery?.name ?? st.nursery?.name ?? viewerSt.nursery?.name ?? 'the nursery';
  const baby = nursery?.baby_name || st.nursery?.baby || viewerSt.nursery?.baby || 'Your baby';
  const loading = !guest && (account.status === 'loading' || (member && nursery === undefined));

  let body: React.ReactNode;
  if (guest) {
    body = <GuestPanel name={name} viewers={viewerSt.viewers} onLeave={() => { viewerCh?.leave?.(); onClose(); }} />;
  } else if (offline && !nursery) {
    body = <div className="banner warn"><Icon name="wifi" size={15} />Can’t reach your nurseries right now — check your connection and try again.</div>;
  } else if (loading) {
    body = <div className="skeleton" style={{ height: 180 }} aria-label="Loading" />;
  } else if (!member) {
    body = (
      <div className="inv-note">
        <p>Sign in to invite people or see who has access.</p>
        <Btn variant="solid" icon="user" onClick={() => { onClose(); openAuth('signin'); }}>Sign in</Btn>
      </div>
    );
  } else if (!nursery) {
    body = <div className="banner warn"><Icon name="lock" size={15} />This nursery doesn’t exist or you’re no longer a member.</div>;
  } else if (!isParent) {
    body = (
      <>
        <div className="banner info inv-ask"><Icon name="lock" size={15} /><span>Only parents can invite people — ask {nursery.owner_name || 'a parent'}.</span></div>
        <WhoHasAccess nid={nid} nursery={nursery} people={people} share={null} isParent={false} ch={ch} viewers={viewerSt.viewers} push={push} say={say} onLeft={onClose} />
      </>
    );
  } else {
    body = (
      <>
        <InviteTabs ids={ids} tab={tab} onTab={pickTab} />
        <div
          role="tabpanel"
          id={`${ids}-panel-${tab}`}
          aria-labelledby={`${ids}-tab-${tab}`}
          className="inv-panel"
          onPointerDown={() => (touched.current = true)}
          onKeyDown={() => (touched.current = true)}
        >
          {tab === 'add' ? (
            <AddPanel nid={nid} nursery={nursery} nurseries={nurseries} people={people} ch={ch} baby={baby} push={push} say={say} onLinkTab={() => pickTab('link')} />
          ) : (
            <LinkPanel nid={nid} ch={ch} st={st} baby={baby} nurseryName={nursery.name} push={push} say={say} onZoom={setZoom} />
          )}
        </div>
        <WhoHasAccess nid={nid} nursery={nursery} people={people} share={share} isParent ch={ch} viewers={viewerSt.viewers} push={push} say={say} onLeft={onClose} />
      </>
    );
  }

  return createPortal(
    <div className="sheet-scrim inv-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet inv-sheet" role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-sub`} ref={sheetRef} tabIndex={-1}>
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name={isParent ? 'userPlus' : 'users'} size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={`${ids}-title`} className="sheet-title serif">{isParent ? `Invite to ${name}` : guest ? name : `People in ${name}`}</h2>
            <div id={`${ids}-sub`} className="sheet-sub">{baby}’s family can watch live — never recorded.</div>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>
        {body}
        <div className="inv-sr" role="status" aria-live="polite">{announce}</div>
      </div>
      {zoom && (
        <div className="inv-zoom" role="dialog" aria-modal="true" aria-label="QR code for the share link" onClick={() => setZoom(null)}>
          <div className="inv-zoom-tile">
            <QrCode text={zoom} size={320} />
          </div>
          <p>Point the other phone’s camera at the code — then tell them the passcode.</p>
          <Btn variant="soft" icon="x" onClick={() => setZoom(null)} autoFocus>Close</Btn>
        </div>
      )}
    </div>,
    host,
  );
}

/* ------------------------------------------------------------- tabs */

function InviteTabs({ ids, tab, onTab }: { ids: string; tab: InviteTab; onTab: (t: InviteTab) => void }) {
  const tabs: { id: InviteTab; label: string; icon: string }[] = [
    { id: 'add', label: 'Add by name', icon: 'userPlus' },
    { id: 'link', label: 'Share a link', icon: 'link' },
  ];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = tabs.length;
    const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    onTab(tabs[j].id);
    refs.current[j]?.focus();
  };
  return (
    <div className="inv-tabs" role="tablist" aria-label="How to invite">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`${ids}-tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls={`${ids}-panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          className={cx('inv-tab', tab === t.id && 'sel')}
          onClick={() => onTab(t.id)}
          onKeyDown={(e) => onKey(e, i)}
          ref={(el) => {
            refs.current[i] = el;
          }}
        >
          <Icon name={t.icon} size={15} />
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Radio chips with arrow keys (one tab stop for the group). */
function Chips<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string; icon?: string }[]; value: T; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = options.length;
    const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n : -1;
    if (j < 0) return;
    e.preventDefault();
    onChange(options[j].value);
    refs.current[j]?.focus();
  };
  return (
    <div className="inv-chips" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className={cx('inv-chip', value === o.value && 'sel')}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
          ref={(el) => {
            refs.current[i] = el;
          }}
        >
          {o.icon && <Icon name={o.icon} size={13} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Two-step yes/no in place (window.confirm is blocked in some in-app browsers). */
function InlineConfirm({ text, yes, onYes, onNo, danger = true }: { text: string; yes: string; onYes: () => void; onNo: () => void; danger?: boolean }) {
  return (
    <div className="inline-confirm" role="group" aria-label={yes}>
      <span>{text}</span>
      <div className="row" style={{ gap: 8 }}>
        <Btn variant={danger ? 'danger' : 'solid'} size="sm" onClick={onYes}>{yes}</Btn>
        <Btn variant="ghost" size="sm" onClick={onNo} autoFocus>Cancel</Btn>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- add by name */

interface Pick {
  user_id: string;
  display_name: string;
  /** Other nurseries you share with them (suggested), or none (found by search). */
  from: string[] | null;
}

function AddPanel({ nid, nursery, nurseries, people, ch, baby, push, say, onLinkTab }: {
  nid: string;
  nursery: Nursery;
  nurseries: Nursery[] | null;
  people: NurseryPerson[] | null;
  ch: ShareChannel | null;
  baby: string;
  push: PushToast;
  say: (t: string) => void;
  onLinkTab: () => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [suggested, setSuggested] = useState<KnownPerson[] | null>(null);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [role, setRole] = useState<MonRole>('viewer');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; code?: string } | null>(null);
  const [added, setAdded] = useState<(Pick & { role: MonRole }) | null>(null);
  const memberIds = useMemo(() => new Set((people ?? []).map((p) => p.user_id)), [people]);
  const full = (people?.length ?? 0) >= MAX_PEOPLE;

  useEffect(() => {
    if (!nurseries) return;
    let alive = true;
    void knownPeople(nid, nurseries).then((k) => alive && setSuggested(k));
    return () => {
      alive = false;
    };
  }, [nid, nurseries]);

  // Debounced name search; a slow older answer never replaces a newer one.
  const latest = useRef('');
  useEffect(() => {
    const term = q.trim();
    latest.current = term;
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      void searchPeople(term).then((r) => {
        if (latest.current !== term) return;
        setResults(r);
        setSearching(false);
      });
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const pick = (p: Pick) => {
    setPicked(p);
    setRole('viewer');
    setLabel('');
    setErr(null);
  };

  const add = async () => {
    if (!picked || busy) return;
    const who = firstName(picked.display_name);
    setBusy(true);
    setErr(null);
    const r = await setMember(nid, picked.user_id, role, label.trim());
    setBusy(false);
    if (!r.ok) {
      setErr({ text: addMemberError(r.error, who), code: r.error });
      return;
    }
    push(`${who} can now watch ${baby}`, { icon: 'check' });
    say(`${picked.display_name} added as ${ROLE_INFO[role].label}.`);
    markSetup(nid, 'family');
    peopleChanged(nid);
    void announcePeople(nid, ch, [picked.user_id]);
    setAdded({ ...picked, role });
    setPicked(null);
    setQ('');
  };

  const letThemKnow = async () => {
    if (!added) return;
    const msg = addedMessage(nid, baby, nursery.name);
    const r = await shareOrCopy(msg, `${msg.text} ${msg.url}`);
    if (r === 'copied') push('Message copied — paste it to them', { icon: 'copy' });
    else if (r === 'failed') push('Couldn’t open sharing — tell them to open Baby monitor in Stream Studio', { icon: 'info' });
  };

  if (added) {
    const who = firstName(added.display_name);
    return (
      <div className="inv-done">
        <div className="inv-done-icon"><Icon name="check" size={20} stroke={2.4} /></div>
        <b>{who} can now watch {baby}</b>
        <small className="faint">
          As a {ROLE_INFO[added.role].label.toLowerCase()} — {ROLE_INVITE[added.role].toLowerCase()}. They’ll find {nursery.name} under Baby monitor when they sign in. Change it any time below.
        </small>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Btn variant="solid" icon="share" onClick={() => void letThemKnow()}>Let them know</Btn>
          <Btn variant="ghost" icon="userPlus" onClick={() => setAdded(null)}>Add someone else</Btn>
        </div>
      </div>
    );
  }

  if (picked) {
    const who = firstName(picked.display_name);
    return (
      <div className="inv-confirm">
        <div className="row" style={{ gap: 10 }}>
          <Avatar name={picked.display_name} size={38} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <b className="inv-pname">{picked.display_name}</b>
            <small className="faint">{picked.from ? `Also in ${picked.from.join(', ')}` : 'Found by name'}</small>
          </div>
          <button type="button" className="iconbtn" onClick={() => setPicked(null)} aria-label="Choose someone else"><Icon name="x" size={15} /></button>
        </div>
        <div className="inv-field">
          <span>What they can do</span>
          <Chips<MonRole> label="Role" value={role} onChange={setRole} options={INVITE_ROLES.map((r) => ({ value: r, label: ROLE_INFO[r].label }))} />
          <small className="faint">{ROLE_INVITE[role]}. You can change this any time.</small>
        </div>
        <div className="inv-field">
          <span id={`${nid}-as`}>They’ll appear as…</span>
          <div className="inv-chips" role="group" aria-label="Suggested names">
            {LABEL_SUGGESTIONS.slice(0, 6).map((l) => (
              <button key={l} type="button" className={cx('inv-chip', label === l && 'sel')} aria-pressed={label === l} onClick={() => setLabel(label === l ? '' : l)}>{l}</button>
            ))}
          </div>
          <input className="input" value={label} maxLength={30} placeholder="Or type one — e.g. Auntie Jo" aria-labelledby={`${nid}-as`} onChange={(e) => setLabel(e.target.value)} />
        </div>
        {!picked.from && (
          <p className="inv-check"><Icon name="alert" size={14} />Check it’s the right {who} — they’ll see and hear the nursery live.</p>
        )}
        {err && (
          <div className="banner warn" role="alert">
            <Icon name="alert" size={15} />
            <span style={{ flex: 1 }}>{err.text}</span>
            {err.code === 'not_member' && <Btn variant="subtle" size="sm" icon="link" onClick={onLinkTab}>Share a link</Btn>}
          </div>
        )}
        <Btn variant="solid" icon="userPlus" disabled={busy || full} onClick={() => void add()} className="inv-wide">
          {busy ? 'Adding…' : `Add ${who} as ${ROLE_INFO[role].label}`}
        </Btn>
      </div>
    );
  }

  const row = (p: { user_id: string; display_name: string }, from: string[] | null) => {
    const already = memberIds.has(p.user_id);
    return (
      <button key={p.user_id} type="button" className="inv-person" disabled={already || full} onClick={() => pick({ user_id: p.user_id, display_name: p.display_name, from })}>
        <Avatar name={p.display_name} size={32} />
        <span className="inv-person-txt">
          <b>{p.display_name}</b>
          <small className="faint">{already ? 'Already added' : from ? `In ${from.join(', ')}` : 'Stream Studio member'}</small>
        </span>
        {!already && <Icon name="plus" size={16} />}
      </button>
    );
  };
  const term = q.trim();
  const knownIds = new Set((suggested ?? []).map((k) => k.user_id));
  return (
    <div className="inv-add">
      <label className="search-box">
        <Icon name="search" size={15} className="faint" />
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name — e.g. Jo Smith"
          aria-label="Search people by name"
          autoComplete="off"
          data-autofocus
        />
      </label>
      {full && <div className="banner info"><Icon name="info" size={15} /><span>{nursery.name} has {MAX_PEOPLE} people — the most it can have. Remove someone below, or share a link.</span></div>}
      {term.length < 2 ? (
        suggested == null ? (
          <div className="skeleton" style={{ height: 52 }} aria-label="Loading suggestions" />
        ) : suggested.length ? (
          <>
            <div className="inv-sect">From your other nurseries</div>
            <div className="inv-list">{suggested.map((k) => row(k, k.from))}</div>
          </>
        ) : (
          <p className="faint inv-hint">Type at least 2 letters of their name. Only people with a Stream Studio account show up — by name, never their email.</p>
        )
      ) : searching ? (
        <p className="faint inv-hint" aria-live="polite">Searching…</p>
      ) : results.length === 0 ? (
        <div className="inv-empty">
          <p>No Stream Studio account named “{term}”. Share a link instead — no account needed.</p>
          <Btn variant="soft" size="sm" icon="link" onClick={onLinkTab}>Share a link</Btn>
        </div>
      ) : (
        <div className="inv-list" aria-label="People found">{results.map((p) => row(p, knownIds.has(p.user_id) ? (suggested ?? []).find((k) => k.user_id === p.user_id)!.from : null))}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ share a link */

function LinkPanel({ nid, ch, st, baby, nurseryName, push, say, onZoom }: {
  nid: string;
  ch: ShareChannel | null;
  st: ShareChannelState;
  baby: string;
  nurseryName: string;
  push: PushToast;
  say: (t: string) => void;
  onZoom: (link: string) => void;
}) {
  const share: ShareInfo | null = st.share;
  const avoid = [baby, nurseryName];
  const [making, setMaking] = useState(false);
  const [pass, setPass] = useState(() => freshPasscode(avoid));
  const [role, setRole] = useState<'viewer' | 'caregiver'>('viewer');
  const [days, setDays] = useState('7');
  const [newPass, setNewPass] = useState<string | null>(null);
  const [signOut, setSignOut] = useState(false);
  const [confirm, setConfirm] = useState<'off' | 'new' | null>(null);
  const [justSet, setJustSet] = useState<string | null>(null);
  const pending = useRef<{ pass: string; since: number | null; kind: 'link' | 'pass' } | null>(null);

  const link = share?.on && share.code ? shareLink(nid, share.code) : null;
  const passAt = share?.on ? (share.pass_at ?? share.created_at ?? null) : null;

  // The room confirmed the new link (or passcode): now show the passcode, once.
  useEffect(() => {
    const p = pending.current;
    if (!p || passAt == null || passAt === p.since) return;
    pending.current = null;
    setJustSet(p.pass);
    say(p.kind === 'link' ? 'Link ready. The passcode is shown once — copy it or say it out loud.' : 'New passcode set. It’s shown once.');
  }, [passAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // The room refused it: back to the form with it still filled in.
  useEffect(() => {
    const p = pending.current;
    if (!st.err || !p) return;
    pending.current = null;
    if (p.kind === 'link') {
      setPass(p.pass);
      setMaking(true);
    } else setNewPass(p.pass);
  }, [st.err]);

  const send = (msg: Record<string, unknown>) => {
    if (!ch) return;
    ch.set({ err: null });
    ch.send(msg);
  };
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      push(`${what} copied`, { icon: 'check', duration: 1800 });
    } catch {
      push('Couldn’t copy — select it and copy by hand', { icon: 'alert' });
    }
  };

  const problem = passcodeProblem(pass, avoid);
  const create = () => {
    if (problem || !st.connected) return;
    pending.current = { pass, since: passAt, kind: 'link' };
    send({ t: 'share_set', pass, role, days: Number(days) || null });
    setJustSet(null);
    setMaking(false);
    setConfirm(null);
  };
  const newProblem = newPass != null ? passcodeProblem(newPass, avoid) : null;
  const savePass = () => {
    if (newPass == null || newProblem || !st.connected) return;
    pending.current = { pass: newPass, since: passAt, kind: 'pass' };
    send({ t: 'share_pass', pass: newPass, signOut });
    setJustSet(null);
    setNewPass(null);
    setSignOut(false);
  };
  const sendLink = async () => {
    if (!link) return;
    const r = await shareOrCopy(linkMessage(link, baby, nurseryName), link);
    if (r === 'copied') push('Link copied — paste it into a message. Send the passcode separately.', { icon: 'copy', duration: 3500 });
    else if (r === 'shared') say('Link sent. Now tell them the passcode another way.');
    else if (r === 'failed') push('Couldn’t open sharing — use Copy', { icon: 'alert' });
  };

  if (!st.connected && !share) {
    return (
      <div className="inv-wait" aria-live="polite">
        <div className="skeleton" style={{ height: 120 }} />
        <small className="faint">{st.err || 'Connecting to the nursery…'}</small>
      </div>
    );
  }

  const n = share?.guests.length ?? 0;
  const max = share?.max_guests ?? 10;

  if (!link || making) {
    return (
      <div className="inv-make">
        <p className="inv-lead">Anyone with the link <i>and</i> the passcode can watch — no account needed.</p>
        {link && <div className="banner warn"><Icon name="alert" size={15} /><span>A new link replaces the current one — {n ? `the ${n} guest${n === 1 ? '' : 's'} who joined with it ${n === 1 ? 'is' : 'are'} signed out` : 'the old link stops working'}.</span></div>}
        {share?.locked_until && !link && <div className="banner warn"><Icon name="alert" size={15} /><span>The link was locked after wrong passcodes.</span></div>}
        <div className="inv-field">
          <span id={`${nid}-pc`}>Passcode</span>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input mono"
              style={{ flex: 1, minWidth: 0 }}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-labelledby={`${nid}-pc`}
              aria-describedby={`${nid}-pc-hint`}
              aria-invalid={!!problem}
            />
            <Btn variant="subtle" size="sm" icon="refresh" onClick={() => setPass(freshPasscode(avoid))}>Another one</Btn>
          </div>
          <small id={`${nid}-pc-hint`} className={cx('faint', problem && 'share-problem')}>
            {problem ?? 'Easy to say out loud. You’ll send it separately from the link.'}
          </small>
        </div>
        <div className="inv-field">
          <span>Guests can</span>
          <Chips<'viewer' | 'caregiver'>
            label="What guests can do"
            value={role}
            onChange={setRole}
            options={[
              { value: 'viewer', label: 'Watch & listen', icon: 'eye' },
              { value: 'caregiver', label: 'Also talk, soothe & answer alerts', icon: 'heart' },
            ]}
          />
        </div>
        <div className="inv-field">
          <span>Link works for</span>
          <Segmented label="Link works for" options={DAYS} value={days} onChange={setDays} />
        </div>
        {st.err && <div className="banner warn" role="alert"><Icon name="alert" size={15} /><span>{st.err}</span></div>}
        <div className="row" style={{ gap: 8 }}>
          <Btn variant="solid" icon="link" disabled={!st.connected || !!problem} onClick={create} className="inv-wide">Create link</Btn>
          {link && <Btn variant="ghost" onClick={() => setMaking(false)}>Cancel</Btn>}
        </div>
        {!st.connected && <small className="faint">Reconnecting to the nursery…</small>}
      </div>
    );
  }

  return (
    <div className="inv-live">
      {share!.locked_until && (
        <div className="banner warn">
          <Icon name="alert" size={15} />
          <span>Someone entered the wrong passcode 5 times — the link is locked {endsIn(share!.locked_until)}. If that wasn’t a guest you invited, turn the link off or set a new passcode.</span>
        </div>
      )}
      <div className="inv-link">
        <button type="button" className="inv-qr" onClick={() => onZoom(link)} aria-label="Show the QR code bigger, to scan with another phone">
          <QrCode text={link} size={150} />
          <span className="inv-qr-hint"><Icon name="maximize" size={12} />Tap to enlarge</span>
        </button>
        <div className="inv-link-side">
          <code className="inv-url" title={link}>{link.replace(/^https?:\/\//, '')}</code>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="solid" size="sm" icon="share" onClick={() => void sendLink()}>Send</Btn>
            <Btn variant="soft" size="sm" icon="copy" onClick={() => void copy(link, 'Link')}>Copy</Btn>
          </div>
          <small className="faint inv-status">
            {share!.role === 'caregiver' ? 'Watch, talk, soothe & answer alerts' : 'Watch & listen'}
            {' · '}
            {share!.expires_at ? `ends ${endsAt(share!.expires_at)}` : 'until you turn it off'}
            {' · '}
            {n} of {max} guests
            {share!.created_by ? ` · made by ${share!.created_by}` : ''}
          </small>
        </div>
      </div>

      <div className="inv-pass">
        {justSet ? (
          <div className="banner info inv-pass-shown">
            <Icon name="lock" size={15} />
            <span style={{ flex: 1 }}>
              Passcode <b className="mono">{justSet}</b> — say it out loud or send it in a different app. You won’t see it again.
            </span>
            <Btn variant="subtle" size="sm" icon="copy" onClick={() => void copy(justSet, 'Passcode')}>Copy</Btn>
          </div>
        ) : newPass != null ? (
          <div className="inv-field">
            <span id={`${nid}-np`}>New passcode — same link</span>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input mono"
                style={{ flex: 1, minWidth: 0 }}
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-labelledby={`${nid}-np`}
                aria-invalid={!!newProblem}
              />
              <Btn variant="subtle" size="sm" icon="refresh" onClick={() => setNewPass(freshPasscode(avoid))}>Another one</Btn>
            </div>
            <small className={cx('faint', newProblem && 'share-problem')}>{newProblem ?? 'The link stays the same — only the passcode changes.'}</small>
            <label className="inv-check-row">
              <input type="checkbox" checked={signOut} onChange={(e) => setSignOut(e.target.checked)} />
              <span>Also sign out the {n ? `${n} guest${n === 1 ? '' : 's'} watching with it` : 'current guests'}</span>
            </label>
            {st.err && <div className="banner warn" role="alert"><Icon name="alert" size={15} /><span>{st.err}</span></div>}
            <div className="row" style={{ gap: 8 }}>
              <Btn variant="solid" size="sm" icon="lock" disabled={!!newProblem || !st.connected} onClick={savePass}>Save passcode</Btn>
              <Btn variant="ghost" size="sm" onClick={() => setNewPass(null)}>Cancel</Btn>
            </div>
          </div>
        ) : (
          <div className="inv-pass-hidden">
            <Icon name="lock" size={15} />
            <span>Passcode hidden — we keep only a scrambled copy, so we can’t show it again.</span>
            <button type="button" className="linkish" onClick={() => setNewPass(freshPasscode(avoid))}>Set a new passcode</button>
          </div>
        )}
      </div>

      {confirm === 'off' ? (
        <InlineConfirm
          text={`Turn the link off? ${n ? `${n} guest${n === 1 ? ' is' : 's are'} signed out right away.` : 'Nobody can join with it after that.'}`}
          yes="Turn off"
          onYes={() => {
            send({ t: 'share_off' });
            setConfirm(null);
            setJustSet(null);
            say('The share link is off.');
          }}
          onNo={() => setConfirm(null)}
        />
      ) : confirm === 'new' ? (
        <InlineConfirm
          text={`Make a new link? The current one stops working${n ? ` and its ${n} guest${n === 1 ? ' is' : 's are'} signed out` : ''} — you’ll send the new link and passcode again.`}
          yes="Make a new link"
          danger={false}
          onYes={() => {
            setConfirm(null);
            setPass(freshPasscode(avoid));
            setMaking(true);
          }}
          onNo={() => setConfirm(null)}
        />
      ) : (
        <div className="inv-actions">
          {share!.expires_at && (
            <Btn variant="subtle" size="sm" icon="clock" onClick={() => { send({ t: 'share_extend', days: 7 }); say('Link extended by 7 days.'); }}>+7 days</Btn>
          )}
          <Btn variant="subtle" size="sm" icon="refresh" onClick={() => setConfirm('new')}>New link</Btn>
          <Btn variant="danger" size="sm" icon="x" onClick={() => setConfirm('off')}>Turn off</Btn>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------- who has access */

function WhoHasAccess({ nid, nursery, people, share, isParent, ch, viewers, push, say, onLeft }: {
  nid: string;
  nursery: Nursery;
  people: NurseryPerson[] | null;
  share: ShareInfo | null;
  isParent: boolean;
  ch: ShareChannel | null;
  viewers: ViewerPresence[] | null;
  push: PushToast;
  say: (t: string) => void;
  onLeft: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const requests: ShareRequest[] = share?.requests ?? [];
  const watchingNames = new Set((viewers ?? []).filter((v) => !v.guest).map((v) => v.name));

  const save = async (p: NurseryPerson, r: MonRole, l: string) => {
    const res = await setMember(nid, p.user_id, r, l);
    if (!res.ok) {
      push(addMemberError(res.error, firstName(p.display_name)), { icon: 'alert' });
      return false;
    }
    push(`${p.display_name} updated`, { icon: 'check' });
    peopleChanged(nid);
    void announcePeople(nid, ch, [p.user_id]);
    return true;
  };
  const remove = async (p: NurseryPerson) => {
    const r = await removeMember(nid, p.user_id);
    if (!r.ok) return push(addMemberError(r.error, firstName(p.display_name)), { icon: 'alert' });
    push(p.is_me ? 'You left the nursery' : `${p.display_name} removed`, { icon: 'check' });
    void announcePeople(nid, ch, [p.user_id]);
    peopleChanged(nid);
    if (p.is_me) {
      onLeft();
      location.hash = '#/monitor';
    }
  };
  const makeMember = async (r: ShareRequest) => {
    setBusy(r.id);
    const res = await setMember(nid, r.uid, r.role, '');
    setBusy(null);
    if (!res.ok) return push(addMemberError(res.error, firstName(r.account)), { icon: 'alert', duration: 5000 });
    await announcePeople(nid, ch, [r.uid]);
    push(`${r.name} is now a member — they’ll watch with their own account`, { icon: 'check', duration: 4000 });
    say(`${r.name} is now a member.`);
    markSetup(nid, 'family');
    peopleChanged(nid);
  };

  return (
    <section className="inv-access" aria-labelledby={`${nid}-who`}>
      <div className="inv-access-head">
        <h3 id={`${nid}-who`}>Who has access</h3>
        <span className="faint">
          {people ? `${people.length} of ${MAX_PEOPLE} people` : '…'}
          {share?.on ? ` · link: ${share.guests.length} of ${share.max_guests ?? 10} guests` : ''}
        </span>
      </div>
      {viewers && viewers.length > 0 && (
        <p className="inv-now"><span className="inv-dot" aria-hidden />Watching now: {viewers.map((v) => `${v.label || v.name}${v.guest ? ' (guest)' : ''}`).join(', ')}</p>
      )}

      {isParent && requests.length > 0 && (
        <div className="inv-requests">
          {requests.map((r) => (
            <div key={r.id} className="inv-req">
              <Avatar name={r.account} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{r.name}</b> joined with the link and has a Stream Studio account{r.account && r.account !== r.name ? ` (${r.account})` : ''}.
                <small className="faint">Make them a member so they watch with their own account — no passcode, no end date.</small>
                <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <Btn variant="solid" size="sm" icon="userPlus" disabled={busy === r.id} onClick={() => void makeMember(r)}>{busy === r.id ? 'Adding…' : 'Make member'}</Btn>
                  <Btn variant="ghost" size="sm" onClick={() => ch?.send({ t: 'request_dismiss', id: r.id })}>Keep as guest</Btn>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="inv-sub">People with an account</div>
      {people == null ? (
        <div className="skeleton" style={{ height: 52 }} />
      ) : (
        <div className="people-list inv-people">
          {people.map((p) => (
            <PersonRow
              key={p.user_id}
              p={p}
              nurseryName={nursery.name}
              canEdit={isParent && !p.is_owner}
              canRelabelSelf={p.is_me}
              canRemove={(isParent && !p.is_owner) || (p.is_me && !p.is_owner)}
              watching={watchingNames.has(p.display_name)}
              onSave={(r, l) => save(p, r, l)}
              onRemove={() => void remove(p)}
            />
          ))}
          {people.length === 1 && isParent && <p className="faint inv-hint">It’s just you so far. Invite the other parent, grandparents or a sitter.</p>}
        </div>
      )}

      {share && (
        <>
          <div className="inv-sub">Guests with the link</div>
          {share.guests.length === 0 ? (
            <p className="faint inv-hint">{share.on ? 'Nobody has joined with the link yet.' : 'No link right now — guests need one to watch.'}</p>
          ) : (
            <div className="inv-guests">
              {share.guests.map((g) =>
                removing === g.id ? (
                  <InlineConfirm
                    key={g.id}
                    text={`Remove ${g.name}? Their guest pass ends right away.`}
                    yes="Remove"
                    onYes={() => {
                      ch?.send({ t: 'guest_remove', id: g.id });
                      setRemoving(null);
                      say(`${g.name} removed.`);
                    }}
                    onNo={() => setRemoving(null)}
                  />
                ) : (
                  <div key={g.id} className="inv-guest-row">
                    <Avatar name={g.name} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>{g.name}</b>
                      <small className="faint">{g.role === 'caregiver' ? 'Watch & help' : 'Watch & listen'} · joined {ago(g.created_at)} · seen {ago(g.last_seen)}</small>
                    </div>
                    {isParent && <button type="button" className="linkish danger" onClick={() => setRemoving(g.id)} aria-label={`Remove ${g.name}`}>Remove</button>}
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- guest */

function GuestPanel({ name, viewers, onLeave }: { name: string; viewers: ViewerPresence[] | null; onLeave: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="inv-guestme">
      <p>You’re watching {name} as a guest, with the share link. A parent can end your guest pass at any time.</p>
      {viewers && viewers.length > 0 && (
        <p className="inv-now"><span className="inv-dot" aria-hidden />Watching now: {viewers.map((v) => `${v.label || v.name}${v.guest ? ' (guest)' : ''}`).join(', ')}</p>
      )}
      <p className="faint">Have a Stream Studio account? Ask a parent to add you by name — then you can watch with your account, no passcode.</p>
      {confirm ? (
        <InlineConfirm text="Leave this nursery? You’ll need the link and passcode to come back." yes="Leave" onYes={onLeave} onNo={() => setConfirm(false)} />
      ) : (
        <Btn variant="danger" size="sm" icon="logout" onClick={() => setConfirm(true)}>Leave this nursery</Btn>
      )}
    </div>
  );
}
