// Guided tours + help center.
//  - Tours spotlight real UI ([data-tour] targets) step by step; steps whose
//    target isn't on screen are skipped. The welcome and baby-monitor tours
//    start automatically the first time; every tour is replayable from Help.
//  - Help is a searchable slide-over covering every feature, with a
//    "Take the tour" shortcut for the current screen.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Icon } from '../ui/icons';
import { Btn, cx } from '../ui/primitives';

export interface TourStep {
  target?: string;
  title: string;
  body: string;
}

export type TourId = 'welcome' | 'create' | 'studio' | 'monitor' | 'nursery' | 'watch' | 'camera';

export const TOURS: Record<TourId, TourStep[]> = {
  welcome: [
    { title: 'Welcome to Stream Studio 👋', body: 'Go live from your browser — viewers join with just a name — and run a private baby monitor from any of your devices. This 30-second tour shows you around.' },
    { target: 'nav-create', title: 'Start a stream', body: 'Create an event to go live now or schedule one with an invite page. Hosting needs a free account (with your welcome code); watching never does.' },
    { target: 'nav-monitor', title: 'Baby monitor', body: 'Turn a spare phone into a baby camera and watch from your other devices. Live only — never recorded — with cry detection and alerts.' },
    { target: 'nav-settings', title: 'Make it yours', body: 'Quality, recording time limits, where recordings save (including Google Drive), alerts and hotkeys.' },
    { target: 'account', title: 'Your account', body: 'Sign in or create an account here. New accounts need the welcome code you were given — it’s checked securely on our server.' },
    { target: 'help', title: 'Help is always here', body: 'Open Help anytime to search answers or replay a tour for the screen you’re on.' },
  ],
  create: [
    { target: 'host-signin', title: 'Sign in to host', body: 'Hosting is for account holders. Your viewers will never need an account.' },
    { target: 'create-title', title: 'Name your stream', body: 'This shows on the watch page and the invite.' },
    { target: 'create-quality', title: 'Pick a quality you can sustain', body: 'Choose by your upload speed. Stream Studio also lowers the bitrate automatically if your connection struggles, so viewers keep a smooth picture.' },
    { target: 'create-submit', title: 'Create & share', body: 'You’ll get a viewer link to share and a private studio link (keep that one secret — it controls the stream).' },
  ],
  studio: [
    { target: 'studio-preview', title: 'Your program', body: 'Exactly what viewers see. Scene cuts, camera flips and screen shares never interrupt the stream.' },
    { target: 'studio-golive', title: 'Go live', body: 'Press G or this button. On phones the screen stays awake while you’re live.' },
    { target: 'studio-record', title: 'Record (optional)', body: 'Records to this device’s disk as you go — even hour-long sessions don’t eat memory. When it stops, you choose where it’s saved. Set a time limit in Customize to get 5-min and 1-min heads-ups.' },
    { target: 'studio-scenes', title: 'Scenes', body: 'Number keys 1–6 cut between layouts. Be-right-back pauses uploads.' },
    { target: 'studio-health', title: 'Health', body: 'Upload speed, auto-quality and any skipped segments. If it says “Degraded”, close other uploads or pick a lower quality.' },
  ],
  monitor: [
    { title: 'Your private baby monitor', body: 'One phone in the nursery is the camera; any device you sign in on can watch. Video and sound go device-to-device, encrypted, and nothing is ever recorded.' },
    { target: 'monitor-create', title: 'Create a nursery', body: 'One per baby or room. Add the baby’s name to get personal alerts like “Aria is crying”.' },
    { target: 'monitor-new', title: 'More nurseries', body: 'Grandparents’ house? Daycare? Add up to five.' },
  ],
  nursery: [
    { target: 'hub-actions', title: 'Camera or viewer', body: 'On the phone in the nursery tap “Be the camera”. On your own phone or laptop tap “Watch”.' },
    { target: 'device-name', title: 'Name this device', body: 'So everyone knows which camera is which (“Crib iPhone”, “Playroom tablet”).' },
    { target: 'people', title: 'People & roles', body: 'Search people by name to add them, then pick a role — Parent, Caregiver or Viewer — and how they appear (Grandma, Nanny…). Removing someone cuts them off immediately.' },
  ],
  watch: [
    { target: 'mv-stage', title: 'Live nursery view', body: 'Tap “hear the nursery” to unmute. Night view brightens dark rooms. If your network blocks direct video, it falls back to a low-bandwidth snapshot mode automatically.' },
    { target: 'mv-status', title: 'Is the baby alright?', body: 'Calm, stirring, noisy or crying — analyzed on the camera phone from sound and motion — plus how long it’s been that way, battery and room light.' },
    { target: 'mv-talk', title: 'Talk & soothe', body: 'Talk through the camera phone’s speaker, or play shush, white noise, rain, ocean or a heartbeat for 15–60 minutes.' },
    { target: 'mv-alerts', title: 'Alerts', body: 'Turn alerts on and you’ll be notified of crying or an offline camera even with the app closed. On iPhone, add Stream Studio to your Home Screen first.' },
    { target: 'mv-timeline', title: 'Tracking', body: 'A 24-hour picture of calm vs. crying, plus quick logs for feeds, diapers and naps — shared with everyone in the nursery.' },
  ],
  camera: [
    { title: 'Camera phone tips', body: 'Prop it 1–2 m from the crib, plugged in, on Wi-Fi. Keep this page open; dim the screen if the light bothers the baby. Everyone watching is listed on screen.' },
  ],
};

