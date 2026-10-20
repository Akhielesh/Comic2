// Baby Monitor — home + nursery hub.
// A nursery is a private space for one baby: the people allowed in (with a
// role and a name like "Grandma"), and any device they sign in on can become
// the camera or a viewer. Nothing is ever recorded.
import React, { useEffect, useMemo, useState } from 'react';
import { openAuth, searchPeople, useAccount, type Person } from '../account';
import {
  announceMembersChanged,
  createNursery,
  deleteNursery,
  getDevice,
  listNurseries,
  listPeople,
  monitorError,
  removeMember,
  saveDevice,
  setMember,
  updateNursery,
  type Nursery,
  type NurseryPerson,
} from '../monitor/client';
import { LABEL_SUGGESTIONS, ROLE_INFO, type MonRole } from '../monitor/protocol';
import type { Nav } from '../nav';
import { Icon } from '../ui/icons';
import { Avatar, Btn, Field, Pill, Segmented, cx, type PushToast } from '../ui/primitives';
import { openGuide, useFirstVisitTour } from '../components/Guide';
import { checkBrowser } from '../monitor/camera';
import { hideSetup, setupDone, setupHidden, SETUP_STEPS, type SetupStep } from '../monitor/setupProgress';

/** Ask the watch screen to scroll to a section when it opens (e.g. alerts). */
export const FOCUS_KEY = 'ds-monitor-focus';

const ROLE_ORDER: MonRole[] = ['parent', 'caregiver', 'viewer'];

