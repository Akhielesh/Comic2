/**
 * Deterministic first-session E2E readiness checklist for Stream Studio.
 *
 * `ops:live-smoke:temporary` proves the *plumbing* (Pages shell, live bundle worker
 * base, workers.dev route, CORS, Railway health) without any live writes. It
 * deliberately does NOT create an event or open a browser. This helper picks up
 * where that leaves off: it prints the exact, ordered browser steps a human (or a
 * future Playwright run) walks to prove the full host → viewer → replay loop on
 * the temporary launch path BEFORE inviting beta users.
 *
 * It is pure/deterministic (no network, no clock) so the step contract is
 * unit-tested, and it derives the worker base each host actually targets from the
 * real `live/config.ts` routing — so a checklist for `comic2.pages.dev` cannot
 * silently claim the wrong fallback domain.
 */
import { resolveWorkerBase } from '../../live/config';
import { EXPECTED_LIVE_WORKER_BASE } from './liveSmoke';

/**
 * `temporary-beta` is the current launch wedge: the Cloudflare Pages fallback host
 * (`comic2.pages.dev/live.html`) pointed at the workers.dev live API, used while
 * the custom-domain `/live-api/*` route is still challenged.
 *
 * `canonical` is the eventual production path on the custom domain (same-origin
 * `/live-api`) — listed for contrast so the two are never conflated.
 */
export type ReadinessTrack = 'temporary-beta' | 'canonical';

export interface ReadinessHost {
  track: ReadinessTrack;
  /** Human label for reports/banners. */
  label: string;
  hostname: string;
  /** Stream Studio entry URL for this host. */
  liveUrl: string;
  /** The live-worker base this host's bundle resolves to (derived from live/config). */
  expectedWorkerBase: string;
  /** Prerequisite smoke command that must pass GREEN before these browser steps. */
  smokeCommand: string;
  /** Why this track is or is not the production path yet. */
  note: string;
}

const deriveWorkerBase = (hostname: string): string =>
  resolveWorkerBase(undefined, { hostname, origin: `https://${hostname}` });

export const TEMPORARY_BETA_HOST: ReadinessHost = {
  track: 'temporary-beta',
  label: 'Temporary beta (Pages fallback)',
  hostname: 'comic2.pages.dev',
  liveUrl: 'https://comic2.pages.dev/live.html',
  expectedWorkerBase: deriveWorkerBase('comic2.pages.dev'),
  smokeCommand: 'npm run ops:live-smoke:temporary',
  note:
    'Launch wedge: Pages host points at the workers.dev live API because the custom-domain /live-api/* route is still behind a Cloudflare challenge. Prove THIS path before inviting beta users.',
};

export const CANONICAL_HOST: ReadinessHost = {
  track: 'canonical',
  label: 'Canonical (custom domain)',
  hostname: 'dreamstreamstudio.ai',
  liveUrl: 'https://dreamstreamstudio.ai/live.html',
  expectedWorkerBase: deriveWorkerBase('dreamstreamstudio.ai'),
  smokeCommand: 'npm run ops:live-smoke',
  note:
    'Eventual production path: same-origin /live-api on the custom domain. NOT launch-ready until the Cloudflare challenge on that route is cleared — do not invite users here yet.',
};

export const READINESS_HOSTS: Record<ReadinessTrack, ReadinessHost> = {
  'temporary-beta': TEMPORARY_BETA_HOST,
  canonical: CANONICAL_HOST,
};

export interface E2eStep {
  /** 1-based order. */
  order: number;
  key: string;
  title: string;
  /** What the operator does in the browser. */
  action: string;
  /** What proves the step passed. */
  expect: string;
  /** Concrete URL/path for the step ({eventId}/{hostKey} are filled at run time). */
  url: string;
}

const withEventId = (liveUrl: string): string => `${liveUrl}?e={eventId}`;

/** Mirrors live/nav.ts: new private capability links keep host keys in fragments
 * (`?e=ID#/studio?k=KEY`, `?e=ID#/summary?k=KEY`) so secrets are not sent in the
 * initial Pages/Worker request, CDN logs, or Referer headers. */
const privateHashUrl = (liveUrl: string, screen: 'studio' | 'summary'): string =>
  `${withEventId(liveUrl)}#/${screen}?k={hostKey}`;

/**
 * The ordered first-session loop. Defined as data (not prose) so the step set,
 * order, and per-host URLs are unit-testable and can drive an automated runner.
 * Every step is read-only-from-our-side guidance — the only writes are the live
 * event the human creates in the browser, never by this script.
 */