const doneKey = (id: TourId) => `ds-live-tour-${id}-done`;
export const tourSeen = (id: TourId): boolean => {
  try {
    return localStorage.getItem(doneKey(id)) === '1';
  } catch {
    return true;
  }
};
const markSeen = (id: TourId) => {
  try {
    localStorage.setItem(doneKey(id), '1');
  } catch { /* storage unavailable */ }
};

/* ------------------------------------------------------------ controller */

type Listener = (cmd: { tour?: TourId; help?: boolean }) => void;
let listener: Listener | null = null;
export const startTour = (tour: TourId) => listener?.({ tour });
export const openHelp = () => listener?.({ help: true });

/** Auto-start a tour once per device, after the screen has painted. */
export function useFirstVisitTour(id: TourId, ready = true): void {
  useEffect(() => {
    if (!ready || tourSeen(id)) return;
    const t = window.setTimeout(() => startTour(id), 900);
    return () => window.clearTimeout(t);
  }, [id, ready]);
}

export function GuideHost({ screenTour }: { screenTour: TourId | null }) {
  const [tour, setTour] = useState<TourId | null>(null);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    listener = (cmd) => {
      if (cmd.help) setHelp(true);
      if (cmd.tour) {
        setHelp(false);
        setTour(cmd.tour);
      }
    };
    return () => {
      listener = null;
    };
  }, []);

  return (
    <>
      {tour && <TourOverlay id={tour} onDone={() => { markSeen(tour); setTour(null); }} />}
      {help && <HelpPanel screenTour={screenTour} onClose={() => setHelp(false)} />}
    </>
  );
}

/* --------------------------------------------------------------- tours */

function visibleTarget(sel?: string): HTMLElement | null {
  if (!sel) return null;
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${sel}"]`));
  return all.find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }) ?? null;
}