export function MonitorGate({ children }: { children: React.ReactNode }) {
  const account = useAccount();
  if (account.status === 'loading') {
    return <div className="page"><div className="skeleton" style={{ height: 120 }} aria-label="Loading account" /></div>;
  }
  if (account.status !== 'member') {
    return (
      <div className="page page-narrow fade-in">
        <div className="monitor-hero">
          <div className="mh-icon"><Icon name="baby" size={30} /></div>
          <h1 className="page-title">Baby monitor</h1>
          <p className="page-sub">
            Turn any phone into a private baby camera and watch from your other devices — live, encrypted
            device-to-device, and <b>never recorded</b>. Cry detection, calm/awake tracking and alerts included.
          </p>
          <div className="monitor-points">
            <span><Icon name="lock" size={14} />Private: only people you add, by name</span>
            <span><Icon name="shield" size={14} />Never recorded or stored</span>
            <span><Icon name="bell" size={14} />Cry &amp; camera-offline alerts</span>
          </div>
          {account.status === 'needs_code' ? (
            <Btn variant="solid" size="lg" icon="lock" onClick={() => openAuth('code')}>Enter your welcome code</Btn>
          ) : account.status === 'offline' ? (
            <div className="banner warn"><Icon name="wifi" size={15} />Can’t reach your account right now — check your connection.</div>
          ) : (
            <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              <Btn variant="solid" size="lg" onClick={() => openAuth('create')}>Create account</Btn>
              <Btn variant="ghost" size="lg" onClick={() => openAuth('signin')}>Sign in</Btn>
            </div>
          )}
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function MonitorHome({ nav, push }: { nav: Nav; push: PushToast }) {
  return (
    <MonitorGate>
      <MonitorList nav={nav} push={push} />
    </MonitorGate>
  );
}

function MonitorList({ nav, push }: { nav: Nav; push: PushToast }) {
  const [list, setList] = useState<Nursery[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('Nursery');
  const [baby, setBaby] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  useFirstVisitTour('monitor', list != null);

  const load = async () => {
    const r = await listNurseries();
    if (r.ok) {
      setList(r.nurseries ?? []);
      setErr(null);
      if ((r.nurseries ?? []).length === 0) setCreating(true);
    } else {
      setErr(monitorError(r.error));
      setList([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setBusy(true);
    const r = await createNursery(name, baby, label);
    setBusy(false);
    if (!r.ok || !r.nursery) {
      push(monitorError(r.error), { icon: 'alert' });
      return;
    }
    push('Nursery created — now add a camera', { icon: 'check' });
    nav.nursery(r.nursery.id);
  };

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Baby monitor</h1>
          <p className="page-sub">Private and never recorded. Use one phone as the camera, watch from any of your devices.</p>
        </div>
        <span className="spacer" />
        {!creating && <Btn variant="solid" icon="plus" onClick={() => setCreating(true)} data-tour="monitor-new">New nursery</Btn>}
      </div>

      {err && <div className="banner warn" style={{ marginBottom: 16 }}><Icon name="alert" size={15} />{err}</div>}

      {creating && (
        <div className="card card-pad monitor-create" data-tour="monitor-create">
          <h3 className="serif" style={{ margin: '0 0 4px', fontSize: 20 }}>Set up a nursery</h3>
          <p className="muted" style={{ margin: '0 0 16px', fontSize: 13.5 }}>One nursery per baby or room. You can add family and caregivers next.</p>
          <div className="form-grid">
            <Field label="Room name">
              <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Nursery" />
            </Field>
            <Field label="Baby’s name" hint="optional — used in alerts">
              <input className="input" value={baby} maxLength={40} onChange={(e) => setBaby(e.target.value)} placeholder="e.g. Aria" />
            </Field>
            <Field label="You are…" hint="shown next to your name">
              <input className="input" value={label} maxLength={30} list="label-suggestions" onChange={(e) => setLabel(e.target.value)} placeholder="Mom, Dad, Grandma…" />
            </Field>
          </div>
          <datalist id="label-suggestions">{LABEL_SUGGESTIONS.map((l) => <option key={l} value={l} />)}</datalist>
          <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            {list && list.length > 0 && <Btn variant="ghost" onClick={() => setCreating(false)}>Cancel</Btn>}
            <Btn variant="solid" icon="check" onClick={() => void create()} disabled={busy}>{busy ? 'Creating…' : 'Create nursery'}</Btn>
          </div>
        </div>
      )}

      {list == null ? (
        <div className="skeleton" style={{ height: 96 }} />
      ) : (
        <div className="nursery-grid">
          {list.map((n) => (
            <button key={n.id} className="nursery-card" onClick={() => nav.nursery(n.id)}>
              <div className="nc-top">
                <span className="nc-icon"><Icon name="baby" size={22} /></span>
                <Pill tone={n.my_role === 'parent' ? 'accent' : 'neutral'}>{n.my_label || ROLE_INFO[n.my_role].label}</Pill>
              </div>
              <div className="nc-name">{n.name}</div>
              <div className="nc-sub">
                {n.baby_name ? `${n.baby_name} · ` : ''}{n.member_count} {n.member_count === 1 ? 'person' : 'people'}
                {n.owner_name && n.my_role !== 'parent' ? ` · shared by ${n.owner_name}` : ''}
              </div>
              <div className="nc-actions">
                <span className="nc-act" onClick={(e) => { e.stopPropagation(); nav.monitorWatch(n.id); }}><Icon name="eye" size={14} />Watch</span>
                {n.my_role !== 'viewer' && (
                  <span className="nc-act" onClick={(e) => { e.stopPropagation(); nav.monitorCamera(n.id); }}><Icon name="video" size={14} />Be the camera</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="monitor-howto card card-pad">
        <h3 className="serif" style={{ margin: '0 0 10px', fontSize: 18 }}>How it works</h3>
        <ol>
          <li><b>Camera:</b> on a spare phone, sign in, open the nursery and tap <i>Be the camera</i>. Prop it 1–2 m from the crib, plugged in.</li>
          <li><b>Watch:</b> on your phone or laptop, sign in and tap <i>Watch</i>. Video and sound go device-to-device, encrypted.</li>
          <li><b>Alerts:</b> turn on alerts while watching — a cry or an offline camera notifies you even with the app closed.</li>
          <li><b>Family:</b> add people by searching their name, and give each a role (Parent, Caregiver, Viewer) and a name like “Grandma”.</li>
        </ol>
        <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>
          Not a medical device: it listens and watches, but does not monitor breathing, temperature or safe sleep. Always follow safe-sleep guidance.
        </p>
      </div>
    </div>
  );
}

/* ================================================================ hub */

export function NurseryHub({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  return (
    <MonitorGate>
      <NurseryHubInner id={id} nav={nav} push={push} />
    </MonitorGate>
  );
}

function NurseryHubInner({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  const account = useAccount();
  const [nursery, setNursery] = useState<Nursery | null>(null);
  const [missing, setMissing] = useState(false);
  const [device, setDevice] = useState(getDevice);
  const [editing, setEditing] = useState(false);

  const load = async () => {
    const r = await listNurseries();
    const n = r.nurseries?.find((x) => x.id === id) ?? null;
    setNursery(n);
    setMissing(r.ok && !n);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (missing) {
    return (
      <div className="page page-narrow">
        <div className="banner warn"><Icon name="lock" size={15} />This nursery doesn’t exist or you’re no longer a member.</div>
        <div style={{ marginTop: 14 }}><Btn variant="ghost" icon="arrowLeft" onClick={() => nav.monitor()}>All nurseries</Btn></div>
      </div>
    );
  }
  if (!nursery) return <div className="page"><div className="skeleton" style={{ height: 160 }} /></div>;
  return <NurseryHubBody nursery={nursery} setNursery={setNursery} account={account} device={device} setDevice={setDevice} editing={editing} setEditing={setEditing} id={id} nav={nav} push={push} load={load} />;
}

function NurseryHubBody({ nursery, setNursery, account, device, setDevice, editing, setEditing, id, nav, push, load }: {
  nursery: Nursery;
  setNursery: React.Dispatch<React.SetStateAction<Nursery | null>>;
  account: ReturnType<typeof useAccount>;
  device: ReturnType<typeof getDevice>;
  setDevice: (d: ReturnType<typeof getDevice>) => void;
  editing: boolean;
  setEditing: React.Dispatch<React.SetStateAction<boolean>>;
  id: string;
  nav: Nav;
  push: PushToast;
  load: () => Promise<void>;
}) {
  useFirstVisitTour('nursery');
  const isParent = nursery.my_role === 'parent';
  const isOwner = !!account.userId && nursery.owner_id === account.userId;

  return (
    <div className="page fade-in">
      <button className="back-link" onClick={() => nav.monitor()}><Icon name="arrowLeft" size={15} />All nurseries</button>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">{nursery.name}</h1>
          <p className="page-sub">
            {nursery.baby_name ? `${nursery.baby_name} · ` : ''}You’re {nursery.my_label ? `“${nursery.my_label}”, ` : ''}{ROLE_INFO[nursery.my_role].label.toLowerCase()}
          </p>
        </div>
        <span className="spacer" />
        {isParent && <Btn variant="ghost" size="sm" icon="edit" onClick={() => setEditing((v) => !v)}>Edit</Btn>}
      </div>

      {editing && isParent && <EditNursery nursery={nursery} onSaved={(n) => { setNursery(n); setEditing(false); }} onDeleted={() => nav.monitor()} push={push} canDelete={isOwner} />}

      <SetupChecklist nursery={nursery} nav={nav} />

      <div className="hub-actions" data-tour="hub-actions">
        <button className="hub-big" onClick={() => nav.monitorWatch(id)}>
          <span className="hb-icon"><Icon name="eye" size={26} /></span>
          <b>Watch</b>
          <small>See and hear the nursery live on this device</small>
        </button>
        <button className={cx('hub-big', nursery.my_role === 'viewer' && 'disabled')} disabled={nursery.my_role === 'viewer'} onClick={() => nav.monitorCamera(id)}>
          <span className="hb-icon"><Icon name="video" size={26} /></span>
          <b>Be the camera</b>
          <small>{nursery.my_role === 'viewer' ? 'Viewers can’t run a camera — ask a parent' : 'Use this device in the nursery'}</small>
        </button>
      </div>

      <div className="card card-pad device-card" data-tour="device-name">
        <div className="row" style={{ gap: 12 }}>
          <Icon name="screen" size={18} className="faint" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>This device</div>
            <div className="faint" style={{ fontSize: 12.5 }}>Name it so everyone knows which camera is which</div>
          </div>
          <input
            className="input"
            style={{ maxWidth: 220 }}
            value={device.name}
            maxLength={40}
            aria-label="Device name"
            onChange={(e) => setDevice({ ...device, name: e.target.value })}
            onBlur={() => {
              saveDevice(device);
              push('Device name saved', { icon: 'check', duration: 1500 });
            }}
          />
        </div>
      </div>

      <PeoplePanel nursery={nursery} push={push} onChanged={load} />
    </div>
  );
}

/* ------------------------------------------------------- setup checklist */

function SetupChecklist({ nursery, nav }: { nursery: Nursery; nav: Nav }) {
  const [hidden, setHidden] = useState(() => setupHidden(nursery.id));
  const done = setupDone(nursery.id, nursery.member_count);
  const ios = useMemo(() => checkBrowser().ios, []);
  const canCam = nursery.my_role !== 'viewer';
  const isParent = nursery.my_role === 'parent';
  const watchThen = (focus?: string) => {
    try {
      if (focus) sessionStorage.setItem(FOCUS_KEY, focus);
    } catch { /* storage unavailable */ }
    nav.monitorWatch(nursery.id);
  };
  const steps: Record<SetupStep, { title: string; sub: string; action: { label: string; run: () => void } | null }> = {
    camera: {
      title: 'Start the nursery camera',
      sub: 'On the phone that stays in the nursery: open this nursery → Be the camera. It checks the lens, microphone, light and power for you.',
      action: canCam ? { label: 'Use this device', run: () => nav.monitorCamera(nursery.id) } : null,
    },
    watch: {
      title: 'Watch from the phone you keep with you',
      sub: 'Tap Watch, then “Tap to hear the nursery” to unmute. Leave it open at your bedside or put it away — alerts still reach you.',
      action: { label: 'Watch', run: () => watchThen() },
    },
    alerts: {
      title: 'Turn on alerts on this device',
      sub: ios
        ? 'iPhone: tap Share → Add to Home Screen, open Stream Studio from the Home Screen, then Watch → “Alerts on this device”.'
        : 'Watch → “Alerts on this device”: crying, alarms and an offline camera reach you even with the app closed.',
      action: { label: 'Set up alerts', run: () => watchThen('alerts') },
    },
    talk: {
      title: 'Try talking and a video call',
      sub: 'While watching, tap Talk (or press and hold) — your voice plays in the nursery. Video shows your face on the nursery phone.',
      action: { label: 'Try it', run: () => watchThen() },
    },
    family: {
      title: 'Invite family',
      sub: 'Search a person’s name below, pick Parent, Caregiver or Viewer, and how they appear (Grandma, Nanny…).',
      action: isParent ? { label: 'Add people', run: () => document.querySelector('[data-tour="people"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } : null,
    },
  };
  const count = SETUP_STEPS.filter((s) => done[s]).length;
  if (hidden) {
    return (
      <button className="setup-reopen linkish" onClick={() => { hideSetup(nursery.id, false); setHidden(false); }}>
        <Icon name="checklist" size={14} />Show the setup checklist ({count}/{SETUP_STEPS.length})
      </button>
    );
  }
  const next = SETUP_STEPS.find((s) => !done[s]);
  return (
    <div className="card setup-card" data-tour="hub-checklist">
      <div className="setup-head">
        <Icon name="checklist" size={17} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{count === SETUP_STEPS.length ? 'All set — the nursery is covered' : 'Get set up'}</b>
          <div className="setup-bar" aria-label={`${count} of ${SETUP_STEPS.length} done`}><i style={{ width: `${(count / SETUP_STEPS.length) * 100}%` }} /></div>
        </div>
        <span className="faint mono" style={{ fontSize: 12 }}>{count}/{SETUP_STEPS.length}</span>
        <Btn variant="subtle" size="sm" icon="book" onClick={() => openGuide('setup')}>Guide</Btn>
        <button className="iconbtn" aria-label="Hide the checklist" onClick={() => { hideSetup(nursery.id); setHidden(true); }}><Icon name="x" size={15} /></button>
      </div>
      <ol className="setup-steps">
        {SETUP_STEPS.map((k, i) => (
          <li key={k} className={cx(done[k] && 'done', k === next && 'next')}>
            <span className="setup-num">{done[k] ? <Icon name="check" size={13} stroke={2.4} /> : i + 1}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{steps[k].title}</b>
              {(!done[k] || k === next) && <small>{steps[k].sub}</small>}
            </div>
            {!done[k] && steps[k].action && (
              <Btn variant={k === next ? 'solid' : 'soft'} size="sm" onClick={steps[k].action!.run}>{steps[k].action!.label}</Btn>
            )}
          </li>
        ))}
      </ol>
      <p className="setup-foot faint">Steps tick off on the device where you do them.</p>
    </div>
  );
}

function EditNursery({ nursery, onSaved, onDeleted, push, canDelete }: { nursery: Nursery; onSaved: (n: Nursery) => void; onDeleted: () => void; push: PushToast; canDelete: boolean }) {
  const [name, setName] = useState(nursery.name);
  const [baby, setBaby] = useState(nursery.baby_name ?? '');
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="form-grid">
        <Field label="Room name"><input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Baby’s name"><input className="input" value={baby} maxLength={40} onChange={(e) => setBaby(e.target.value)} /></Field>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        {canDelete && (
          <Btn variant="danger" size="sm" icon="trash" onClick={async () => {
            if (!window.confirm(`Delete “${nursery.name}” for everyone? Its people and history are removed.`)) return;
            const r = await deleteNursery(nursery.id);
            if (r.ok) onDeleted();
            else push(monitorError(r.error), { icon: 'alert' });
          }}>Delete nursery</Btn>
        )}
        <span className="spacer" />
        <Btn variant="solid" size="sm" icon="check" onClick={async () => {
          const r = await updateNursery(nursery.id, name, baby);
          if (r.ok && r.nursery) onSaved(r.nursery);
          else push(monitorError(r.error), { icon: 'alert' });
        }}>Save</Btn>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- people */

function PeoplePanel({ nursery, push, onChanged }: { nursery: Nursery; push: PushToast; onChanged: () => void }) {
  const [people, setPeople] = useState<NurseryPerson[] | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<Person | null>(null);
  const [role, setRole] = useState<MonRole>('caregiver');
  const [label, setLabel] = useState('');
  const isParent = nursery.my_role === 'parent';
  const memberIds = useMemo(() => new Set((people ?? []).map((p) => p.user_id)), [people]);

  const load = async () => {
    const r = await listPeople(nursery.id);
    setPeople(r.ok ? (r.people ?? []) : []);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nursery.id]);

  // Debounced name search across Stream Studio members.
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      void searchPeople(q).then((r) => {
        setResults(r);
        setSearching(false);
      });
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const save = async (userId: string, r: MonRole, l: string, okMsg: string) => {
    const res = await setMember(nursery.id, userId, r, l);
    if (!res.ok) {
      push(monitorError(res.error), { icon: 'alert' });
      return false;
    }
    push(okMsg, { icon: 'check' });
    await load();
    onChanged();
    notifyRoom(nursery.id);
    return true;
  };

  return (
    <div className="card people-card" data-tour="people">
      <div className="card-head">
        <Icon name="users" size={16} />
        <h3>People &amp; roles</h3>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 12 }}>{people?.length ?? 0} / 20</span>
      </div>

      {isParent && (
        <div className="people-add">
          <div className="search-box">
            <Icon name="search" size={15} className="faint" />
            <input
              className="input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find someone by name to add…"
              aria-label="Search people by name"
            />
          </div>
          {q.trim().length >= 2 && (
            <div className="search-results">
              {searching && <div className="faint sr-empty">Searching…</div>}
              {!searching && results.length === 0 && (
                <div className="faint sr-empty">No one named “{q.trim()}” yet. They need a Stream Studio account first — ask them to sign up with the welcome code.</div>
              )}
              {results.map((p) => (
                <button key={p.user_id} className="sr-row" disabled={memberIds.has(p.user_id)} onClick={() => { setAdding(p); setLabel(''); setRole('caregiver'); }}>
                  <Avatar name={p.display_name} size={28} />
                  <span style={{ flex: 1, textAlign: 'left' }}>{p.display_name}</span>
                  {memberIds.has(p.user_id) ? <span className="faint" style={{ fontSize: 12 }}>Already added</span> : <Icon name="plus" size={15} />}
                </button>
              ))}
            </div>
          )}
          {adding && (
            <div className="add-person">
              <div className="row" style={{ gap: 10, marginBottom: 12 }}>
                <Avatar name={adding.display_name} size={34} />
                <b style={{ flex: 1 }}>Add {adding.display_name}</b>
                <button className="iconbtn" onClick={() => setAdding(null)} aria-label="Cancel"><Icon name="x" size={15} /></button>
              </div>
              <RolePicker value={role} onChange={setRole} />
              <Field label="Their name here" hint="e.g. Grandma, Nanny">
                <input className="input" value={label} maxLength={30} list="label-suggestions" onChange={(e) => setLabel(e.target.value)} placeholder="Grandma" />
              </Field>
              <datalist id="label-suggestions">{LABEL_SUGGESTIONS.map((l) => <option key={l} value={l} />)}</datalist>
              <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                <Btn variant="solid" icon="check" onClick={async () => {
                  if (await save(adding.user_id, role, label, `${adding.display_name} added as ${label || ROLE_INFO[role].label}`)) {
                    setAdding(null);
                    setQ('');
                  }
                }}>Add to nursery</Btn>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="people-list">
        {people == null && <div className="skeleton" style={{ height: 60, margin: 16 }} />}
        {people?.map((p) => (
          <PersonRow
            key={p.user_id}
            p={p}
            canEdit={isParent && !p.is_owner}
            canRelabelSelf={p.is_me}
            onSave={(r, l) => save(p.user_id, r, l, `${p.display_name} updated`)}
            onRemove={async () => {
              const leaving = p.is_me;
              if (!window.confirm(leaving ? `Leave “${nursery.name}”? You’ll lose access.` : `Remove ${p.display_name} from “${nursery.name}”? They lose access immediately.`)) return;
              const r = await removeMember(nursery.id, p.user_id);
              if (!r.ok) return push(monitorError(r.error), { icon: 'alert' });
              push(leaving ? 'You left the nursery' : `${p.display_name} removed`, { icon: 'check' });
              notifyRoom(nursery.id);
              if (leaving) location.hash = '#/monitor';
              else await load();
            }}
            canRemove={(isParent && !p.is_owner) || (p.is_me && !p.is_owner)}
          />
        ))}
      </div>

      <div className="role-legend">
        {ROLE_ORDER.map((r) => (
          <div key={r}><b>{ROLE_INFO[r].label}</b> — {ROLE_INFO[r].can}</div>
        ))}
      </div>
    </div>
  );
}

function RolePicker({ value, onChange }: { value: MonRole; onChange: (r: MonRole) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Segmented label="Role" full options={ROLE_ORDER.map((r) => ({ value: r, label: ROLE_INFO[r].label }))} value={value} onChange={(v) => onChange(v as MonRole)} />
      <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>{ROLE_INFO[value].can}</div>
    </div>
  );
}

function PersonRow({ p, canEdit, canRelabelSelf, canRemove, onSave, onRemove }: {
  p: NurseryPerson;
  canEdit: boolean;
  canRelabelSelf: boolean;
  canRemove: boolean;
  onSave: (r: MonRole, l: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(p.role);
  const [label, setLabel] = useState(p.label ?? '');
  const editable = canEdit || canRelabelSelf;
  return (
    <div className="person-row">
      <div className="row" style={{ gap: 12 }}>
        <Avatar name={p.display_name} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pr-name">
            {p.display_name}
            {p.label && <span className="pr-label">{p.label}</span>}
            {p.is_me && <span className="faint" style={{ fontSize: 12 }}> (you)</span>}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>{ROLE_INFO[p.role].label}{p.is_owner ? ' · owner' : ''}</div>
        </div>
        {editable && <Btn variant="subtle" size="sm" icon="edit" onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'Edit'}</Btn>}
      </div>
      {open && (
        <div className="pr-edit">
          {canEdit && <RolePicker value={role} onChange={setRole} />}
          <Field label="Name in this nursery">
            <input className="input" value={label} maxLength={30} list="label-suggestions" onChange={(e) => setLabel(e.target.value)} placeholder="Grandma, Dad…" />
          </Field>
          <div className="row" style={{ marginTop: 10 }}>
            {canRemove && <Btn variant="danger" size="sm" icon="trash" onClick={onRemove}>{p.is_me ? 'Leave' : 'Remove'}</Btn>}
            <span className="spacer" />
            <Btn variant="solid" size="sm" icon="check" onClick={async () => { if (await onSave(canEdit ? role : p.role, label)) setOpen(false); }}>Save</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tell the live room membership changed: removed people are disconnected
 *  immediately and everyone else refreshes their role. */
function notifyRoom(nurseryId: string): void {
  void announceMembersChanged(nurseryId);
}
