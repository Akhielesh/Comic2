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
    { target: 'nav-monitor', title: 'Baby monitor', body: 'Turn a spare phone into a baby camera and watch from your other devices. Live only — never recorded — with two-way talk, video calls and alerts for crying, coughing and smoke alarms.' },
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
    { target: 'hub-checklist', title: 'Your setup checklist', body: 'Five steps from zero to a fully covered nursery. Each has a button that takes you straight there, and they tick off as you go.' },
    { target: 'hub-actions', title: 'Camera or viewer', body: 'On the phone that stays in the nursery tap “Be the camera”. On your own phone or laptop tap “Watch”.' },
    { target: 'device-name', title: 'Name this device', body: 'So everyone knows which camera is which (“Crib iPhone”, “Playroom tablet”).' },
    { target: 'people', title: 'People & roles', body: 'Search people by name to add them, then pick a role — Parent, Caregiver or Viewer — and how they appear (Grandma, Nanny…). Removing someone cuts them off immediately.' },
  ],
  watch: [
    { target: 'mv-views', title: 'Pick a layout', body: 'Monitor shows the picture and what needs you. Tracker logs feeds, diapers, sleep and growth for the whole family. All adds sleep, sound level, logs and settings. Bedside is a dark nightstand view with a big clock that dims itself and lights up for alerts. Turn your phone sideways for a full-screen picture.' },
    { target: 'mv-stage', title: 'Live nursery view', body: 'Tap Listen (or “Tap to hear”) to unmute. The frame glows in the alert’s colour when something needs you. Night view (moon) brightens dark rooms; Pop out keeps the picture floating while you use other apps.' },
    { target: 'mv-talk', title: 'Talk — like FaceTime', body: 'Tap to open your mic and tap again to stop, or press and hold to talk only while holding. Your voice plays on the nursery phone; it won’t trigger a cry alert.' },
    { target: 'mv-call', title: 'Video call the nursery', body: 'Shows your face full-screen on the nursery phone (best when it uses its front camera). Your mic turns on with it.' },
    { target: 'mv-status', title: 'What’s happening now', body: 'Mood, what the smart ears are hearing right now, and the last 2 minutes of sound — all analysed on the camera phone.' },
    { target: 'mv-activity', title: 'Activity log', body: 'Every cry (and how long it lasted), cough, wake-up, feed and note. Filter by Baby sounds, Alerts, Care or Camera.' },
    { target: 'mv-alerts', title: 'Alerts your way', body: 'Background notifications per category, plus alert sounds, spoken alerts and vibration while this screen is open. Tap Preview to hear each sound.' },
    { target: 'mv-safety', title: 'Safety at a glance', body: 'Anything that needs someone shows here with “I’m on it”, plus every guard the camera runs and how to fix one that isn’t working. Take duty and routine alerts come to you first.' },
    { target: 'mv-week', title: 'This week', body: 'Six numbers from what the monitor measured — sleep, wakings, the longest stretch, crying, how fast alerts were answered and the room’s sound while asleep — against last week.' },
    { target: 'mv-sound', title: 'Sound level', body: 'The room in decibels, live and over the last hours — and a nudge if a sound machine runs louder than the 50 dB sleep guideline.' },
    { target: 'mv-timeline', title: 'The last 24 hours', body: 'Calm, awake, fussing and crying at a glance, with today’s totals and your quick logs.' },
    { target: 'mv-people', title: 'People & sharing', body: 'Who’s watching right now. Parents can share a guest link with a passcode for family without an account — and remove anyone in one tap.' },
  ],
  camera: [
    { title: 'Make this the nursery camera', body: 'Frame the crib, let the checks turn green, then start. It works like a private FaceTime call: live to your family, never recorded.' },
    { target: 'cam-lens', title: 'Pick the lens', body: 'Back camera is the sharpest. Ultra wide fits the whole crib. Front lets your baby see you during a video call.' },
    { target: 'cam-checks', title: 'Automatic checks', body: 'Microphone, smart sound detection, light, power and network. Clap once to test the mic. Only checks that need attention are shown.' },
    { target: 'cam-start', title: 'Start monitoring', body: 'Prop it 1–2 m from the crib, plugged in. The screen dims itself after 90 s — keep this page open; everyone is alerted if it stops.' },
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

type Listener = (cmd: { tour?: TourId; help?: boolean; guide?: string }) => void;
let listener: Listener | null = null;
export const startTour = (tour: TourId) => listener?.({ tour });
export const openHelp = () => listener?.({ help: true });
/** Open Help straight on a how-to guide (e.g. 'setup'). */
export const openGuide = (guide: string) => listener?.({ help: true, guide });

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
  const [guide, setGuide] = useState<string | null>(null);

  useEffect(() => {
    listener = (cmd) => {
      if (cmd.help) {
        setGuide(cmd.guide ?? null);
        setHelp(true);
      }
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
      {help && <HelpPanel screenTour={screenTour} initialGuide={guide} onClose={() => setHelp(false)} />}
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

/* -------------------------------------------------------------- guides */

interface GuideStep {
  title: string;
  body: string;
}

interface HowTo {
  id: string;
  title: string;
  icon: string;
  mins: number;
  intro: string;
  steps: GuideStep[];
  /** Deep links shown under the steps. */
  actions?: { label: string; hash: string }[];
  /** Screens where this guide is most useful (listed first there). */
  screens: TourId[];
}

export const GUIDES: HowTo[] = [
  {
    id: 'setup', title: 'Set up the baby monitor', icon: 'baby', mins: 3, screens: ['monitor', 'nursery'],
    intro: 'Two devices: a spare phone that stays in the nursery, and the phone you keep with you.',
    steps: [
      { title: 'Create a nursery', body: 'Baby monitor → New nursery. Add your baby’s name so alerts say “Aria is crying”.' },
      { title: 'Turn the spare phone into the camera', body: 'Sign in on it, open the nursery and tap Be the camera → Allow camera & microphone.' },
      { title: 'Frame the crib and let the checks go green', body: 'Pick the back camera, point it down at the crib from 1–2 m, clap once for the mic check. Keep it plugged in.' },
      { title: 'Start monitoring', body: 'Leave the page open — the screen dims itself. If the phone stops, everyone gets an alert.' },
      { title: 'Watch from your phone', body: 'Open the nursery → Watch → Tap to hear. Talk and video call right from there.' },
      { title: 'Turn on alerts', body: 'On the watch screen: Alerts on this device. iPhone: add Stream Studio to your Home Screen first (see “Get alerts on iPhone”).' },
    ],
    actions: [{ label: 'Open baby monitor', hash: '#/monitor' }],
  },
  {
    id: 'camera', title: 'Use a phone as the nursery camera', icon: 'video', mins: 2, screens: ['camera', 'nursery'],
    intro: 'Any phone, tablet or laptop with a camera works — an old phone is perfect.',
    steps: [
      { title: 'Use the real browser', body: 'Safari on iPhone, Chrome on Android. Links opened inside Instagram, Facebook or Gmail can’t use the camera — tap ⋯ → Open in browser.' },
      { title: 'Allow camera & microphone', body: 'If you tapped “Don’t allow”: iPhone → aA in the address bar → Website Settings → Allow both. Chrome → icon left of the address → Permissions.' },
      { title: 'Pick the lens', body: 'Back camera: sharpest. Ultra wide: the whole crib. Front: your baby sees you during video calls. Use the zoom slider where your phone supports it.' },
      { title: 'Placement', body: '1–2 m (3–6 ft) away, higher than the mattress, pointing down. Phone and cable at least 1 m out of the baby’s reach — never in the crib.' },
      { title: 'Leave it running', body: 'Don’t switch apps — phones pause cameras in the background. The screen goes dark after 90 s (tap to wake). Turn off Low Power Mode and Do Not Disturb.' },
      { title: 'Privacy & stopping', body: 'Privacy pauses the video but keeps listening and alerting. Stop ends monitoring — nothing was ever recorded.' },
    ],
  },
  {
    id: 'talk', title: 'Talk, listen & video call (like FaceTime)', icon: 'phone', mins: 1, screens: ['watch'],
    intro: 'Everything goes device-to-device, encrypted. Nothing is recorded.',
    steps: [
      { title: 'Listen', body: 'Tap Listen (or “Tap to hear the nursery”). Browsers start muted until you tap.' },
      { title: 'Talk', body: 'Tap Talk to open your mic; tap again to stop. Or press and hold to talk only while holding, like a walkie-talkie.' },
      { title: 'Video call', body: 'Tap Video: your face fills the nursery phone’s screen, with the nursery in a small window. Tap End video to stop.' },
      { title: 'Soothe', body: 'Play shush, white noise, rain, ocean or a heartbeat on the nursery phone for 15–60 minutes.' },
      { title: 'No false alarms from you', body: 'Sound detection ignores the speaker while you talk, so your voice never sets off a cry alert.' },
    ],
  },
  {
    id: 'alerts', title: 'Understand sound alerts', icon: 'bell', mins: 2, screens: ['watch'],
    intro: 'The camera phone listens with an on-device AI sound model plus a cry analyser. Audio never leaves the phone.',
    steps: [
      { title: 'What it recognizes', body: 'Crying, fussing, coughing, smoke/CO alarms, bangs and crashes, babbling and laughing, voices, music/TV and dogs barking.' },
      { title: 'Colours', body: 'Red: act now (crying, alarm, camera offline). Amber: check in (fussing, coughing, a bang). Blue/green: good news (babbling, laughing).' },
      { title: 'Sounds', body: 'Each alert has its own sound — preview them under Alerts on this device. Smoke/CO alarms sound like a siren, take over the screen and are always on.' },
      { title: '“I’m on it”', body: 'Tells everyone you’re handling it and silences the repeating alert on every device.' },
      { title: 'Snooze & sensitivity', body: 'Snooze 5m quiets one kind of alert on this device. Parents can set sensitivity (Low / Medium / High) for the whole nursery.' },
      { title: 'Honest limits', body: 'It’s an attentive ear, not a medical device: it doesn’t monitor breathing, temperature or safe sleep.' },
    ],
  },
  {
    id: 'iphone-alerts', title: 'Get alerts on iPhone', icon: 'bell', mins: 1, screens: ['watch'],
    intro: 'Apple only allows web notifications for apps added to the Home Screen.',
    steps: [
      { title: 'Add to Home Screen', body: 'In Safari, tap Share (square with an arrow) → Add to Home Screen → Add.' },
      { title: 'Open it from the Home Screen', body: 'Tap the new Stream Studio icon and sign in there.' },
      { title: 'Turn alerts on', body: 'Open the nursery → Watch → Alerts on this device → Allow.' },
      { title: 'Test it', body: 'Tap “Send a test notification”. If nothing arrives, check Settings → Focus and Settings → Notifications → Stream Studio.' },
    ],
  },
  {
    id: 'android-alerts', title: 'Get alerts on Android & computers', icon: 'bell', mins: 1, screens: ['watch'],
    intro: 'Chrome, Edge and Firefox deliver alerts even when the page is closed.',
    steps: [
      { title: 'Turn alerts on', body: 'Watch → Alerts on this device → Allow notifications.' },
      { title: 'Choose what wakes you', body: 'Crying, alarms and an offline camera are on by default; add coughing, bangs or fussing if you like.' },
      { title: 'Test it', body: 'Tap “Send a test notification”. On Android, set Chrome’s battery usage to “Unrestricted” for the fastest alerts.' },
    ],
  },
  {
    id: 'family', title: 'Invite family & set roles', icon: 'users', mins: 1, screens: ['nursery'],
    intro: 'Everyone signs in with their own account — new accounts need your invitation code.',
    steps: [
      { title: 'Add someone', body: 'Nursery → People & roles → search their name → choose a role and how they appear (Grandma, Nanny…) → Add.' },
      { title: 'Roles', body: 'Parent: everything, including people and settings. Caregiver: watch, talk, video call, soothe, run a camera, log. Viewer: watch, listen and get alerts.' },
      { title: 'Removing someone', body: 'Remove them in People & roles — any open session is cut off immediately.' },
      { title: 'No account? Share a link', body: 'Watch → People → Create a share link. Choose a passcode (8+ characters — “Suggest one” makes a memorable one), what guests can do, and how long the link works. Send the link, then tell them the passcode by phone or in a different app.' },
    ],
  },
  {
    id: 'tracker', title: 'Track feeds, diapers, sleep & growth', icon: 'bottle', mins: 2, screens: ['watch'],
    intro: 'Watch → Tracker. Everything you log shows on every family member’s phone at once — even logged offline.',
    steps: [
      { title: 'Log in one tap', body: 'Tap Bottle, Diaper, Breastfeed, Sleep… Timers (breastfeeding, sleep, pumping, tummy time) keep running on every phone, and anyone can stop them. Forgot? Use “Log a past one”.' },
      { title: 'Breastfeeding', body: 'Start on the side “Up next” suggests, tap the other side to switch — each side’s minutes are kept.' },
      { title: 'What’s next', body: 'Add the birthday (Edit) for age-based guidance: the nap sweet spot, the next feed and which side, and when a medicine is due again by the interval you entered.' },
      { title: 'Trends & growth', body: 'Trends compare this week with last; Growth places weight, length and head on the WHO charts. Download a CSV for the pediatrician.' },
      { title: 'Good to know', body: 'Checks for wet diapers, stool colour and fevers follow AAP guidance and say when to call your pediatrician — they’re not a diagnosis, and the tracker never calculates doses.' },
    ],
  },
  {
    id: 'share', title: 'Share with a guest link & passcode', icon: 'link', mins: 1, screens: ['watch', 'nursery'],
    intro: 'For grandparents, a sitter or a friend without an account. They need both the link and the passcode you choose.',
    steps: [
      { title: 'Create it', body: 'Watch → People → Create a share link. Pick a passcode, “Watch & listen” or “Also talk, soothe & answer alerts”, and 1 day, 7 days, 30 days or until you turn it off.' },
      { title: 'Send it safely', body: 'Send the link (Copy or Send), and say the passcode out loud or send it in a different app. The passcode is shown once — we only keep a scrambled version of it.' },
      { title: 'Stay in control', body: 'You’re told when a guest joins. People shows every guest with when they last watched — Remove ends their pass at once. New link & passcode, or Turn off, signs every guest out.' },
      { title: 'If someone guesses', body: '5 wrong passcodes lock the link for 15 minutes and 20 turn it off — the parents get a notification either way.' },
    ],
  },
  {
    id: 'fix-camera', title: 'Fix: the camera won’t start', icon: 'alert', mins: 1, screens: ['camera'],
    intro: 'Almost always permissions, an in-app browser, or another app holding the camera.',
    steps: [
      { title: 'Open in Safari or Chrome', body: 'Not inside Instagram, Facebook, Gmail or other apps.' },
      { title: 'Allow camera & microphone', body: 'See “Use a phone as the nursery camera” → step 2.' },
      { title: 'Close other camera apps', body: 'FaceTime, Zoom, WhatsApp calls or the Camera app block other apps from the camera.' },
      { title: 'Still stuck?', body: 'Fully close and reopen the browser. On iPhone also check Settings → Screen Time → Content & Privacy → Camera.' },
    ],
  },
  {
    id: 'fix-sound', title: 'Fix: no sound, or they can’t hear me', icon: 'volume', mins: 1, screens: ['watch', 'camera'],
    intro: 'Both phones need their volume up — browsers never change it for you.',
    steps: [
      { title: 'Can’t hear the nursery', body: 'Tap Listen, then turn your volume up. On a computer, check the tab isn’t muted.' },
      { title: 'They can’t hear you', body: 'Talk must say “Talking”. Turn the nursery phone’s volume up (it plays through its speaker).' },
      { title: 'Echo', body: 'Lower your volume or use headphones while you talk.' },
    ],
  },
  {
    id: 'fix-alerts', title: 'Fix: alerts aren’t arriving', icon: 'bell', mins: 1, screens: ['watch'],
    intro: 'Notifications need permission, the right app (iPhone), and a running camera.',
    steps: [
      { title: 'Turned on for this device?', body: 'Watch → Alerts on this device must be on. iPhone: only from the Home Screen app.' },
      { title: 'Send a test', body: 'If the test doesn’t arrive, check Focus / Do Not Disturb and your browser’s notification settings.' },
      { title: 'Is the camera running?', body: 'Alerts come from the nursery phone. If it stops, everyone gets “camera offline” within a minute.' },
    ],
  },
];

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
      { q: 'What happens if our internet goes down?', a: 'Phones on the same Wi-Fi as the camera keep the live picture, sound and alerts — they talk to each other directly (the picture shows “Home Wi-Fi”). Phones away from home, and notifications, come back when the internet does.', tags: 'offline wifi lan outage local network' },
      { q: 'Can someone watch the baby monitor without an account?', a: 'Yes — a parent can make a guest link with a passcode (Watch → People → Create a share link). Guests need both, parents see everyone who joins, and wrong guesses lock the link.', tags: 'guest share link passcode sitter grandparents' },
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
      { q: 'How does sound detection work?', a: 'The camera phone runs an AI sound model (Google’s YAMNet, on the phone itself) plus a pitch-and-rhythm cry analyser and a smoke/CO alarm pattern detector. It recognizes crying, fussing, coughing, alarms, bangs, babbling, laughing, voices, music/TV and dogs — the audio never leaves the phone. Parents can set sensitivity while watching.', tags: 'cry detection ai model cough alarm' },
      { q: 'Talk and video call like FaceTime', a: 'While watching: tap Talk to open your mic (or press and hold to talk while holding). Tap Video to show your face on the nursery phone. Echo cancellation keeps it clear both ways.', tags: 'two-way audio facetime call' },
      { q: 'Alerts when my phone is locked', a: 'Turn on “Alerts on this device” while watching. Android and computers work right away. iPhone: Share → Add to Home Screen, open it from the Home Screen, then turn alerts on.', tags: 'notifications push iphone' },
      { q: 'Camera offline alert', a: 'If the camera phone loses Wi-Fi, runs out of battery or the page is closed, everyone with alerts gets “camera offline” within about a minute.' },
      { q: 'Roles', a: 'Parent: everything incl. managing people. Caregiver: watch, talk, soothe, run a camera, log. Viewer: watch and get alerts. Each person can also have a name like Grandma or Nanny.' },
      { q: 'Soothing sounds', a: 'Soothe plays shush, white noise, rain, ocean or a heartbeat on the camera phone for 15–60 minutes. Sound detection ignores it.' },
      { q: 'Privacy pause', a: 'On the camera phone, Privacy pauses the video for everyone (for example while you change the baby) — sound monitoring and alerts keep running.' },
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

function HelpPanel({ screenTour, initialGuide, onClose }: { screenTour: TourId | null; initialGuide: string | null; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [guideId, setGuideId] = useState<string | null>(initialGuide);
  const needle = q.trim().toLowerCase();
  const guide = GUIDES.find((g) => g.id === guideId) ?? null;
  const guides = useMemo(() => {
    const matches = GUIDES.filter((g) => !needle || `${g.title} ${g.intro} ${g.steps.map((st) => `${st.title} ${st.body}`).join(' ')}`.toLowerCase().includes(needle));
    return screenTour ? [...matches.filter((g) => g.screens.includes(screenTour)), ...matches.filter((g) => !g.screens.includes(screenTour))] : matches;
  }, [needle, screenTour]);
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
          {guide ? (
            <GuideView guide={guide} onBack={() => setGuideId(null)} onAction={(hash) => { onClose(); location.hash = hash; }} />
          ) : (
            <>
          {guides.length > 0 && (
            <section className="help-sect">
              <h3><Icon name="book" size={15} />How-to guides</h3>
              <div className="guide-grid">
                {guides.slice(0, needle ? 10 : 6).map((g) => (
                  <button key={g.id} className={cx('guide-card', screenTour && g.screens.includes(screenTour) && 'rel')} onClick={() => setGuideId(g.id)}>
                    <Icon name={g.icon} size={16} />
                    <span><b>{g.title}</b><small>{g.steps.length} steps · {g.mins} min</small></span>
                  </button>
                ))}
              </div>
              {!needle && GUIDES.length > 6 && (
                <div className="guide-more">
                  {GUIDES.slice(6).filter((g) => !guides.slice(0, 6).includes(g)).map((g) => <button key={g.id} className="linkish" onClick={() => setGuideId(g.id)}>{g.title}</button>)}
                </div>
              )}
            </section>
          )}
          {results.length === 0 && guides.length === 0 && <div className="faint" style={{ padding: 16 }}>No answers for “{q}”. Try other words, or email contact@dreamstream.com.</div>}
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
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function GuideView({ guide, onBack, onAction }: { guide: HowTo; onBack: () => void; onAction: (hash: string) => void }) {
  return (
    <div className="guide-view fade-in">
      <button className="back-link" onClick={onBack}><Icon name="arrowLeft" size={15} />All help</button>
      <div className="guide-title">
        <span className="guide-ic"><Icon name={guide.icon} size={18} /></span>
        <div>
          <h3 className="serif">{guide.title}</h3>
          <small className="faint">{guide.steps.length} steps · about {guide.mins} min</small>
        </div>
      </div>
      <p className="guide-intro">{guide.intro}</p>
      <ol className="guide-steps">
        {guide.steps.map((st, i) => (
          <li key={st.title}>
            <span className="guide-num">{i + 1}</span>
            <div><b>{st.title}</b><p>{st.body}</p></div>
          </li>
        ))}
      </ol>
      {guide.actions && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {guide.actions.map((a) => <Btn key={a.hash} variant="solid" size="sm" icon="arrowRight" onClick={() => onAction(a.hash)}>{a.label}</Btn>)}
        </div>
      )}
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