function TourOverlay({ id, onDone }: { id: TourId; onDone: () => void }) {
  // Keep only steps that are centered or whose target is on screen now.
  const steps = useMemo(() => TOURS[id].filter((s) => !s.target || visibleTarget(s.target)), [id]);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[i];

  const measure = useCallback(() => {
    const el = visibleTarget(step?.target);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step]);

  useLayoutEffect(() => {
    const el = visibleTarget(step?.target);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = window.setTimeout(measure, 320);
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone();
      if (e.key === 'ArrowRight') setI((n) => Math.min(steps.length - 1, n + 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone, steps.length]);

  useEffect(() => {
    if (!step) onDone();
  }, [step, onDone]);
  if (!step) return null;

  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(340, vw - 24);
  let cardStyle: React.CSSProperties;
  if (rect) {
    const below = rect.bottom + pad + 12;
    const fitsBelow = below + 190 < vh;
    const top = fitsBelow ? below : Math.max(12, rect.top - pad - 12 - 190);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - cardW / 2), vw - cardW - 12);
    cardStyle = { top, left, width: cardW };
  } else {
    cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: cardW };
  }
  const last = i === steps.length - 1;

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label={`Tour: ${step.title}`}>
      {rect ? (
        <div className="tour-hole" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
      ) : (
        <div className="tour-scrim" />
      )}
      <div className="tour-card fade-in" style={cardStyle}>
        <div className="tour-step mono">{i + 1} / {steps.length}</div>
        <h3 className="serif">{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-foot">
          <button className="linkish" onClick={onDone}>Skip tour</button>
          <span className="spacer" />
          {i > 0 && <Btn variant="ghost" size="sm" onClick={() => setI(i - 1)}>Back</Btn>}
          <Btn variant="solid" size="sm" onClick={() => (last ? onDone() : setI(i + 1))}>{last ? 'Done' : 'Next'}</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- help */

interface HelpItem {
  q: string;
  a: string;
  tags?: string;
}

const HELP: { section: string; icon: string; items: HelpItem[] }[] = [
  {
    section: 'Getting started',
    icon: 'sparkles',
    items: [
      { q: 'Do viewers need an account?', a: 'No. Viewers open your link and type a name — that’s it. Only hosts and baby-monitor families sign in.' },
      { q: 'How do I create an account?', a: 'Tap your name/avatar (bottom of the menu) → Create account. Enter your name, email, password, date of birth and the welcome code you were given. Then confirm your email if asked.', tags: 'sign up register' },
      { q: 'What is the welcome code?', a: 'An invite code required for new accounts. It’s case-sensitive and checked only on our server — it never ships in the app, and repeated wrong guesses are locked out for 15 minutes.', tags: 'invite code security' },
      { q: 'I already had a DreamStream account', a: 'Just sign in — accounts created before Stream Studio accounts launched are unlocked automatically.' },
      { q: 'Finding people', a: 'In a nursery’s People & roles, search by the person’s name. Only Stream Studio members appear, and only by name — emails are never shown.', tags: 'search users directory' },
    ],
  },
  {
    section: 'Going live',
    icon: 'broadcast',
    items: [
      { q: 'Start a stream', a: 'New event → name it → Create. Open the studio, allow camera/mic, press Go live (or G). Share the viewer link.' },
      { q: 'Keep the private studio link secret', a: 'It contains the host key: anyone with it can control your stream. Share the viewer link instead.' },
      { q: 'Guests on air', a: 'People panel → copy the guest link. Up to 4 guests join with cam, mic and screen share; Grid / Spotlight / Sidebar mix them in.' },
      { q: 'Hotkeys', a: 'G go live/end · Space mic · V camera · R record · B be-right-back · 1–6 scenes · M metrics · / chat.' },
    ],
  },
  {
    section: 'Smooth streaming',
    icon: 'signal',
    items: [
      { q: 'Why did my stream lag or freeze?', a: 'Usually the upload couldn’t keep up, the tab went to the background, or the device was overloaded. Stream Studio now lowers the bitrate automatically, retries failed uploads, skips ahead instead of falling behind, and viewers’ players self-heal from gaps.', tags: 'lag buffering pause stutter' },
      { q: 'Phone tips', a: 'Keep Stream Studio in the foreground — phones pause the camera in the background. The screen stays awake while live. Use Wi-Fi when you can.' },
      { q: 'Recording makes streaming slower?', a: 'Recording runs a second encoder. On weaker devices that can strain things — the studio warns you and offers a one-tap stop. Auto-record is off by default.' },
      { q: 'How much delay do viewers have?', a: 'About 8–15 seconds by design — the buffer is what keeps playback smooth. Guests on air talk to you in real time.' },
      { q: 'Check health', a: 'Studio → Health tab (or press M) shows upload speed, auto-quality, queue and any skipped segments.' },
    ],
  },
  {
    section: 'Recording & saving',
    icon: 'record',
    items: [
      { q: 'Where do recordings go?', a: 'When a recording stops you choose: a folder on your computer, your Google Drive, Share (Photos/Files on phones), or Downloads. Tick “Remember my choice” to skip the question next time.', tags: 'download save' },
      { q: 'Save to Google Drive without signing in to Google here', a: 'On a computer with Google Drive for desktop, pick your “My Drive” folder once — every recording then saves straight into it and Drive syncs it. On phones, choose Drive in the share menu. We never ask for your Google password or permissions.', tags: 'drive oauth' },
      { q: 'Time limits & alerts', a: 'Customize → Recording: set a stream or recording length limit. You’ll get alerts at 5 minutes, 1 minute and 10 seconds (with a one-tap +15 min for streams), then it stops and asks where to save.', tags: 'duration limit timer' },
      { q: 'I closed the tab before saving', a: 'Recordings are written to this device’s disk as they record. Reopen the studio (or the dashboard) and choose “Save it now”.', tags: 'recover lost' },
      { q: '7-day cloud copy', a: 'In the save sheet, Upload keeps a copy on our server for 7 days so you can download it from the recap on any device.' },
    ],
  },
  {
    section: 'Baby monitor',
    icon: 'baby',
    items: [
      { q: 'Set it up', a: 'Baby monitor → create a nursery. On the phone in the nursery: sign in, open the nursery, tap “Be the camera”. On your phone/laptop: tap “Watch”.' },
      { q: 'Is anything recorded?', a: 'Never. Video and sound go directly between the camera phone and your devices, encrypted (WebRTC). Our server only passes small connection messages and status numbers. There is no record button.', tags: 'privacy security' },
      { q: 'How does cry detection work?', a: 'The camera phone listens for the pitch, harmonics and rhythm of a cry (different from fans, white noise or adult voices). It runs on the phone itself. Parents can set sensitivity while watching.' },
      { q: 'Alerts when my phone is locked', a: 'Turn on “Alerts on this device” while watching. Android and computers work right away. iPhone: Share → Add to Home Screen, open it from the Home Screen, then turn alerts on.', tags: 'notifications push iphone' },
      { q: 'Camera offline alert', a: 'If the camera phone loses Wi-Fi, runs out of battery or the page is closed, everyone with alerts gets “camera offline” within about a minute.' },
      { q: 'Roles', a: 'Parent: everything incl. managing people. Caregiver: watch, talk, soothe, run a camera, log. Viewer: watch and get alerts. Each person can also have a name like Grandma or Nanny.' },
      { q: 'Talk & soothing sounds', a: 'While watching, Talk plays your voice on the camera phone. Soothe plays shush, white noise, rain, ocean or a heartbeat for 15–60 minutes. Cry detection ignores your own talk-back.' },
      { q: 'No video on my network', a: 'Some networks block direct device-to-device video. The monitor switches to a low-bandwidth snapshot mode (1 picture per second, no audio) and keeps retrying full video.' },
      { q: 'Is it a medical device?', a: 'No. It watches and listens; it does not monitor breathing, temperature or safe sleep. Always follow safe-sleep guidance.' },
    ],
  },
  {
    section: 'Troubleshooting',
    icon: 'alert',
    items: [
      { q: 'Black video or “can’t decode”', a: 'Ask the host to stream from Chrome/Edge/Safari (MP4). iPhones can’t play WebM streams.' },
      { q: 'No sound', a: 'Browsers start muted — tap the speaker / “Tap to hear”.' },
      { q: 'Camera or mic blocked', a: 'Allow camera & microphone for this site in your browser’s site settings, then reload.' },
      { q: 'Contact support', a: 'Email contact@dreamstream.com with what you were doing and the device/browser.' },
    ],
  },
];

function HelpPanel({ screenTour, onClose }: { screenTour: TourId | null; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const results = HELP.map((s) => ({
    ...s,
    items: s.items.filter((it) => !needle || `${it.q} ${it.a} ${it.tags ?? ''} ${s.section}`.toLowerCase().includes(needle)),
  })).filter((s) => s.items.length > 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="help-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="help-panel" role="dialog" aria-modal="true" aria-label="Help">
        <div className="help-head">
          <Icon name="help" size={18} />
          <h2 className="serif">Help</h2>
          <span className="spacer" />
          <button className="iconbtn" onClick={onClose} aria-label="Close help"><Icon name="x" size={17} /></button>
        </div>
        <div className="search-box" style={{ margin: '0 16px 12px' }}>
          <Icon name="search" size={15} className="faint" />
          <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help (e.g. Google Drive, lag, alerts)" aria-label="Search help" />
        </div>
        <div className="help-tours">
          {screenTour && <Btn variant="solid" size="sm" icon="compass" onClick={() => startTour(screenTour)}>Tour this screen</Btn>}
          <Btn variant="soft" size="sm" icon="sparkles" onClick={() => startTour('welcome')}>Welcome tour</Btn>
          <Btn variant="soft" size="sm" icon="baby" onClick={() => { onClose(); location.hash = '#/monitor'; window.setTimeout(() => startTour('monitor'), 700); }}>Baby monitor tour</Btn>
        </div>
        <div className="help-body">
          {results.length === 0 && <div className="faint" style={{ padding: 16 }}>No answers for “{q}”. Try other words, or email contact@dreamstream.com.</div>}
          {results.map((s) => (
            <section key={s.section} className="help-sect">
              <h3><Icon name={s.icon} size={15} />{s.section}</h3>
              {s.items.map((it) => {
                const k = `${s.section}:${it.q}`;
                const isOpen = open === k || !!needle;
                return (
                  <div key={k} className={cx('help-item', isOpen && 'open')}>
                    <button className="help-q" onClick={() => setOpen(open === k ? null : k)} aria-expanded={isOpen}>
                      <span>{it.q}</span>
                      <Icon name="chevronDown" size={15} />
                    </button>
                    {isOpen && <p className="help-a">{it.a}</p>}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}

/** The "?" button used in top bars of full-screen surfaces. */
export function HelpButton({ className }: { className?: string }) {
  return (
    <button className={cx('iconbtn help-btn', className)} onClick={openHelp} aria-label="Help & tours" title="Help & tours" data-tour="help">
      <Icon name="help" size={18} />
    </button>
  );
}
