// Customize — scenes, camera looks, chat & reactions, quality & encoding,
// alerts and hotkeys. Every control writes StudioPrefs; the Studio reads them
// when it opens (and pushes slow-mode to the room at go-live).
import React, { useEffect, useState } from 'react';
import { openAuth, signOutThisDevice, updateDisplayName, useAccount } from '../account';
import { LIMIT_CHOICES_MIN, limitLabel } from '../limits';
import { canPickFolder, forgetDriveFolder, getDriveFolder, pickDriveFolder } from '../saveTargets';
import {
  DRIVE_PRIVACY_NOTE,
  DriveError,
  connectDrive,
  disconnectDrive,
  driveErrorMessage,
  getDriveStatus,
  openConsentWindow,
  useDriveStatus,
} from '../driveUpload';
import { QUALITY_PRESETS, presetById } from '../config';
import type { Nav } from '../nav';
import { DEFAULT_PREFS, LOOK_LABELS, loadPrefs, playChime, savePrefs, type StudioPrefs } from '../prefs';
import { normalizeQuick } from '../emoji';
import { QuickBarEditor } from '../components/EmojiPicker';
import { StudiosCard, useAccountAccess } from '../components/StudiosCard';
import { NAME_MAX, cleanName } from '@/shared/accountName';
import { SCENES } from '../studio/compositor';
import { SceneSketch } from '../components/scenes';
import { Icon } from '../ui/icons';
import { Btn, Field, Segmented, Slider, Toggle, cx, type PushToast } from '../ui/primitives';
import { fetchStudioAccess, pullPrefsFromCloud, pushPrefsToCloud, syncMyEvents, type StudioAccess } from '../sync';
import { cloudCopySettingDesc } from '../costCopy';
import { AccountUsageCard } from './settings/UsageCard';
import { SecurityPanel, confirmAndSignOutEverywhere } from './account/SecurityPanel';
import { askForCode } from './account/StepUp';

const SET_CATS = [
  { id: 'account', label: 'Account & sync', icon: 'user' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'usage', label: 'Usage', icon: 'gauge' },
  { id: 'scenes', label: 'Scenes', icon: 'layers' },
  { id: 'camera', label: 'Camera & looks', icon: 'video' },
  { id: 'chat', label: 'Chat & reactions', icon: 'chat' },
  { id: 'recording', label: 'Recording & saving', icon: 'record' },
  { id: 'encoding', label: 'Quality & encoding', icon: 'sliders' },
  { id: 'alerts', label: 'Alerts', icon: 'bell' },
  { id: 'hotkeys', label: 'Hotkeys', icon: 'keyboard' },
];

const HOTKEYS: { keys: string[]; action: string }[] = [
  { keys: ['G'], action: 'Go live / end stream' },
  { keys: ['Space'], action: 'Mute / unmute mic' },
  { keys: ['V'], action: 'Camera on / off' },
  { keys: ['R'], action: 'Start / stop recording' },
  { keys: ['1', '–', '6'], action: 'Cut to scene 1–6' },
  { keys: ['B'], action: 'Cut to Be-right-back' },
  { keys: ['M'], action: 'Toggle metrics overlay' },
  { keys: ['/'], action: 'Focus chat composer' },
];

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {desc && <div className="set-row-desc">{desc}</div>}
      </div>
      <div className="set-row-ctl">{children}</div>
    </div>
  );
}

/** `#/settings?s=usage` opens a section directly (Help links to Usage). */
function sectionFromHash(): string | null {
  try {
    const q = location.hash.indexOf('?');
    const s = q === -1 ? null : new URLSearchParams(location.hash.slice(q + 1)).get('s');
    return s && SET_CATS.some((c) => c.id === s) ? s : null;
  } catch {
    return null;
  }
}

