// Customize — scenes, camera looks, chat & reactions, quality & encoding,
// alerts and hotkeys. Every control writes StudioPrefs; the Studio reads them
// when it opens (and pushes slow-mode to the room at go-live).
import React, { useEffect, useState } from 'react';
import { QUALITY_PRESETS, presetById } from '../config';
import type { Nav } from '../nav';
import { DEFAULT_PREFS, LOOK_LABELS, loadPrefs, playChime, savePrefs, type StudioPrefs } from '../prefs';
import { EMOJI_SET } from '../protocol';
import { SCENES } from '../studio/compositor';
import { SceneSketch } from '../components/scenes';
import { Icon } from '../ui/icons';
import { Btn, Field, Segmented, Slider, Toggle, cx, type PushToast } from '../ui/primitives';
import { fetchStudioAccess, pullPrefsFromCloud, pushPrefsToCloud, signOut, type StudioAccess } from '../sync';

const SET_CATS = [
  { id: 'account', label: 'Account & sync', icon: 'user' },
  { id: 'scenes', label: 'Scenes', icon: 'layers' },
  { id: 'camera', label: 'Camera & looks', icon: 'video' },
  { id: 'chat', label: 'Chat & reactions', icon: 'chat' },
  { id: 'encoding', label: 'Quality & encoding', icon: 'sliders' },
  { id: 'alerts', label: 'Alerts', icon: 'bell' },
  { id: 'hotkeys', label: 'Hotkeys', icon: 'keyboard' },
];

const HOTKEYS: { keys: string[]; action: string }[] = [
  { keys: ['G'], action: 'Go live / end stream' },
  { keys: ['Space'], action: 'Mute / unmute mic' },
  { keys: ['V'], action: 'Camera on / off' },
  { keys: ['R'], action: 'Start / stop recording' },
  { keys: ['1', '–', '3'], action: 'Cut to scene 1–3' },
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

export function SettingsView({ nav, push }: { nav: Nav; push: PushToast }) {
  const [cat, setCat] = useState('account');
  const [prefs, setPrefsState] = useState<StudioPrefs>(loadPrefs);
  const [account, setAccount] = useState<StudioAccess | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Cloud settings first (newer wins), then who we are.
      const adopted = await pullPrefsFromCloud();
      if (!cancelled && adopted) setPrefsState(loadPrefs());
      const acc = await fetchStudioAccess();
      if (!cancelled) setAccount(acc);
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
                Stream Studio works without an account — events and settings live in this browser. Sign in to your
                DreamStream Studio account and everything syncs: past sessions, recaps and these settings follow you
                across devices.
              </p>
              {account == null ? (
                <div className="skeleton" style={{ height: 56 }} aria-label="Loading account" />
              ) : account.signedIn ? (
                <>
                  <Row title="Signed in" desc={account.email || 'Your DreamStream Studio account'}>
                    <Btn
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void signOut().then(() => {
                          setAccount({ signedIn: false, allowed: true, scope: 'full' });
                          push('Signed out on this device', { icon: 'check' });
                        });
                      }}
                    >
                      Sign out
                    </Btn>
                  </Row>
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
                  {account.scope === 'studio_only' && (
                    <Row title="Access" desc="This account is onboarded for Stream Studio standalone.">
                      <span className="pill pill-info">Stream Studio</span>
                    </Row>
                  )}
                </>
              ) : (
                <Row title="Not signed in" desc="Settings and events stay on this device. Sign in via the main app to enable sync.">
                  <Btn variant="solid" size="sm" icon="arrowRight" onClick={() => window.open('/', '_blank')}>
                    Open DreamStream Studio
                  </Btn>
                </Row>
              )}
              <Row title="Security" desc="Your private studio links carry the host key — treat them like passwords. Viewer links are safe to share anywhere.">
                <span />
              </Row>
            </>
          )}
          {cat === 'scenes' && (
            <>
              <div className="set-head"><h2 className="serif">Scenes</h2></div>
              <p className="set-intro">
                The layouts you cut between while live — the number is the hotkey. Cuts are seamless: the encoder records the program mixer, so switching never interrupts the stream. Guest scenes (interview, grid) arrive with multi-guest support.
              </p>
              <div className="scene-edit-list">
                {SCENES.map((s, i) => (
                  <div className="scene-edit" key={s.id}>
                    <div className="se-thumb"><SceneSketch kind={s.id} initial={(prefs.hostName || 'H')[0]} /></div>
                    <div className="se-meta">
                      <div className="se-name">{i + 1}. {s.name}</div>
                      <div className="se-desc">{s.desc}</div>
                    </div>
                    <kbd className="hotkey">{s.hotkey}</kbd>
                  </div>
                ))}
              </div>
              <Row title="Your name" desc="Shown to viewers, on the invite page and in chat.">
                <input
                  className="input"
                  style={{ width: 200 }}
                  value={prefs.hostName}
                  maxLength={40}
                  placeholder="e.g. Akhielesh"
                  aria-label="Host name"
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
              <Row title="Reaction set" desc="What viewers can send.">
                <div className="row" style={{ gap: 4 }}>
                  {EMOJI_SET.map((e) => <span key={e} className="emoji-chip">{e}</span>)}
                </div>
              </Row>
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
              <Row title="Record at higher bitrate" desc="Master copy at ~2.5× the stream — always sharper than viewers saw.">
                <Toggle on={prefs.recordHighBitrate} onChange={(v) => set('recordHighBitrate', v)} label="Record at higher bitrate" />
              </Row>
              <Row title="Keep a cloud copy for 7 days" desc="Recordings always download to your device; this also uploads them to the server so you can grab them later from any device. Auto-deleted after 7 days.">
                <Toggle on={prefs.cloudRecordings} onChange={(v) => set('cloudRecordings', v)} label="Cloud recordings" />
              </Row>
              <Row title="Auto-record on go-live" desc="Start the local master recording the moment you go live.">
                <Toggle on={prefs.autoRecord} onChange={(v) => set('autoRecord', v)} label="Auto-record" />
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