export function buildStreamE2eChecklist(host: ReadinessHost = TEMPORARY_BETA_HOST): E2eStep[] {
  const live = host.liveUrl;
  const viewer = withEventId(live);
  const studio = privateHashUrl(live, 'studio');
  const summary = privateHashUrl(live, 'summary');

  const steps: Omit<E2eStep, 'order'>[] = [
    {
      key: 'open-live',
      title: 'Open Stream Studio',
      action: `Open ${live} in a fresh browser profile.`,
      expect: `Live app shell loads (no Cloudflare interstitial); bundle resolves the live API to ${host.expectedWorkerBase}.`,
      url: live,
    },
    {
      key: 'create-event',
      title: 'Create event',
      action: 'Use Create to make a new event (title + quality preset).',
      expect: 'Event is created against the live worker (real write); you land on the host studio with a viewer share link.',
      url: `${live}#/create`,
    },
    {
      key: 'open-studio',
      title: 'Open host studio',
      action: 'Confirm the private host studio link opened with camera/mic permission prompt.',
      expect: 'Studio loads with the secret host key in the URL fragment; preview + scene controls render.',
      url: studio,
    },
    {
      key: 'open-viewer',
      title: 'Open viewer link',
      action: 'In a second browser/profile, open the viewer share link (?e= only).',
      expect: 'Viewer page loads the pre-stream lobby; URL has no host key in query or fragment.',
      url: viewer,
    },
    {
      key: 'join-viewer',
      title: 'Join as viewer',
      action: 'Join the event as a viewer from the lobby with only a display name.',
      expect: 'Viewer count increments in the host studio; viewer sees “waiting for stream” or the approval lobby.',
      url: viewer,
    },
    {
      key: 'chat-reaction',
      title: 'Send chat + reaction',
      action: 'From the viewer, send a chat message and an emoji reaction; repeat once from mobile/touch if available.',
      expect: 'Message + reaction appear in the host studio (and other viewers) within a few seconds.',
      url: viewer,
    },
    {
      key: 'start-stream',
      title: 'Start stream',
      action: 'In the host studio, go live and allow camera/mic permissions.',
      expect: 'Status flips to LIVE; segments begin uploading to the live worker; health rail shows upload activity.',
      url: studio,
    },
    {
      key: 'verify-playback',
      title: 'Verify playback',
      action: 'Watch the viewer tab until the first segments arrive.',
      expect: 'Video + audio play within the ~8–15 s designed buffer; no decode/segment errors in console.',
      url: viewer,
    },
    {
      key: 'end-stream',
      title: 'End stream',
      action: 'End the stream from the host studio (or close the studio tab only for the host-gone fallback check).',
      expect: 'Status flips to ended; viewers see the stream stop cleanly and no new segments upload.',
      url: studio,
    },
    {
      key: 'verify-summary-replay',
      title: 'Verify summary + replay',
      action: 'Open the private summary view and re-open the viewer link.',
      expect: 'Summary shows the session; replay is watchable from the same viewer link during the 24 h replay window.',
      url: summary,
    },
  ];

  return steps.map((step, index) => ({ order: index + 1, ...step }));
}

export const STEP_KEYS = [
  'open-live',
  'create-event',
  'open-studio',
  'open-viewer',
  'join-viewer',
  'chat-reaction',
  'start-stream',
  'verify-playback',
  'end-stream',
  'verify-summary-replay',
] as const;

export function parseReadinessTrack(args: string[]): ReadinessTrack {
  if (args.includes('--canonical')) return 'canonical';
  return 'temporary-beta';
}

export function formatChecklist(host: ReadinessHost, steps: E2eStep[]): string {
  const lines: string[] = [];
  lines.push(`Stream Studio first-session E2E readiness — ${host.label}`);
  lines.push(`  Host:     ${host.liveUrl}`);
  lines.push(`  Worker:   ${host.expectedWorkerBase}`);
  lines.push(`  Note:     ${host.note}`);
  lines.push('');
  lines.push(`PREREQUISITE (run first, must be all PASS): ${host.smokeCommand}`);
  if (host.track === 'temporary-beta') {
    lines.push(`  └─ proves the plumbing (Pages shell + live bundle worker base ${EXPECTED_LIVE_WORKER_BASE} + workers.dev route + CORS + Railway health) with no live writes.`);
  }
  lines.push('');
  lines.push('Then walk the browser loop (the ONLY writes are the live event you create in the browser):');
  for (const step of steps) {
    const n = String(step.order).padStart(2, '0');
    lines.push(`  ${n}. ${step.title}`);
    lines.push(`      do:     ${step.action}`);
    lines.push(`      expect: ${step.expect}`);
    lines.push(`      url:    ${step.url}`);
  }
  lines.push('');
  lines.push(
    host.track === 'temporary-beta'
      ? 'GREEN here = temporary beta readiness only. Canonical (custom-domain) readiness still blocked on the Cloudflare /live-api challenge — re-run with --canonical once that clears.'
      : 'GREEN here = canonical custom-domain readiness. This is the eventual production path.'
  );
  return lines.join('\n');
}

const isCliRun = (): boolean => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return /streamE2eChecklist\.(ts|js)$/.test(invoked);
};

if (isCliRun()) {
  const track = parseReadinessTrack(process.argv.slice(2));
  const host = READINESS_HOSTS[track];
  const steps = buildStreamE2eChecklist(host);
  console.log(formatChecklist(host, steps));
}