export function SettingsView({ nav, push }: { nav: Nav; push: PushToast }) {
  const [cat, setCat] = useState(() => sectionFromHash() ?? 'account');
  useEffect(() => {
    const on = () => {
      const s = sectionFromHash();
      if (s) setCat(s);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [prefs, setPrefsState] = useState<StudioPrefs>(loadPrefs);
  const [account, setAccount] = useState<StudioAccess | null>(null);
  const live = useAccount();
  // The one account name: Stream Studio's copy for members, else the server's answer
  // (the same one the Studios card shows) — so it's editable before the welcome code too.
  const access = useAccountAccess();
  const accountName = live.name || access?.account.name || live.suggestedName || '';
  const [displayName, setDisplayName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [driveFolder, setDriveFolder] = useState<string | null>(null);
  const gdrive = useDriveStatus(live.status === 'loading' ? null : live.userId);
  const [driveBusy, setDriveBusy] = useState<'connect' | 'disconnect' | null>(null);

  const connectGoogleDrive = () => {
    // Open the consent window inside the tap, or pop-up blockers eat it.
    const popup = openConsentWindow();
    if (!popup) {
      push(driveErrorMessage(new DriveError('popup_blocked')), { icon: 'alert', duration: 5000 });
      return;
    }
    setDriveBusy('connect');
    void connectDrive({ popup })
      .then((s) => push(`Google Drive connected${s.email ? ` · ${s.email}` : ''} — recordings upload to “DreamStream Recordings”`, { icon: 'check', duration: 4200 }))
      .catch((e) => push(driveErrorMessage(e), { icon: 'alert', duration: 5000 }))
      .finally(() => setDriveBusy(null));
  };

  const disconnectGoogleDrive = () => {
    if (!window.confirm('Disconnect Google Drive? Recordings already in your Drive stay there.')) return;
    setDriveBusy('disconnect');
    void disconnectDrive()
      .then(() => push('Google Drive disconnected', { icon: 'check' }))
      .catch((e) => push(driveErrorMessage(e), { icon: 'alert', duration: 4000 }))
      .finally(() => setDriveBusy(null));
  };

  useEffect(() => {
    if (accountName) setDisplayName(accountName);
  }, [accountName]);

  useEffect(() => {
    void getDriveFolder().then((d) => setDriveFolder(d?.name ?? null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Cloud settings first (newer wins), then who we are.
      const adopted = await pullPrefsFromCloud();
      if (!cancelled && adopted) setPrefsState(loadPrefs());
      const acc = await fetchStudioAccess();
      if (!cancelled) setAccount(acc);
      // Landing here signed in (e.g. straight back from the ?next= sign-in
      // hand-off): sync BOTH ways now, not on some later Dashboard visit —
      // this device's events/settings should follow the account immediately.
      if (acc.signedIn) {
        void syncMyEvents();
        void pushPrefsToCloud();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const set = <K extends keyof StudioPrefs>(key: K, value: StudioPrefs[K]) => {
    const next = { ...prefs, [key]: value };
    setPrefsState(next);
    savePrefs(next);
    void pushPrefsToCloud(); // mirrored to the account when signed in
  };

  const [signingOut, setSigningOut] = useState(false);
  const signOutHere = () => {
    if (signingOut) return;
    setSigningOut(true);
    void signOutThisDevice()
      .then(() => {
        setAccount({ signedIn: false, allowed: true, scope: 'full' });
        push('Signed out on this device', { icon: 'check' });
      })
      .finally(() => setSigningOut(false));
  };
  const signOutAll = () => {
    if (signingOut) return;
    setSigningOut(true);
    void confirmAndSignOutEverywhere(push)
      .then((done) => {
        if (done) setAccount({ signedIn: false, allowed: true, scope: 'full' });
      })
      .finally(() => setSigningOut(false));
  };

  const nameDraft = cleanName(displayName);
  const saveName = () => {
    if (!nameDraft || nameDraft === accountName || savingName) return;
    const previous = accountName;
    setSavingName(true);
    void updateDisplayName(nameDraft)
      .then((r) => {
        push(r.ok ? 'Name updated in every studio' : r.error || 'Could not update', { icon: r.ok ? 'check' : 'alert' });
        // An on-stream name that was just a copy of the old account name follows the rename.
        if (r.ok && previous && prefs.hostName.trim() === previous) set('hostName', '');
      })
      .finally(() => setSavingName(false));
  };

  const preset = presetById(prefs.qualityId);
  const bitrate = prefs.videoBpsOverride || preset.videoBps;

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Customize</h1>
          <p className="page-sub">Make the studio yours — scenes, look, encoding, alerts and shortcuts. Saved on this device and synced to your account when you're signed in.</p>
        </div>
        <span className="spacer" />
        <Btn
          variant="subtle"
          icon="refresh"
          onClick={() => {
            setPrefsState({ ...DEFAULT_PREFS });
            savePrefs({ ...DEFAULT_PREFS });
            push('Settings reset to defaults', { icon: 'check' });
          }}
        >
          Reset
        </Btn>
        <Btn variant="ghost" icon="arrowLeft" onClick={() => nav.dashboard()}>Dashboard</Btn>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SET_CATS.map((c) => (
            <button key={c.id} className={cx('set-nav-item', cat === c.id && 'active')} onClick={() => setCat(c.id)}>
              <Icon name={c.icon} size={17} />
              {c.label}
            </button>
          ))}
        </nav>

        <div className="card card-pad settings-content">
          {cat === 'account' && (
            <>
              <div className="set-head"><h2 className="serif">Account &amp; sync</h2></div>
              <p className="set-intro">
                Watching never needs an account. Hosting and the baby monitor do — sign in (or create an account with
                your welcome code) right here, and your events, recaps and settings follow you to every device.
              </p>
              {live.status === 'loading' ? (
                <div className="skeleton" style={{ height: 56 }} aria-label="Loading account" />
              ) : live.status === 'needs_mfa' ? (
                <Row title="Finish signing in" desc={`${live.email ? `${live.email} has` : 'This account has'} two-step sign-in on: type the code from your authenticator app to finish.`}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Btn variant="solid" size="sm" icon="shield" onClick={() => void askForCode(undefined, 'signin')}>Enter code</Btn>
                    <Btn variant="ghost" size="sm" icon="logout" onClick={signOutHere}>Sign out</Btn>
                  </div>
                </Row>
              ) : live.status === 'member' || live.status === 'needs_code' ? (
                <>
                  <Row title="Signed in" desc={live.email || 'Your Stream Studio account'}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <Btn variant="ghost" size="sm" icon="logout" disabled={signingOut} onClick={signOutHere}>
                        Sign out of this device
                      </Btn>
                      <Btn variant="soft" size="sm" icon="shield" disabled={signingOut} onClick={signOutAll}>
                        {signingOut ? 'Signing out…' : 'Sign out everywhere'}
                      </Btn>
                    </div>
                  </Row>
                  {live.status === 'needs_code' && (
                    <Row title="Unlock Stream Studio" desc="Enter the welcome code you were given to host streams and use the baby monitor.">
                      <Btn variant="solid" size="sm" icon="lock" onClick={() => openAuth('code')}>Enter code</Btn>
                    </Row>
                  )}
                  <Row
                    title="Your name"
                    desc={`One name across DreamStream, Stream Studio, the baby monitor and calls — family and nursery members see it, and it's what viewers see by default. ${access?.account.username ? `@${access.account.username}` : 'Your @username'} stays your sign-in handle.`}
                  >
                    <div className="row" style={{ gap: 8 }}>
                      <input
                        className="input"
                        style={{ width: 200 }}
                        value={displayName}
                        maxLength={NAME_MAX}
                        placeholder="Your name"
                        aria-label="Your name"
                        onChange={(e) => setDisplayName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveName();
                        }}
                      />
                      <Btn variant="soft" size="sm" disabled={!nameDraft || nameDraft === accountName || savingName} onClick={saveName}>
                        {savingName ? 'Saving…' : 'Save'}
                      </Btn>
                    </div>
                  </Row>
                  <StudiosCard />
                  <Row title="Cloud sync" desc="Events, recaps and settings sync to your account automatically.">
                    <Btn
                      variant="soft"
                      size="sm"
                      icon="refresh"
                      onClick={() => {
                        void pushPrefsToCloud().then(() => push('Settings synced', { icon: 'check' }));
                      }}
                    >
                      Sync now
                    </Btn>
                  </Row>
                  {account?.scope === 'studio_only' && (
                    <Row title="Access" desc="This account is onboarded for Stream Studio standalone.">
                      <span className="pill pill-info">Stream Studio</span>
                    </Row>
                  )}
                </>
              ) : (
                <Row title="Not signed in" desc="Settings and events stay on this device only until you sign in. New accounts need a welcome code.">
                  <div className="row" style={{ gap: 8 }}>
                    <Btn variant="ghost" size="sm" onClick={() => openAuth('signin')}>Sign in</Btn>
                    <Btn variant="solid" size="sm" onClick={() => openAuth('create')}>Create account</Btn>
                  </div>
                </Row>
              )}
              <Row title="Private links" desc="Your private studio links carry the host key — treat them like passwords. Viewer links are safe to share anywhere. Welcome codes are verified on our server only and repeated wrong guesses are locked out.">
                <span />
              </Row>
            </>
          )}
          {cat === 'security' && (
            <>
              <div className="set-head"><h2 className="serif">Security</h2></div>
              <p className="set-intro">
                Keep your account — and the nurseries it can see — yours: two-step sign-in, the devices signed in to it, and what
                happened recently. Everything here applies to your whole DreamStream account.
              </p>
              {live.status === 'loading' ? (
                <div className="skeleton" style={{ height: 56 }} aria-label="Loading account" />
              ) : live.status === 'needs_mfa' ? (
                <Row title="Finish signing in first" desc="Type the code from your authenticator app, then your security settings appear here.">
                  <Btn variant="solid" size="sm" icon="shield" onClick={() => void askForCode(undefined, 'signin')}>Enter code</Btn>
                </Row>
              ) : live.status === 'member' || live.status === 'needs_code' ? (
                <SecurityPanel push={push} onSignOutEverywhere={signOutAll} />
              ) : live.status === 'offline' ? (
                <div className="banner warn"><Icon name="wifi" size={15} />Can’t reach your account right now — check your connection.</div>
              ) : (
                <Row title="Not signed in" desc="Sign in to turn on two-step sign-in and see the devices signed in to your account.">
                  <Btn variant="solid" size="sm" onClick={() => openAuth('signin')}>Sign in</Btn>
                </Row>
              )}
            </>
          )}
          {cat === 'usage' && (
            <>
              <div className="set-head"><h2 className="serif">Usage</h2></div>
              <p className="set-intro">
                What you used this month. Most of Stream Studio is free — it runs on your devices, your Wi-Fi and
                direct links. What goes through our servers is shown here with its fair-use allowance. You’re never
                charged. It loads when you open this page.
              </p>
              <AccountUsageCard signedIn={live.status === 'loading' ? null : live.status === 'member'} />
            </>
          )}
          {cat === 'recording' && (
            <>
              <div className="set-head"><h2 className="serif">Recording &amp; saving</h2></div>
              <p className="set-intro">
                Recordings are written to this device’s disk while you record — even long sessions don’t slow the stream down —
                and when they stop you choose where they go.
              </p>
              <Row title="Stream time limit" desc="Heads-up at 5 min, 1 min and 10 s (with a one-tap +15 min), then the stream ends.">
                <select className="input" style={{ width: 150 }} value={prefs.streamLimitMin} aria-label="Stream time limit" onChange={(e) => set('streamLimitMin', Number(e.target.value))}>
                  {LIMIT_CHOICES_MIN.map((m) => <option key={m} value={m}>{limitLabel(m)}</option>)}
                </select>
              </Row>
              <Row title="Recording length limit" desc="Heads-up at 5 min, 1 min and 10 s, then the recording stops and asks where to save.">
                <select className="input" style={{ width: 150 }} value={prefs.recLimitMin} aria-label="Recording length limit" onChange={(e) => set('recLimitMin', Number(e.target.value))}>
                  {LIMIT_CHOICES_MIN.map((m) => <option key={m} value={m}>{limitLabel(m)}</option>)}
                </select>
              </Row>
              <Row
                title="Google Drive"
                desc={
                  live.status === 'signed_out'
                    ? 'Sign in, then connect Google Drive — finished recordings upload straight into a “DreamStream Recordings” folder.'
                    : !gdrive
                      ? 'Checking your Google Drive connection…'
                      : !gdrive.available
                        ? 'Uploading straight to Google Drive isn’t switched on for this server yet — use the Drive for desktop folder below.'
                        : gdrive.error
                          ? 'Couldn’t check your Google Drive connection — you may be offline.'
                          : gdrive.connected && gdrive.expired
                            ? 'Google needs you to sign in again (or the Drive permission wasn’t ticked) before recordings can upload.'
                            : gdrive.connected
                              ? `Recordings upload to “DreamStream Recordings” in ${gdrive.email || 'your Drive'}. ${DRIVE_PRIVACY_NOTE}`
                              : `One tap to sign in with Google, then recordings upload straight into “DreamStream Recordings”. ${DRIVE_PRIVACY_NOTE}`
                }
              >
                {live.status === 'signed_out' ? (
                  <Btn variant="soft" size="sm" onClick={() => openAuth('signin', 'Sign in to save recordings to Google Drive')}>Sign in</Btn>
                ) : live.status === 'loading' || !gdrive ? (
                  <div className="skeleton" style={{ width: 120, height: 30 }} aria-label="Checking Google Drive" />
                ) : !gdrive.available ? (
                  <span className="pill pill-neutral">Not available</span>
                ) : gdrive.error ? (
                  <Btn variant="soft" size="sm" icon="refresh" onClick={() => void getDriveStatus({ force: true })}>Retry</Btn>
                ) : gdrive.connected ? (
                  <div className="drive-conn">
                    {gdrive.expired ? (
                      <span className="pill pill-warn">Needs reconnect</span>
                    ) : (
                      <span className="pill pill-ok" title={gdrive.email}>{gdrive.email || 'Connected'}</span>
                    )}
                    {gdrive.expired ? (
                      <Btn variant="solid" size="sm" icon="cloud" disabled={driveBusy != null} onClick={connectGoogleDrive}>
                        {driveBusy === 'connect' ? 'Waiting for Google…' : 'Reconnect'}
                      </Btn>
                    ) : gdrive.folderUrl ? (
                      <a className="btn btn-ghost btn-sm" href={gdrive.folderUrl} target="_blank" rel="noopener noreferrer">
                        <Icon name="link" size={15} />
                        <span>Open folder</span>
                      </a>
                    ) : null}
                    <Btn variant="subtle" size="sm" disabled={driveBusy != null} onClick={disconnectGoogleDrive}>
                      {driveBusy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                    </Btn>
                  </div>
                ) : (
                  <Btn variant="solid" size="sm" icon="cloud" disabled={driveBusy != null} onClick={connectGoogleDrive}>
                    {driveBusy === 'connect' ? 'Waiting for Google…' : 'Connect Google Drive'}
                  </Btn>
                )}
              </Row>
              <Row title="When a recording finishes" desc="Ask lets you pick each time — Google Drive, a folder, Share, or Downloads. Google Drive uploads straight to your Drive when it’s connected (otherwise it uses your Drive for desktop folder).">
                <Segmented
                  label="Save destination"
                  options={[
                    { value: 'ask', label: 'Ask me' },
                    { value: 'drive', label: 'Google Drive' },
                    { value: 'download', label: 'Downloads' },
                  ]}
                  value={prefs.saveTarget === 'picker' ? 'ask' : prefs.saveTarget}
                  onChange={(v) => set('saveTarget', v as StudioPrefs['saveTarget'])}
                />
              </Row>
              <Row
                title="Google Drive for desktop folder"
                desc={canPickFolder()
                  ? 'A no-sign-in fallback that also works offline: with Google Drive for desktop installed, pick your “My Drive” folder once — recordings save straight into it and Drive syncs them.'
                  : 'Without connecting, you can still choose Drive from the share menu when saving. (Picking a Drive folder needs Chrome or Edge on a computer.)'}
              >
                {canPickFolder() ? (
                  <div className="row" style={{ gap: 8 }}>
                    {driveFolder && <span className="pill pill-ok">{driveFolder}</span>}
                    <Btn variant="soft" size="sm" icon="cloud" onClick={() => {
                      void pickDriveFolder().then((d) => {
                        if (d) {
                          setDriveFolder(d.name);
                          push(`Recordings will save to “${d.name}/DreamStream Recordings”`, { icon: 'check' });
                        }
                      }).catch(() => push('Could not use that folder', { icon: 'alert' }));
                    }}>{driveFolder ? 'Change' : 'Choose folder'}</Btn>
                    {driveFolder && <Btn variant="subtle" size="sm" onClick={() => void forgetDriveFolder().then(() => setDriveFolder(null))}>Forget</Btn>}
                  </div>
                ) : <span />}
              </Row>
              <Row title="Auto-record on go-live" desc="Start recording the moment you go live. Uses extra CPU — leave off on weaker laptops and phones.">
                <Toggle on={prefs.autoRecord} onChange={(v) => set('autoRecord', v)} label="Auto-record" />
              </Row>
              <Row title="Record at higher bitrate" desc="Master copy at ~2.5× the stream on computers (phones always record at stream quality to stay smooth).">
                <Toggle on={prefs.recordHighBitrate} onChange={(v) => set('recordHighBitrate', v)} label="Record at higher bitrate" />
              </Row>
              <Row title="Also keep a 7-day cloud copy" desc={`Uploads after each recording so you can grab it later from any device. ${cloudCopySettingDesc(preset, prefs.recordHighBitrate)}`}>
                <Toggle on={prefs.cloudRecordings} onChange={(v) => set('cloudRecordings', v)} label="Cloud recordings" />
              </Row>
            </>
          )}
          {cat === 'scenes' && (
            <>
              <div className="set-head"><h2 className="serif">Scenes</h2></div>
              <p className="set-intro">
                The layouts you cut between while live — the number is the hotkey. Cuts are seamless: the encoder records the program mixer, so switching never interrupts the stream. Grid, Spotlight and Sidebar mix your on-air guests (invite up to 4 from the studio's People panel — their cams, mics and screen shares join the program live).
              </p>
              <div className="scene-edit-list">
                {SCENES.map((s, i) => (
                  <div className="scene-edit" key={s.id}>
                    <div className="se-thumb"><SceneSketch kind={s.id} initial={(prefs.hostName.trim() || accountName || 'H')[0]} /></div>
                    <div className="se-meta">
                      <div className="se-name">{i + 1}. {s.name}</div>
                      <div className="se-desc">{s.desc}</div>
                    </div>
                    <kbd className="hotkey">{s.hotkey}</kbd>
                  </div>
                ))}
              </div>
              <Row
                title="On-stream name (optional)"
                desc="Shown to viewers, on the invite page and in chat. Leave it empty to use your account name (Account & sync) — renames then show up here too."
              >
                <input
                  className="input"
                  style={{ width: 200 }}
                  value={prefs.hostName}
                  maxLength={NAME_MAX}
                  placeholder={accountName || 'Your account name'}
                  aria-label="On-stream name"
                  onChange={(e) => set('hostName', e.target.value)}
                />
              </Row>
            </>
          )}

          {cat === 'camera' && (
            <>
              <div className="set-head"><h2 className="serif">Camera &amp; looks</h2></div>
              <p className="set-intro">A light grade burned into the program feed — viewers and the recording see it. Zoom and lens switching live in the studio's camera bar.</p>
              <Field label="Look">
                <div className="look-row" role="radiogroup" aria-label="Camera look">
                  {LOOK_LABELS.map((l) => (
                    <button key={l.id} role="radio" aria-checked={prefs.look === l.id} className={cx('look-opt', prefs.look === l.id && 'sel')} onClick={() => set('look', l.id)}>
                      <span className="look-swatch"><span className={cx('look-base', l.id !== 'none' && l.id)} /></span>
                      <span>{l.label}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Row title="Program frame rate" desc="The canvas the encoder records. 30 is right for drawing; 60 for fast motion.">
                <Segmented label="Frame rate" options={[{ value: '24', label: '24' }, { value: '30', label: '30' }, { value: '60', label: '60' }]} value={String(prefs.fps)} onChange={(v) => set('fps', Number(v))} />
              </Row>
              <Row title="Mirror my self-view" desc="Auto mirrors the front camera in Solo, like a mirror — viewers and recordings always see the unmirrored program.">
                <Segmented label="Mirror self-view" options={[{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} value={prefs.mirrorPreview} onChange={(v) => set('mirrorPreview', v as StudioPrefs['mirrorPreview'])} />
              </Row>
            </>
          )}

          {cat === 'chat' && (
            <>
              <div className="set-head"><h2 className="serif">Chat &amp; reactions</h2></div>
              <p className="set-intro">How chat looks and behaves for you and your viewers.</p>
              <Row title="Show chat when the studio opens" desc="The right-hand rail while you're live.">
                <Toggle on={prefs.chatOpen} onChange={(v) => set('chatOpen', v)} label="Show chat" />
              </Row>
              <Row title="Floating reactions" desc="Emoji that drift up over the program preview.">
                <Toggle on={prefs.floatingReactions} onChange={(v) => set('floatingReactions', v)} label="Floating reactions" />
              </Row>
              <div className="set-row" style={{ alignItems: 'flex-start' }}>
                <div className="set-row-text">
                  <div className="set-row-title">Your reaction bar</div>
                  <div className="set-row-desc">The six reactions viewers tap with one touch — tap one to swap it. Everything else is a “+” away, sorted into Love, Hype, Cheer, Funny, Faces, Party and Things.</div>
                </div>
                <div className="set-row-ctl">
                  <QuickBarEditor value={normalizeQuick(prefs.quickReactions)} onChange={(v) => set('quickReactions', v)} />
                </div>
              </div>
              <Row title="Slow mode" desc="Limit each viewer to one message every few seconds. Applied when you go live.">
                <div className="row" style={{ gap: 10 }}>
                  <Toggle on={prefs.slowSec > 0} onChange={(v) => set('slowSec', v ? 5 : 0)} label="Slow mode" />
                  {prefs.slowSec > 0 && (
                    <Segmented label="Slow mode seconds" options={[{ value: '5', label: '5s' }, { value: '15', label: '15s' }, { value: '30', label: '30s' }]} value={String(prefs.slowSec)} onChange={(v) => set('slowSec', Number(v))} />
                  )}
                </div>
              </Row>
            </>
          )}

          {cat === 'encoding' && (
            <>
              <div className="set-head"><h2 className="serif">Quality &amp; encoding</h2></div>
              <p className="set-intro">Tune what you send to the edge. Higher quality needs more uplink.</p>
              <Row title="Default resolution" desc={`${preset.label} · needs ≥ ${preset.minUplinkMbps} Mbps uplink`}>
                <Segmented label="Resolution" options={QUALITY_PRESETS.map((p) => ({ value: p.id, label: p.id }))} value={prefs.qualityId} onChange={(v) => { set('qualityId', v); }} />
              </Row>
              <div className="set-row">
                <div className="set-row-text">
                  <div className="set-row-title">Video bitrate</div>
                  <div className="set-row-desc">Override the preset's target. Set to the preset value to follow it.</div>
                </div>
                <div style={{ width: 220 }}>
                  <Slider
                    value={bitrate}
                    min={800_000}
                    max={8_000_000}
                    step={100_000}
                    onChange={(v) => set('videoBpsOverride', v === preset.videoBps ? 0 : v)}
                    valueLabel={`${(bitrate / 1e6).toFixed(1)} Mbps${prefs.videoBpsOverride ? '' : ' (preset)'}`}
                    label="Bitrate"
                  />
                </div>
              </div>
              <Row title="Container" desc="MP4/H.264 plays everywhere (iPhones included). WebM/VP9 packs more quality per bit but Safari viewers may not decode it.">
                <Segmented label="Container" options={[{ value: 'mp4', label: 'MP4 first' }, { value: 'webm', label: 'WebM first' }]} value={prefs.preferMp4 ? 'mp4' : 'webm'} onChange={(v) => set('preferMp4', v === 'mp4')} />
              </Row>
            </>
          )}

          {cat === 'alerts' && (
            <>
              <div className="set-head"><h2 className="serif">Alerts</h2></div>
              <p className="set-intro">Quiet toasts inside the studio while you're live. Here's how one looks:</p>
              <div className="alert-preview">
                <div className="alert-toast">
                  <div className="alert-icon"><Icon name="users" size={16} /></div>
                  <div>
                    <div className="alert-title">novaaa is waiting in the lobby</div>
                    <div className="alert-sub">Admit or deny from the People tab</div>
                  </div>
                </div>
              </div>
              <Row title="Lobby knocks" desc="When someone asks to join an approval-only stream.">
                <Toggle on={prefs.alertJoins} onChange={(v) => set('alertJoins', v)} label="Lobby alerts" />
              </Row>
              <Row title="Viewer milestones" desc="Celebrate 10 / 25 / 50 / 100 concurrent viewers.">
                <Toggle on={prefs.alertMilestones} onChange={(v) => set('alertMilestones', v)} label="Milestone alerts" />
              </Row>
              <Row title="Alert sound" desc="A soft chime with each alert.">
                <div className="row" style={{ gap: 8 }}>
                  <Segmented label="Alert sound" options={[{ value: 'soft', label: 'Soft' }, { value: 'off', label: 'Off' }]} value={prefs.alertSound} onChange={(v) => set('alertSound', v as 'soft' | 'off')} />
                  {prefs.alertSound === 'soft' && <Btn variant="subtle" size="sm" onClick={playChime}>Preview</Btn>}
                </div>
              </Row>
            </>
          )}

          {cat === 'hotkeys' && (
            <>
              <div className="set-head"><h2 className="serif">Hotkeys</h2></div>
              <p className="set-intro">Drive the studio without touching the mouse. Active whenever you're not typing.</p>
              <div className="hotkey-list">
                {HOTKEYS.map((h, i) => (
                  <div className="hotkey-row" key={i}>
                    <span className="hk-action">{h.action}</span>
                    <span className="hk-keys">{h.keys.map((k, j) => <kbd className="hotkey" key={j}>{k}</kbd>)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
